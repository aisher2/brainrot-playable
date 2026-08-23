/* ============================================================
   ws.js - a minimal RFC 6455 WebSocket server.

   Zero dependencies on purpose: `node server/server.js` runs the
   whole game with nothing installed. It handles exactly what the
   relay needs - text frames, ping/pong, close, and fragmentation -
   and rejects anything oversized.
   ============================================================ */

'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

/* RFC 6455 magic string. Verified against the spec's published vector:
   key 'dGhlIHNhbXBsZSBub25jZQ==' must yield 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='.
   Getting this wrong is invisible to a test client that shares the mistake -
   every strict client (browsers, CDNs) silently refuses the connection.
   tools/check.mjs pins it to that external vector. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;          // 1 MB hard ceiling per message

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.isAlive = true;
    /* Proxies (Render/Cloudflare) parse the 101 and only then switch the
       connection into tunnel mode. Frames written in the same tick land in
       the same TCP segment as the handshake and can be swallowed, so hold
       anything the app sends until the handshake has flushed on its own. */
    this._corked = true;
    this._pending = [];
    setImmediate(() => {
      this._corked = false;
      const q = this._pending;
      this._pending = [];
      for (const b of q) { if (this.open) { try { this.socket.write(b); } catch (_) { /* gone */ } } }
    });
    this.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || socket.remoteAddress || '?';

    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._closed());
    socket.on('timeout', () => this.destroy());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _data(chunk) {
    if (!this.open) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_FRAME * 2) return this.destroy();
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) { this.destroy(); return null; }
      len = lo; off += 8;
    }
    if (len > MAX_FRAME) { this.destroy(); return null; }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, op, payload };
  }

  _handleFrame(f) {
    switch (f.op) {
      case OP.PING: this._frame(OP.PONG, f.payload); break;
      case OP.PONG: this.isAlive = true; break;
      case OP.CLOSE: this.close(1000); break;
      case OP.CONT:
        if (!this.frag) return this.destroy();
        this.frag = Buffer.concat([this.frag, f.payload]);
        if (this.frag.length > MAX_FRAME) return this.destroy();
        if (f.fin) { this._deliver(this.fragOp, this.frag); this.frag = null; }
        break;
      case OP.TEXT:
      case OP.BIN:
        if (!f.fin) { this.frag = f.payload; this.fragOp = f.op; return; }
        this._deliver(f.op, f.payload);
        break;
      default: this.destroy();
    }
  }

  _deliver(op, payload) {
    this.isAlive = true;
    if (op === OP.TEXT) this.emit('message', payload.toString('utf8'));
    // binary frames are not used by this protocol; ignore them
  }

  _frame(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | op;
    const buf = Buffer.concat([head, payload]);
    if (this._corked) { this._pending.push(buf); return; }
    try { this.socket.write(buf); } catch (_) { this.destroy(); }
  }

  send(str) { this._frame(OP.TEXT, Buffer.from(String(str), 'utf8')); }
  ping() { this.isAlive = false; this._frame(OP.PING, Buffer.alloc(0)); }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(OP.CLOSE, p);
    this.open = false;
    setTimeout(() => this.destroy(), 60);
    this.emit('close');
  }

  destroy() {
    this.open = false;
    try { this.socket.destroy(); } catch (_) {}
  }
}

/**
 * Attach a WebSocket endpoint to an http.Server.
 * @param server  node http server
 * @param path    only upgrade requests to this path are accepted
 * @param onConn  (conn) => void
 */
function attach(server, path, onConn) {
  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '/').split('?')[0];
    // Not our path: leave it for any other upgrade handler. Destroying the
    // socket here would break a second WebSocket endpoint on the same server.
    if (url !== path) return;
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new WSConnection(socket, req);
    if (head && head.length) conn._data(head);
    onConn(conn);
  });
}

module.exports = { attach, WSConnection };
