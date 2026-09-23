'use strict';

const fs = require('fs');

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

function utf8Len(byte) {
  if (byte < 0x80) return 1;
  if (byte >= 0xf0) return 4;
  if (byte >= 0xe0) return 3;
  if (byte >= 0xc0) return 2;
  return 1;
}

function modifiers(param) {
  const mod = Number(param) - 1;
  if (!Number.isFinite(mod) || mod <= 0) return {};
  return {
    shift: !!(mod & 1),
    meta: !!(mod & 2),
    ctrl: !!(mod & 4),
  };
}

const CSI_LETTERS = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab',
};
const CSI_TILDE = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
};

// Blocking, synchronous key reader. The shell's builtins run synchronously, so
// a full-screen editor cannot use Node's event-driven keypress stream.
class KeyReader {
  constructor(fd = 0) {
    this.fd = fd;
    this.buf = Buffer.alloc(0);
    this.chunk = Buffer.alloc(4096);
    this.eof = false;
  }

  fill() {
    for (;;) {
      let n;
      try {
        n = fs.readSync(this.fd, this.chunk, 0, this.chunk.length, null);
      } catch (e) {
        if (e.code === 'EAGAIN') { sleepSync(4); continue; }
        if (e.code === 'EOF') { this.eof = true; return 0; }
        throw e;
      }
      if (n > 0) {
        this.buf = Buffer.concat([this.buf, this.chunk.subarray(0, n)]);
        return n;
      }
      this.eof = true;
      return 0;
    }
  }

  consume(n) { this.buf = this.buf.subarray(n); }

  next() {
    if (!this.buf.length) {
      this.fill();
      if (!this.buf.length) return { name: 'eof' };
    }
    return this.parse();
  }

  parse() {
    const b = this.buf;
    const c = b[0];

    if (c === 0x1b) {
      if (b.length === 1) {
        // A lone ESC; give the rest of a sequence a moment to arrive.
        this.fill();
        if (this.buf.length === 1) { this.consume(1); return { name: 'escape' }; }
        return this.parse();
      }

      const s = this.buf.toString('utf8');

      let m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s);
      if (m) {
        this.consume(m[0].length);
        const params = m[1].split(';');
        const mods = modifiers(params[1]);
        if (m[2] === '~') {
          const name = CSI_TILDE[Number(params[0])] || 'unknown';
          return { name, ...mods };
        }
        const name = CSI_LETTERS[m[2]] || 'unknown';
        if (m[2] === 'Z') return { name: 'tab', shift: true };
        return { name, ...mods };
      }

      m = /^\x1bO([A-Za-z])/.exec(s);
      if (m) {
        this.consume(m[0].length);
        return { name: CSI_LETTERS[m[1]] || 'unknown' };
      }

      this.consume(1);
      const inner = this.next();
      return { ...inner, meta: true };
    }

    if (c === 0x7f) { this.consume(1); return { name: 'backspace' }; }
    if (c === 0x0d || c === 0x0a) { this.consume(1); return { name: 'return' }; }
    if (c === 0x09) { this.consume(1); return { name: 'tab' }; }
    if (c === 0x1f) { this.consume(1); return { name: '_', ctrl: true }; }
    if (c < 0x20) {
      this.consume(1);
      return { name: String.fromCharCode(c + 96), ctrl: true };
    }

    const len = Math.min(utf8Len(c), b.length);
    const str = b.subarray(0, len).toString('utf8');
    this.consume(len);
    return { name: str, str, printable: true };
  }
}

module.exports = { KeyReader, sleepSync };
