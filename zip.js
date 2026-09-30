/* Minimal ZIP writer using STORE (no compression). Suitable for local extension exports. */
(() => {
  'use strict';
  const encoder = new TextEncoder();

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (typeof data === 'string') {
      return encoder.encode(data);
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError('Unsupported ZIP entry data type');
  }

  function dosDateTime(date = new Date()) {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    const time =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f);
    const day =
      ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { time, day };
  }

  function set16(view, offset, value) {
    view.setUint16(offset, value, true);
  }
  function set32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  class SimpleZip {
    constructor() {
      this.entries = [];
    }

    add(name, data, date = new Date()) {
      const filename = String(name);
      // eslint-disable-next-line no-control-regex -- ZIP entries must not contain NUL.
      if (!filename || /[\\/\u0000]/.test(filename) || filename === '.' || filename === '..') {
        throw new Error('ZIP entry must be a safe, flat filename.');
      }
      if (this.entries.some((entry) => entry.filename === filename)) {
        throw new Error('Duplicate ZIP filename.');
      }
      const nameBytes = encoder.encode(filename);
      const bytes = toBytes(data);
      if (nameBytes.length > 65535 || bytes.length > 0xffffffff || this.entries.length >= 65535) {
        throw new Error('ZIP64 archives are not supported.');
      }
      if (!Number.isFinite(date.getTime())) {
        throw new Error('Invalid ZIP date.');
      }
      this.entries.push({ filename, nameBytes, bytes, date, crc: crc32(bytes) });
    }

    blob() {
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const entry of this.entries) {
        const { time, day } = dosDateTime(entry.date);
        const local = new Uint8Array(30 + entry.nameBytes.length);
        const lv = new DataView(local.buffer);
        set32(lv, 0, 0x04034b50);
        set16(lv, 4, 20);
        set16(lv, 6, 0x0800); // UTF-8 filename
        set16(lv, 8, 0); // STORE
        set16(lv, 10, time);
        set16(lv, 12, day);
        set32(lv, 14, entry.crc);
        set32(lv, 18, entry.bytes.length);
        set32(lv, 22, entry.bytes.length);
        set16(lv, 26, entry.nameBytes.length);
        set16(lv, 28, 0);
        local.set(entry.nameBytes, 30);

        localParts.push(local, entry.bytes);

        const central = new Uint8Array(46 + entry.nameBytes.length);
        const cv = new DataView(central.buffer);
        set32(cv, 0, 0x02014b50);
        set16(cv, 4, 20);
        set16(cv, 6, 20);
        set16(cv, 8, 0x0800);
        set16(cv, 10, 0);
        set16(cv, 12, time);
        set16(cv, 14, day);
        set32(cv, 16, entry.crc);
        set32(cv, 20, entry.bytes.length);
        set32(cv, 24, entry.bytes.length);
        set16(cv, 28, entry.nameBytes.length);
        set16(cv, 30, 0);
        set16(cv, 32, 0);
        set16(cv, 34, 0);
        set16(cv, 36, 0);
        set32(cv, 38, 0);
        set32(cv, 42, offset);
        central.set(entry.nameBytes, 46);
        centralParts.push(central);

        offset += local.length + entry.bytes.length;
      }

      const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
      const centralOffset = offset;
      if (centralOffset + centralSize > 0xffffffff) {
        throw new Error('ZIP64 archives are not supported.');
      }
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      set32(ev, 0, 0x06054b50);
      set16(ev, 4, 0);
      set16(ev, 6, 0);
      set16(ev, 8, this.entries.length);
      set16(ev, 10, this.entries.length);
      set32(ev, 12, centralSize);
      set32(ev, 16, centralOffset);
      set16(ev, 20, 0);

      return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    }
  }

  globalThis.SimpleZip = SimpleZip;
})();
