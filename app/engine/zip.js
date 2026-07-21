// zip.js — minimal ZIP support, dependency-free; works in browser and
// node. makeZip is a store-only writer (the qbj-bundle download); readZip
// reads store + deflate entries (the packet-zip upload).

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

async function inflateRaw(raw) {
  const ds = new DecompressionStream('deflate-raw');
  const res = new Response(new Blob([raw]).stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Read a zip made by any normal tool. Walks the central directory (so
 * data-descriptor entries work), skips directory entries, supports store
 * and deflate. No zip64 — fine for packet zips.
 * @param bytes Uint8Array of the whole zip
 * @returns Promise<[{name, data: Uint8Array}]>
 */
export async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // EOCD is at the end, pushed back by an optional comment (<= 64K)
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = dv.getUint16(pos + 10, true);
    const csize = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localOff = dv.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // the local header's own name/extra lengths position the data
    const start = localOff + 30
      + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else throw new Error(name + ': unsupported zip compression method ' + method);
  }
  return out;
}
