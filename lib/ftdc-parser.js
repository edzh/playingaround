'use strict';

const { deserialize } = require('bson');
const zlib = require('zlib');

function readUvarint(buf, pos) {
  let val = 0n, shift = 0n;
  while (true) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return { val, pos };
}

// Read a BSON cstring (null-terminated) starting at pos.
function readCString(buf, pos) {
  let s = '';
  while (buf[pos] !== 0x00) s += String.fromCharCode(buf[pos++]);
  return { s, pos: pos + 1 };
}

// Walk the raw BSON bytes and produce an ordered list of [key, value] pairs
// in the same order MongoDB's FTDC encoder uses (ftdc/util.cpp). This handles:
//   Int32/Int64/Double/Bool/Date → 1 metric
//   Timestamp                   → 2 metrics (.t seconds, .i increment)
//   Document/Array              → recurse
//   Everything else             → skip
//
// Using raw bytes (not deserialize()) preserves duplicate BSON keys — real
// FTDC files occasionally have them (e.g. systemMetrics.mounts with duplicate
// mount entries) and MongoDB's encoder counts every occurrence.
function flattenBsonInOrder(buf, start, end, prefix) {
  const entries = [];
  let p = start + 4; // skip doc length
  while (p < end - 1) {
    const tc = buf[p];
    if (tc === 0x00) break;
    p++;
    const { s: key, pos: afterKey } = readCString(buf, p);
    p = afterKey;
    const fullKey = prefix ? `${prefix}.${key}` : key;

    switch (tc) {
      case 0x01: { // Double (8 bytes LE)
        entries.push([fullKey, buf.readDoubleBE ? buf.readDoubleBE(p) : buf.readDoubleLE(p)]);
        // readDoubleLE is the correct call (IEEE 754 LE)
        entries[entries.length - 1][1] = buf.readDoubleLE(p);
        p += 8;
        break;
      }
      case 0x02: // String — skip
        p += buf.readInt32LE(p) + 4;
        break;
      case 0x03: // Document — recurse
      case 0x04: { // Array — recurse (BSON arrays are documents with numeric string keys)
        const sz = buf.readInt32LE(p);
        entries.push(...flattenBsonInOrder(buf, p, p + sz, fullKey));
        p += sz;
        break;
      }
      case 0x05: // Binary — skip
        p += buf.readInt32LE(p) + 5;
        break;
      case 0x06: // Undefined (deprecated) — skip, no value bytes
        break;
      case 0x07: // ObjectId — MongoDB FTDC skips ObjectIds
        p += 12;
        break;
      case 0x08: // Boolean
        entries.push([fullKey, buf[p] ? 1 : 0]);
        p += 1;
        break;
      case 0x09: { // Date (int64 ms since epoch)
        // Read as two 32-bit halves to avoid float precision loss
        const lo = buf.readUInt32LE(p);
        const hi = buf.readInt32LE(p + 4);
        entries.push([fullKey, hi * 0x100000000 + lo]);
        p += 8;
        break;
      }
      case 0x0A: // Null — skip, no value bytes
        break;
      case 0x0B: // Regex — two cstrings
        while (buf[p] !== 0x00) p++;
        p++;
        while (buf[p] !== 0x00) p++;
        p++;
        break;
      case 0x10: { // Int32
        entries.push([fullKey, buf.readInt32LE(p)]);
        p += 4;
        break;
      }
      case 0x11: { // Timestamp → 2 metrics (seconds, increment) — stored as lo=increment, hi=seconds
        const inc = buf.readUInt32LE(p);
        const sec = buf.readUInt32LE(p + 4);
        entries.push([`${fullKey}.t`, sec]);
        entries.push([`${fullKey}.i`, inc]);
        p += 8;
        break;
      }
      case 0x12: { // Int64 — read as two 32-bit halves
        const lo = buf.readUInt32LE(p);
        const hi = buf.readInt32LE(p + 4);
        entries.push([fullKey, hi * 0x100000000 + lo]);
        p += 8;
        break;
      }
      case 0x13: // Decimal128 — skip
        p += 16;
        break;
      default: // Unknown type — skip would desync; stop parsing this doc
        return entries;
    }
  }
  return entries;
}

// flattenDocInOrder is kept for unit tests (operates on a deserialized BSON
// object). Real chunk decoding uses flattenBsonInOrder over raw bytes instead.
function flattenDocInOrder(doc, prefix = '') {
  const entries = [];
  for (const [k, v] of Object.entries(doc)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    const bt = v._bsontype;
    if (typeof v === 'number') {
      entries.push([key, v]);
    } else if (typeof v === 'boolean') {
      entries.push([key, v ? 1 : 0]);
    } else if (v instanceof Date) {
      entries.push([key, v.getTime()]);
    } else if (bt === 'Timestamp') {
      entries.push([`${key}.t`, v.high >>> 0]);
      entries.push([`${key}.i`, v.low >>> 0]);
    } else if (bt === 'Long') {
      entries.push([key, v.toNumber()]);
    } else if (bt === 'Double' || bt === 'Int32') {
      entries.push([key, v.valueOf()]);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        entries.push(...flattenDocInOrder({ [i]: v[i] }, key));
      }
    } else if (typeof v === 'object' && !bt && !Buffer.isBuffer(v)) {
      entries.push(...flattenDocInOrder(v, key));
    }
  }
  return entries;
}

function* iterateChunks(buffer) {
  let pos = 0;
  while (pos + 4 <= buffer.length) {
    const docSize = buffer.readInt32LE(pos);
    if (docSize < 5 || pos + docSize > buffer.length) break;
    yield { doc: deserialize(buffer.slice(pos, pos + docSize), { promoteValues: false }), offset: pos, raw: buffer, rawOffset: pos };
    pos += docSize;
  }
}

function inflatePayload(bin) {
  const buf = Buffer.from(bin.buffer);
  try {
    return zlib.inflateSync(buf.slice(4));
  } catch (_) {
    return zlib.inflateSync(buf); // synthetic payloads without length prefix
  }
}

function decodeMetricChunk(chunkDoc, keep) {
  const bin = chunkDoc.data || chunkDoc.doc;
  if (!bin || !bin.buffer) return { frames: [], keys: [] };

  const decompressed = inflatePayload(bin);

  const refLen = decompressed.readInt32LE(0);
  // Use raw BSON walker to match MongoDB's encoder order exactly (handles
  // duplicate keys, correct Timestamp byte order, no type promotions).
  const refEntries = flattenBsonInOrder(decompressed, 0, refLen, '');
  const keys = refEntries.map(([k]) => k);

  const nMetrics = decompressed.readUInt32LE(refLen);
  const nSamples = decompressed.readUInt32LE(refLen + 4);

  if (nMetrics !== refEntries.length) {
    // Mismatch means the stream will desync — skip this chunk rather than
    // decode wrong data. Log to aid debugging.
    // eslint-disable-next-line no-console
    console.warn(`[ftdc] metric count mismatch: chunk says ${nMetrics}, raw walker got ${refEntries.length} — skipping chunk`);
    return { frames: [], keys: [] };
  }

  const baseTime = chunkDoc._id instanceof Date ? chunkDoc._id.getTime() : Number(chunkDoc._id);
  const startIdx = keys.indexOf('start');

  const kept = keep ? refEntries.map(([k]) => keep(k)) : null;

  const frames = new Array(nSamples + 1);
  const refMetrics = {};
  for (let m = 0; m < refEntries.length; m++) {
    if (!kept || kept[m]) refMetrics[refEntries[m][0]] = refEntries[m][1];
  }
  frames[0] = { t: startIdx >= 0 ? refEntries[startIdx][1] : baseTime, metrics: refMetrics };
  for (let s = 1; s <= nSamples; s++) {
    frames[s] = { t: baseTime + s * 1000, metrics: {} };
  }

  let pos = refLen + 8;
  let zeroRun = 0;
  let acc = 0n;

  for (let m = 0; m < nMetrics; m++) {
    const key = refEntries[m][0];
    const store = !kept || kept[m];
    acc = BigInt(Math.round(refEntries[m][1]));
    for (let s = 0; s < nSamples; s++) {
      let delta;
      if (zeroRun > 0) {
        zeroRun--;
        delta = 0n;
      } else {
        const r = readUvarint(decompressed, pos);
        pos = r.pos;
        delta = BigInt.asIntN(64, r.val);
        if (delta === 0n) {
          const rz = readUvarint(decompressed, pos);
          pos = rz.pos;
          zeroRun = Number(rz.val);
        }
      }
      acc = BigInt.asIntN(64, acc + delta);
      const num = Number(acc);
      if (store) frames[s + 1].metrics[key] = num;
      if (m === startIdx) frames[s + 1].t = num;
    }
  }

  return { frames, keys };
}

async function parseFile(buffer, opts = {}) {
  const keep = opts.keep || null;
  const allFrames = [];
  let metricKeys = null;

  for (const { doc: chunkDoc } of iterateChunks(buffer)) {
    const type = typeof chunkDoc.type === 'object' ? chunkDoc.type.valueOf() : chunkDoc.type;
    if (type !== 1) continue;
    try {
      const { frames, keys } = decodeMetricChunk(chunkDoc, keep);
      if (frames.length > 0) {
        if (!metricKeys) metricKeys = keys;
        allFrames.push(...frames);
      }
    } catch (_) { /* skip bad metric chunks */ }
  }

  allFrames.sort((a, b) => a.t - b.t);
  return { frames: allFrames, metricKeys: metricKeys || [] };
}

module.exports = { parseFile, flattenDocInOrder, readUvarint };
