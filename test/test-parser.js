'use strict';

// Synthetic FTDC buffer unit test — real on-disk FTDC format:
//   outer doc: { _id: Date, type: 1, data: Binary }
//   data     : uint32le uncompressedLength + zlib stream
//   payload  : refDoc BSON + uint32 nMetrics + uint32 nSamples + varint deltas
//   deltas   : raw uint64 wraparound (NO zigzag), zeros run-length encoded
//              (varint 0 followed by varint count of ADDITIONAL zeros)

const assert = require('assert');
const zlib   = require('zlib');
const { serialize, deserialize, Double, Int32, Binary, Timestamp } = require('bson');
const { parseFile, flattenDocInOrder, readUvarint } = require('../lib/ftdc-parser');

// ── Helpers ────────────────────────────────────────────────────────────────

function ok(label) { console.log(`  ✓ ${label}`); }

function check(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  ok(label);
}

function uvarint(v) {
  // encode BigInt as unsigned LEB128
  v = BigInt.asUintN(64, v);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

// ── readUvarint ────────────────────────────────────────────────────────────

console.log('readUvarint:');
{
  const { val, pos } = readUvarint(Buffer.from([0x00]), 0);
  check('0 val', val, 0n); check('0 pos', pos, 1);
}
{
  const { val, pos } = readUvarint(Buffer.from([0xC8, 0x01]), 0);
  check('200 val', val, 200n); check('200 pos', pos, 2);
}
{
  // -5 as uint64 wraparound → 10-byte varint
  const enc = uvarint(-5n);
  check('-5 encodes to 10 bytes', enc.length, 10);
  const { val } = readUvarint(enc, 0);
  check('-5 roundtrip', BigInt.asIntN(64, val), -5n);
}

// ── flattenDocInOrder ──────────────────────────────────────────────────────

console.log('\nflattenDocInOrder:');
{
  const raw = deserialize(
    serialize({ z: new Double(1), a: new Double(2), m: new Double(3) }),
    { promoteValues: false }
  );
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries.map(([k]) => k), ['z', 'a', 'm'], 'key order preserved');
  ok('key order: z, a, m (not sorted)');
  assert.deepStrictEqual(entries.map(([, v]) => v), [1, 2, 3]);
  ok('Double values extracted');
}
{
  const raw = deserialize(serialize({ x: { y: new Double(7) } }), { promoteValues: false });
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries, [['x.y', 7]]);
  ok('nested doc flattened with dot notation');
}
{
  // FTDC metric extraction rules: Date = 1 metric (ms), Timestamp = 2 metrics
  // (t then i), bool = 1, strings skipped, arrays recursed by index.
  const T = 1700000000000;
  const raw = deserialize(
    serialize({
      s:  'hello',
      n:  new Double(42),
      d:  new Date(T),
      ts: new Timestamp({ t: 99, i: 3 }),
      b:  true,
      arr: [new Double(5), new Double(6)],
    }),
    { promoteValues: false }
  );
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries, [
    ['n', 42],
    ['d', T],
    ['ts.t', 99],
    ['ts.i', 3],
    ['b', 1],
    ['arr.0', 5],
    ['arr.1', 6],
  ]);
  ok('Date→ms, Timestamp→t+i, bool→1, array→indexed, string skipped');
}

// ── Synthetic FTDC buffer (real format) ────────────────────────────────────
//
// Metrics: start=T0  a=100  b=200  c=300  (reference, frame 0)
// Deltas (column-major):
//   start: +1000, +1000 → frames 1,2: T0+1000, T0+2000
//   a:     +10,   +10   → frames 1,2: 110, 120
//   b:     -5,    +15   → frames 1,2: 195, 210
//   c:      0,    +100  → frames 1,2: 300, 400
//
// -5 is uint64 wraparound (no zigzag). The single 0 delta is RLE'd as
// varint(0) + varint(0 additional zeros).

console.log('\nparseFile (synthetic real-format type-1 chunk):');

const T0 = 1700000000000; // fixed epoch ms

const refBson = serialize({
  start: new Date(T0),
  a: new Double(100),
  b: new Double(200),
  c: new Double(300),
});

const varints = Buffer.concat([
  uvarint(1000n), uvarint(1000n),       // start deltas
  uvarint(10n),   uvarint(10n),         // a deltas
  uvarint(-5n),   uvarint(15n),         // b deltas (wraparound negative)
  uvarint(0n),    uvarint(0n),          // c: zero + RLE count 0
  uvarint(100n),                        // c: +100
]);

const payload = Buffer.alloc(refBson.length + 8 + varints.length);
refBson.copy(payload, 0);
payload.writeUInt32LE(4, refBson.length);     // nMetrics = 4
payload.writeUInt32LE(2, refBson.length + 4); // nSamples = 2
varints.copy(payload, refBson.length + 8);

const compressed = zlib.deflateSync(payload);
const data = Buffer.alloc(4 + compressed.length);
data.writeUInt32LE(payload.length, 0);        // uncompressed-length prefix
compressed.copy(data, 4);

const ftdcBuf = serialize({
  _id:  new Date(T0),
  type: new Int32(1),
  data: new Binary(data),
});

async function run() {
  const { frames, metricKeys } = await parseFile(ftdcBuf);

  check('frame count', frames.length, 3);
  assert.deepStrictEqual(metricKeys, ['start', 'a', 'b', 'c']);
  ok('metricKeys order: start, a, b, c');

  // Frame 0 — reference; t comes from the decoded 'start' metric
  check('f0.t',  frames[0].t, T0);
  check('f0.a',  frames[0].metrics.a, 100);
  check('f0.b',  frames[0].metrics.b, 200);
  check('f0.c',  frames[0].metrics.c, 300);

  // Frame 1 — first delta
  check('f1.t',  frames[1].t, T0 + 1000);
  check('f1.a',  frames[1].metrics.a, 110);
  check('f1.b',  frames[1].metrics.b, 195);
  check('f1.c',  frames[1].metrics.c, 300);

  // Frame 2 — second delta
  check('f2.t',  frames[2].t, T0 + 2000);
  check('f2.a',  frames[2].metrics.a, 120);
  check('f2.b',  frames[2].metrics.b, 210);
  check('f2.c',  frames[2].metrics.c, 400);

  // keep predicate filters stored metrics
  const filtered = await parseFile(ftdcBuf, { keep: k => k === 'b' });
  assert.deepStrictEqual(Object.keys(filtered.frames[1].metrics), ['b']);
  ok('keep predicate limits stored metrics');
  check('filtered f1.t still from start', filtered.frames[1].t, T0 + 1000);

  console.log('\nAll tests passed.');
}

run().catch(err => { console.error('\nFAIL:', err.message); process.exit(1); });
