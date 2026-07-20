// zip.js — minimal store-only (no compression) ZIP writer, for the
// qbj-bundle download. Dependency-free; works in browser and node.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date(2026, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param entries [{name, data}] — data is Uint8Array or string (UTF-8'd)
 * @param date optional Date stamped on all entries
 * @returns Uint8Array of the zip file
 */
export function makeZip(entries, date) {
  const enc = new TextEncoder();
  const { time, date: ddate } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);        // version needed
    local.setUint16(6, 0x0800, true);    // UTF-8 names
    local.setUint16(8, 0, true);         // store
    local.setUint16(10, time, true);
    local.setUint16(12, ddate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameB.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameB, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, ddate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true);
    cen.setUint32(42, offset, true);     // local header offset
    centrals.push(new Uint8Array(cen.buffer), nameB);

    offset += 30 + nameB.length + data.length;
  }

  const cenSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cenSize, true);
  eocd.setUint32(16, offset, true);

  const total = offset + cenSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of [...locals, ...centrals, new Uint8Array(eocd.buffer)]) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}
