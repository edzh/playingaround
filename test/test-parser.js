'use strict';

// Synthetic FTDC buffer unit test.
// Builds a known 3-metric / 2-sample type-1 chunk in memory,
// calls parseFile(), and asserts every decoded value.

const assert = require('assert');
const zlib   = require('zlib');
const { serialize, deserialize, Double, Int32, Binary } = require('bson');
const { parseFile, flattenDocInOrder, readUvarint, zigzag } = require('../lib/ftdc-parser');

// ── Helpers ────────────────────────────────────────────────────────────────

function ok(label) { console.log(`  ✓ ${label}`); }

function check(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  ok(label);
}

// ── zigzag decode ──────────────────────────────────────────────────────────

console.log('zigzag:');
const ZZ = [[0n,0n],[2n,1n],[1n,-1n],[20n,10n],[9n,-5n],[30n,15n],[200n,100n]];
for (const [enc, dec] of ZZ) {
  assert.strictEqual(zigzag(enc), dec, `zigzag(${enc})=${dec}`);
  ok(`zigzag(${enc}) → ${dec}`);
}

// ── readUvarint ────────────────────────────────────────────────────────────

console.log('\nreadUvarint:');
{
  const { val, pos } = readUvarint(Buffer.from([0x00]), 0);
  check('0 val', val, 0n); check('0 pos', pos, 1);
}
{
  const { val, pos } = readUvarint(Buffer.from([0x14]), 0);
  check('20 val', val, 20n); check('20 pos', pos, 1);
}
{
  const { val, pos } = readUvarint(Buffer.from([0xC8, 0x01]), 0);
  check('200 val', val, 200n); check('200 pos', pos, 2);
}
{
  // 128 = 0x80 → [0x80, 0x01]
  const { val } = readUvarint(Buffer.from([0x80, 0x01]), 0);
  check('128 val', val, 128n);
}

// ── flattenDocInOrder ──────────────────────────────────────────────────────

console.log('\nflattenDocInOrder:');
{
  // flattenDocInOrder operates on deserialized BSON where Double → plain JS number.
  // Use deserialize() to mirror what decodeMetricChunk passes in.
  const raw = deserialize(
    serialize({ z: new Double(1), a: new Double(2), m: new Double(3) }),
    { promoteValues: false }
  );
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries.map(([k]) => k), ['z', 'a', 'm'], 'key order preserved');
  ok('key order: z, a, m (not sorted)');
  assert.deepStrictEqual(entries.map(([, v]) => v), [1, 2, 3]);
  ok('Double values promoted to plain number by deserialize');
}
{
  // Nested doc flattening
  const raw = deserialize(serialize({ x: { y: new Double(7) } }), { promoteValues: false });
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries, [['x.y', 7]]);
  ok('nested doc flattened with dot notation');
}
{
  // Strings, dates, buffers skipped; plain JS number (Double roundtrip) kept
  const raw = deserialize(
    serialize({ s: 'hello', n: new Double(42), d: new Date() }),
    { promoteValues: false }
  );
  const entries = flattenDocInOrder(raw);
  assert.deepStrictEqual(entries, [['n', 42]]);
  ok('strings/dates skipped, Double kept');
}

// ── Synthetic FTDC buffer ──────────────────────────────────────────────────
//
// Metrics: a=100  b=200  c=300  (reference, frame 0)
// Deltas (column-major):
//   a: +10, +10  → frames 1,2: 110, 120
//   b:  -5, +15  → frames 1,2: 195, 210
//   c:   0,+100  → frames 1,2: 300, 400
//
// Zigzag-encoded deltas: 20,20, 9,30, 0,200
// Varint bytes: [0x14,0x14, 0x09,0x1e, 0x00, 0xC8,0x01]

console.log('\nparseFile (synthetic type-1 chunk):');

const T0 = 1700000000000; // fixed epoch ms

// Reference doc — must use Double so deserialize() returns typeof === 'number'
const refBson = serialize({ a: new Double(100), b: new Double(200), c: new Double(300) });

const varints = Buffer.from([
  0x14, 0x14,       // a deltas: +10, +10
  0x09, 0x1e,       // b deltas: -5, +15
  0x00, 0xC8, 0x01, // c deltas:  0, +100
]);

const payload = Buffer.alloc(refBson.length + 8 + varints.length);
refBson.copy(payload, 0);
payload.writeUInt32LE(3, refBson.length);     // nMetrics = 3
payload.writeUInt32LE(2, refBson.length + 4); // nSamples = 2
varints.copy(payload, refBson.length + 8);

const compressed = zlib.deflateSync(payload);

// Outer BSON: { _id: Date, type: Int32(1), doc: Binary(compressed) }
// iterateChunks reads the first 4 bytes (= BSON size) and deserializes that span.
// BSON self-describes its length, so the "FTDC file" is just concatenated BSON docs.
const ftdcBuf = serialize({
  _id:  new Date(T0),
  type: new Int32(1),
  doc:  new Binary(compressed),
});

async function run() {
  const { frames, metricKeys } = await parseFile(ftdcBuf);

  check('frame count', frames.length, 3);
  assert.deepStrictEqual(metricKeys, ['a', 'b', 'c']);
  ok('metricKeys order: a, b, c');

  // Frame 0 — reference
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

  console.log('\nAll tests passed.');
}

run().catch(err => { console.error('\nFAIL:', err.message); process.exit(1); });
