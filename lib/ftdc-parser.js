'use strict';

const { deserialize, Long } = require('bson');
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

const zigzag = n => (n >> 1n) ^ -(n & 1n);

function flattenDocInOrder(doc, prefix = '') {
  const entries = [];
  for (const [k, v] of Object.entries(doc)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (v instanceof Long) {
      entries.push([key, v.toNumber()]);
    } else if (typeof v === 'number') {
      entries.push([key, v]);
    } else if (typeof v === 'boolean') {
      entries.push([key, v ? 1 : 0]);
    } else if (typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) && !Array.isArray(v) && v.constructor === Object) {
      entries.push(...flattenDocInOrder(v, key));
    }
    // Skip: strings, Dates, Buffers, Arrays, BSON Binary, etc.
  }
  return entries;
}

function* iterateChunks(buffer) {
  let pos = 0;
  while (pos + 4 <= buffer.length) {
    const docSize = buffer.readInt32LE(pos);
    if (docSize < 5 || pos + docSize > buffer.length) break;
    yield { doc: deserialize(buffer.slice(pos, pos + docSize), { promoteValues: false }), offset: pos };
    pos += docSize;
  }
}

function decodeMetricChunk(chunkDoc) {
  const compressed = chunkDoc.doc;
  if (!compressed || !compressed.buffer) return [];

  const decompressed = zlib.inflateSync(Buffer.from(compressed.buffer));

  const refLen = decompressed.readInt32LE(0);
  const refDoc = deserialize(decompressed.slice(0, refLen), { promoteValues: false });
  const refEntries = flattenDocInOrder(refDoc);

  const nMetrics = decompressed.readUInt32LE(refLen);
  const nSamples = decompressed.readUInt32LE(refLen + 4);

  const baseTime = chunkDoc._id instanceof Date ? chunkDoc._id.getTime() : Number(chunkDoc._id);

  const frames = new Array(nSamples + 1);
  const refMetrics = {};
  for (const [k, v] of refEntries) refMetrics[k] = v;
  frames[0] = { t: baseTime, metrics: refMetrics };
  for (let s = 1; s <= nSamples; s++) {
    frames[s] = { t: baseTime + s * 1000, metrics: {} };
  }

  const acc = refEntries.map(([, v]) => BigInt(Math.round(v)));
  let pos = refLen + 8;

  for (let m = 0; m < nMetrics && m < refEntries.length; m++) {
    const key = refEntries[m][0];
    for (let s = 0; s < nSamples; s++) {
      const { val, pos: next } = readUvarint(decompressed, pos);
      pos = next;
      acc[m] += zigzag(val);
      frames[s + 1].metrics[key] = Number(acc[m]);
    }
  }

  return frames;
}

async function parseFile(buffer) {
  const allFrames = [];
  let metricKeys = null;

  for (const { doc: chunkDoc } of iterateChunks(buffer)) {
    const type = typeof chunkDoc.type === 'object' ? chunkDoc.type.valueOf() : chunkDoc.type;

    if (type === 0) {
      // Metadata chunk — establishes key order
      try {
        const compressed = chunkDoc.doc;
        if (compressed && compressed.buffer) {
          const decompressed = zlib.inflateSync(Buffer.from(compressed.buffer));
          const doc = deserialize(decompressed, { promoteValues: false });
          const entries = flattenDocInOrder(doc);
          if (!metricKeys) metricKeys = entries.map(([k]) => k);
        }
      } catch (_) { /* skip bad metadata chunks */ }
    } else if (type === 1) {
      try {
        const frames = decodeMetricChunk(chunkDoc);
        if (frames.length > 0) {
          if (!metricKeys) metricKeys = Object.keys(frames[0].metrics);
          allFrames.push(...frames);
        }
      } catch (_) { /* skip bad metric chunks */ }
    }
  }

  // Sort by time (chunks should already be in order, but be safe)
  allFrames.sort((a, b) => a.t - b.t);

  return { frames: allFrames, metricKeys: metricKeys || [] };
}

module.exports = { parseFile, flattenDocInOrder, readUvarint, zigzag };
