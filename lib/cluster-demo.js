'use strict';

// Synthetic 5-host sharded cluster: 1 mongos, 3 shards, 1 config server.
// 10-minute story modeled on real balancer behavior:
//   t 0–240s   shard0 runs hot (60% of routed ops), cache pressure builds
//   t 240–420s balancer migrates chunks shard0 → shard1: shard1 sees insert
//              + disk-write spike (chunk cloning), shard0 evicts under reads,
//              configsvr commits migration metadata
//   t 420–600s load rebalanced, shard0 recovers, shard1 absorbs traffic

const { detectAnomalies } = require('./anomaly-detector');
const { buildClusterSession } = require('./cluster-session');

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(t) { return t * t * (3 - 2 * t); }
function jitter(amount) { return (Math.random() - 0.5) * amount; }

// Full signal object with healthy defaults; callers override what matters.
function sig(over) {
  const ops = over.total_ops_rate ?? 0;
  return {
    total_ops_rate: ops,
    query_rate:   Math.round(ops * 0.52),
    insert_rate:  Math.round(ops * 0.22),
    update_rate:  Math.round(ops * 0.16),
    delete_rate:  Math.round(ops * 0.04),
    command_rate: Math.round(ops * 0.04),
    getmore_rate: Math.round(ops * 0.02),
    cache_fill_pct: 0.40, dirty_pct: 0.03,
    app_eviction_rate: 0, total_eviction_rate: 0,
    read_ticket_util: 0.15, write_ticket_util: 0.12,
    read_tickets_out: 19, write_tickets_out: 15,
    read_tickets_total: 128, write_tickets_total: 128,
    conn_util: 0.10, conn_current: 90, conn_available: 810,
    cpu_user_pct: 0.10, cpu_sys_pct: 0.03, cpu_iowait_pct: 0.01, cpu_idle_pct: 0.86,
    disk_read_mbps: 8, disk_write_mbps: 15,
    net_in_mbps: ops * 0.009, net_out_mbps: ops * 0.012,
    queue_readers: 0, queue_writers: 0, queue_depth: 0,
    mem_resident_mb: 8192, mem_virtual_mb: 16384,
    checkpoint_duration_ms: 0,
    exec_target_throughput: 0, exec_admitted: 0,
    ...over,
  };
}

// Migration window envelope: 0 outside [240s, 420s], smooth bell inside
function migration(ph) {
  if (ph < 0.40 || ph >= 0.70) return 0;
  return Math.sin(Math.PI * (ph - 0.40) / 0.30);
}

function generateClusterDemo() {
  const N  = 600;
  const T0 = Date.now() - N * 1000;

  const mongos    = [];
  const shard0    = [];
  const shard1    = [];
  const shard2    = [];
  const configsvr = [];

  for (let i = 0; i < N; i++) {
    const t   = T0 + i * 1000;
    const ph  = i / N;
    const mig = migration(ph);

    // Client demand routed by mongos (sinusoidal workload)
    const demand = 5200 + 1200 * Math.sin(i * 0.045) + jitter(150);

    // Routing fractions: shard0 hot early, traffic shifts to shard1 post-migration
    const shift  = smoothstep(clamp((ph - 0.45) / 0.30, 0, 1)); // 0 → 1 across migration
    const f0 = lerp(0.60, 0.34, shift);
    const f1 = lerp(0.22, 0.46, shift);
    const f2 = 1 - f0 - f1;

    // ── mongos: pure router — no WiredTiger cache, no disk to speak of ──
    mongos.push({ t, signals: sig({
      total_ops_rate: Math.round(demand),
      cache_fill_pct: 0, dirty_pct: 0,
      conn_current: Math.round(240 + demand * 0.02 + jitter(10)),
      conn_available: 760,
      conn_util: clamp((240 + demand * 0.02) / 1000, 0, 1),
      cpu_user_pct: clamp(0.08 + demand / 40000, 0, 1),
      disk_read_mbps: 0.2, disk_write_mbps: 0.4,
      mem_resident_mb: 1024, mem_virtual_mb: 4096,
    }) });

    // ── shard0: hot shard — cache pressure arc, relieved by migration ──
    const ops0 = Math.round(demand * f0);
    let fill0;
    if (ph < 0.40)      fill0 = lerp(0.55, 0.94, smoothstep(ph / 0.40));
    else if (ph < 0.70) fill0 = 0.93 + 0.03 * Math.sin((ph - 0.40) * 30);
    else                fill0 = lerp(0.90, 0.58, smoothstep((ph - 0.70) / 0.30));
    const stress0 = clamp((fill0 - 0.78) / 0.17, 0, 1);
    const evict0  = ph >= 0.32 && ph < 0.72
      ? Math.max(0, Math.round(450 * Math.sin(Math.PI * (ph - 0.32) / 0.40) * (0.85 + 0.15 * Math.random())))
      : 0;
    const iowait0 = clamp(0.04 + stress0 * 0.40 + mig * 0.15 + jitter(0.03), 0, 0.75);
    shard0.push({ t, signals: sig({
      total_ops_rate: ops0,
      cache_fill_pct: clamp(fill0, 0, 1),
      dirty_pct: clamp(0.05 + stress0 * 0.18, 0, 1),
      app_eviction_rate: evict0, total_eviction_rate: Math.round(evict0 * 1.4),
      read_ticket_util: clamp(0.25 + stress0 * 0.68, 0, 1),
      write_ticket_util: clamp(0.20 + stress0 * 0.72, 0, 1),
      read_tickets_out: Math.round(128 * clamp(0.25 + stress0 * 0.68, 0, 1)),
      write_tickets_out: Math.round(128 * clamp(0.20 + stress0 * 0.72, 0, 1)),
      queue_depth: Math.round(stress0 * 38 * Math.random()),
      cpu_user_pct: clamp(0.15 + stress0 * 0.18, 0, 1),
      cpu_iowait_pct: iowait0,
      cpu_idle_pct: clamp(1 - 0.18 - stress0 * 0.18 - iowait0, 0.02, 1),
      disk_read_mbps: Math.round(20 + iowait0 * 260 + mig * 90),   // migration reads source chunks
      disk_write_mbps: Math.round(35 + evict0 * 0.4),
      conn_current: Math.round(120 + stress0 * 110), conn_available: 770,
      conn_util: clamp((120 + stress0 * 110) / 1000, 0, 1),
      mem_resident_mb: Math.round(12288 + fill0 * 4096),
    }) });

    // ── shard1: migration target — chunk-clone insert + disk spike ──
    const ops1 = Math.round(demand * f1 + mig * 1800); // recvChunk inserts on top of routed ops
    shard1.push({ t, signals: sig({
      total_ops_rate: ops1,
      insert_rate: Math.round(ops1 * 0.22 + mig * 1500),
      cache_fill_pct: clamp(0.42 + mig * 0.28 + shift * 0.10, 0, 1),
      dirty_pct: clamp(0.04 + mig * 0.14, 0, 1),
      write_ticket_util: clamp(0.15 + mig * 0.55, 0, 1),
      write_tickets_out: Math.round(128 * clamp(0.15 + mig * 0.55, 0, 1)),
      disk_write_mbps: Math.round(25 + mig * 320),     // chunk cloning writes
      disk_read_mbps: 12,
      cpu_user_pct: clamp(0.10 + mig * 0.20, 0, 1),
      cpu_iowait_pct: clamp(0.02 + mig * 0.22, 0, 1),
      cpu_idle_pct: clamp(0.85 - mig * 0.42, 0.02, 1),
      checkpoint_duration_ms: mig > 0.8 ? Math.round(34000 * mig) : 0,
      mem_resident_mb: Math.round(10240 + mig * 3072),
    }) });

    // ── shard2: cold shard — healthy baseline ──
    const ops2 = Math.round(demand * f2);
    shard2.push({ t, signals: sig({
      total_ops_rate: ops2,
      cache_fill_pct: clamp(0.35 + 0.04 * Math.sin(i * 0.03), 0, 1),
      mem_resident_mb: 9216,
    }) });

    // ── configsvr: near idle; balancer round commits every ~60s ──
    const round = (i % 60) < 4 ? 1 : 0;
    configsvr.push({ t, signals: sig({
      total_ops_rate: Math.round(25 + round * 140 + mig * 220),
      command_rate: Math.round(20 + round * 120 + mig * 180),
      insert_rate: 2, query_rate: Math.round(3 + round * 15),
      update_rate: Math.round(mig * 30), delete_rate: 0, getmore_rate: 0,
      cache_fill_pct: 0.12, disk_write_mbps: Math.round(2 + mig * 18),
      conn_current: 45, conn_available: 955, conn_util: 0.045,
      cpu_user_pct: 0.04, cpu_idle_pct: 0.94,
      mem_resident_mb: 2048, mem_virtual_mb: 6144,
    }) });
  }

  const hostSessions = [
    { label: 'mongos:27000',        role: 'mongos',    frames: mongos,    anomalies: detectAnomalies(mongos) },
    { label: 'rs-shard0/db0:27018', role: 'shardsvr',  frames: shard0,    anomalies: detectAnomalies(shard0) },
    { label: 'rs-shard1/db1:27018', role: 'shardsvr',  frames: shard1,    anomalies: detectAnomalies(shard1) },
    { label: 'rs-shard2/db2:27018', role: 'shardsvr',  frames: shard2,    anomalies: detectAnomalies(shard2) },
    { label: 'cfg/cfg0:27019',      role: 'configsvr', frames: configsvr, anomalies: detectAnomalies(configsvr) },
  ];

  return buildClusterSession(hostSessions);
}

module.exports = { generateClusterDemo };
