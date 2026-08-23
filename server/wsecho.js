/* ============================================================
   wsecho.js - TEMPORARY diagnostic.

   A completely independent, textbook WebSocket echo on /wsecho. It shares
   no code with ws.js, so comparing the two through a host's proxy tells us
   whether a failure is our relay implementation or the platform in front
   of it. Delete once the question is settled.
   ============================================================ */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

function attachEcho(server, path = '/wsecho') {
  server.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== path) return;
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    // one hello frame, then echo whatever arrives
    setImmediate(() => {
      try { socket.write(frame(0x1, Buffer.from('echo-hello', 'utf8'))); } catch (_) { /* gone */ }
    });

    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        if (op === 0x8) { try { socket.end(frame(0x8, Buffer.alloc(0))); } catch (_) {} return; }
        if (op === 0x9) { try { socket.write(frame(0xa, payload)); } catch (_) {} continue; }
        if (op === 0x1) { try { socket.write(frame(0x1, Buffer.concat([Buffer.from('echo:'), payload]))); } catch (_) {} }
      }
    });
    socket.on('error', () => { try { socket.destroy(); } catch (_) {} });
  });
}

module.exports = { attachEcho };
