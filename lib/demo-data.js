'use strict';

const { detectAnomalies } = require('./anomaly-detector');

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(t) { return t * t * (3 - 2 * t); }

// 10-minute demo session: normal → cache pressure → eviction storm → checkpoint → recovery
function generateDemo() {
  const N  = 600;
  const T0 = Date.now() - N * 1000; // session ends "now" so playhead starts at left

  const frames = [];

  for (let i = 0; i < N; i++) {
    const t = T0 + i * 1000;
    const ph = i / N; // 0..1

    // ── Cache fill ─────────────────────────────────────────────────────────
    let cacheFill;
    if (ph < 0.40)      cacheFill = lerp(0.48, 0.95, smoothstep(ph / 0.40));
    else if (ph < 0.68) cacheFill = 0.91 + 0.05 * Math.sin((ph - 0.40) * 35);
    else                cacheFill = lerp(0.92, 0.52, smoothstep((ph - 0.68) / 0.32));
    cacheFill = clamp(cacheFill, 0, 1);

    // ── Dirty pct ──────────────────────────────────────────────────────────
    let dirtyPct;
    if (ph < 0.35)      dirtyPct = lerp(0.04, 0.20, smoothstep(ph / 0.35));
    else if (ph < 0.66) dirtyPct = lerp(0.20, 0.26, smoothstep((ph - 0.35) / 0.31));
    else                dirtyPct = lerp(0.24, 0.05, smoothstep((ph - 0.66) / 0.34));
    dirtyPct = clamp(dirtyPct, 0, 1);

    // ── App eviction storm (phase 0.33–0.70) ───────────────────────────────
    let appEvict = 0;
    if (ph >= 0.33 && ph < 0.70) {
      const ep = (ph - 0.33) / 0.37;
      appEvict = 600 * Math.sin(Math.PI * ep) * (0.85 + 0.15 * Math.random());
    }
    appEvict = Math.max(0, Math.round(appEvict));

    // ── iowait: disk thrash follows eviction ───────────────────────────────
    let iowait = 0;
    if (ph >= 0.35 && ph < 0.72) {
      const ip = (ph - 0.35) / 0.37;
      iowait = 0.60 * Math.sin(Math.PI * ip) + 0.04 * (Math.random() - 0.5);
    }
    iowait = clamp(iowait, 0, 0.80);

    // ── Ticket stress ──────────────────────────────────────────────────────
    const stress = clamp((cacheFill - 0.78) / 0.17, 0, 1);
    const wUtil  = clamp(0.28 + stress * 0.70 + 0.04 * Math.random(), 0, 1);
    const rUtil  = clamp(0.22 + stress * 0.60 + 0.04 * Math.random(), 0, 1);

    // ── Ops rate (dips when tickets saturate) ──────────────────────────────
    const baseOps   = 3200 + 900 * Math.sin(i * 0.055);
    const totalOps  = Math.round(baseOps * clamp(1 - stress * 0.45, 0.30, 1));
    const queueD    = Math.round(stress * 50 * Math.random());

    // ── CPU ────────────────────────────────────────────────────────────────
    const cpuUser = clamp(0.14 + 0.09 * Math.sin(i * 0.09) + (appEvict > 80 ? 0.14 : 0), 0, 1);
    const cpuSys  = clamp(0.04 + 0.02 * Math.sin(i * 0.13), 0, 1);
    const cpuIdle = clamp(1 - cpuUser - cpuSys - iowait, 0.02, 1);

    // ── Checkpoint spike: phase 0.63–0.68 ─────────────────────────────────
    let checkpointMs = 0;
    if (ph >= 0.63 && ph < 0.68) {
      checkpointMs = Math.max(0, Math.round(48000 * Math.sin(Math.PI * (ph - 0.63) / 0.05)));
    }

    // ── Disk / network ─────────────────────────────────────────────────────
    const diskWrite = clamp(45 + appEvict * 0.35 + checkpointMs * 0.04, 0, 800);
    const diskRead  = clamp(25 + iowait * 220, 0, 800);
    const netOut    = totalOps * 0.012;
    const netIn     = totalOps * 0.009;

    // ── Connections ────────────────────────────────────────────────────────
    const connCurr  = Math.round(85 + stress * 130);
    const connAvail = Math.round(900 - connCurr);

    frames.push({
      t,
      signals: {
        total_ops_rate:         totalOps,
        query_rate:             Math.round(totalOps * 0.54),
        insert_rate:            Math.round(totalOps * 0.20),
        update_rate:            Math.round(totalOps * 0.19),
        delete_rate:            Math.round(totalOps * 0.07),
        cache_fill_pct:         cacheFill,
        dirty_pct:              dirtyPct,
        app_eviction_rate:      appEvict,
        total_eviction_rate:    Math.round(appEvict * 1.45),
        write_ticket_util:      wUtil,
        read_ticket_util:       rUtil,
        write_tickets_out:      Math.round(128 * wUtil),
        write_tickets_total:    128,
        read_tickets_out:       Math.round(128 * rUtil),
        read_tickets_total:     128,
        conn_util:              connCurr / (connCurr + connAvail),
        conn_current:           connCurr,
        conn_available:         connAvail,
        cpu_user_pct:           cpuUser,
        cpu_sys_pct:            cpuSys,
        cpu_idle_pct:           cpuIdle,
        cpu_iowait_pct:         iowait,
        disk_write_mbps:        Math.round(diskWrite),
        disk_read_mbps:         Math.round(diskRead),
        net_out_mbps:           netOut,
        net_in_mbps:            netIn,
        queue_depth:            queueD,
        checkpoint_duration_ms: checkpointMs,
        mem_resident_mb:        Math.round(16384 + cacheFill * 8192),
        mem_virtual_mb:         32768,
      },
    });
  }

  const anomalies = detectAnomalies(frames);

  return {
    frames,
    nFrames:   N,
    timeRange: [T0, T0 + (N - 1) * 1000],
    anomalies,
  };
}

module.exports = { generateDemo };
