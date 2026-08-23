/* ============================================================
   wsclient.mjs - a minimal WebSocket *client* for Node, shaped like
   the browser API so `src/net/transport.js` can be tested unchanged.

   Node 24's built-in WebSocket refuses this (and other) handshakes in
   this environment, so the test supplies its own client rather than
   weakening the server to suit one runtime. Test-only: the shipped
   game always uses the browser's native WebSocket.
   ============================================================ */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export class NodeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.buf = Buffer.alloc(0);
    this._frag = null;

    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    let handshook = false;

    // wss:// needs TLS, and hosts like Render route by SNI - without
    // servername the handshake lands on the wrong vhost.
    const secure = u.protocol === 'wss:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const onReady = () => {
      this.sock.write(
        `GET ${u.pathname || '/'} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    };
    this.sock = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname,
        ALPNProtocols: ['http/1.1'] }, onReady)
      : net.connect(port, u.hostname, onReady);
    this.sock.setNoDelay(true);

    this.sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!handshook) {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = this.buf.subarray(0, end).toString('latin1');
        this.buf = this.buf.subarray(end + 4);
        const okStatus = /^HTTP\/1\.1 101/.test(head);
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        if (!okStatus || accept !== expect) {
          this._fail(new Error('handshake rejected: ' + head.split('\r\n')[0]));
          return;
        }
        handshook = true;
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
      }
      this._drain();
    });

    this.sock.on('error', (e) => this._fail(e));
    this.sock.on('close', () => {
      const was = this.readyState;
      this.readyState = 3;
      if (was !== 3) this.onclose?.({ type: 'close', code: 1006, reason: '' });
    });
  }

  _fail(err) {
    if (this.readyState === 3) return;
    this.onerror?.({ type: 'error', message: err.message, error: err });
    this.readyState = 3;
    try { this.sock.destroy(); } catch (_) {}
    this.onclose?.({ type: 'close', code: 1006, reason: err.message });
  }

  _drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);

      if (op === OP.PING) { this._frame(OP.PONG, payload); continue; }
      if (op === OP.PONG) continue;
      if (op === OP.CLOSE) { this.close(); return; }
      if (op === OP.CONT) {
        this._frag = this._frag ? Buffer.concat([this._frag, payload]) : payload;
        if (fin) { const f = this._frag; this._frag = null; this.onmessage?.({ data: f.toString('utf8') }); }
        continue;
      }
      if (!fin) { this._frag = payload; continue; }
      if (op === OP.TEXT) this.onmessage?.({ data: payload.toString('utf8') });
    }
  }

  _frame(op, payload) {
    if (this.readyState !== 1 || this.sock.destroyed) return;
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try { this.sock.write(Buffer.concat([head, mask, masked])); } catch (_) { /* dropped */ }
  }

  send(str) { this._frame(OP.TEXT, Buffer.from(String(str), 'utf8')); }

  close() {
    if (this.readyState === 3) return;
    if (this.readyState === 1) this._frame(OP.CLOSE, Buffer.alloc(0));
    this.readyState = 3;
    setTimeout(() => { try { this.sock.destroy(); } catch (_) {} }, 30);
    this.onclose?.({ type: 'close', code: 1000, reason: '' });
  }
}

/** Install as the global so browser code runs unmodified. */
export function installWebSocket() {
  globalThis.WebSocket = NodeWebSocket;
}
