'use strict';

function detectAnomalies(frames) {
  const events = [];

  // Per-detector state
  let cachePressureSustain = 0;
  let ticketSustain = 0;
  let iowaitSustain = 0;
  let queueSustain = 0;
  let connCooldown = 0;
  let evictCooldown = 0;
  const evictWindow = []; // rolling 30-sample window

  for (let i = 0; i < frames.length; i++) {
    const s = frames[i].signals;
    if (!s) continue;
    const t = frames[i].t;

    // ── cache pressure ───────────────────────────────────────────────
    if (s.cache_fill_pct > 0.80) {
      cachePressureSustain++;
      if (cachePressureSustain === 30) {
        events.push({
          t, kind: 'cache_pressure', severity: 'WARNING', subsystem: 'wtCache',
          description: `WiredTiger cache at ${(s.cache_fill_pct * 100).toFixed(0)}% capacity for 30+ seconds. Eviction pressure building.`,
        });
      } else if (cachePressureSustain === 40 && s.cache_fill_pct > 0.92) {
        events.push({
          t, kind: 'cache_pressure', severity: 'CRITICAL', subsystem: 'wtCache',
          description: `Cache critically full at ${(s.cache_fill_pct * 100).toFixed(0)}%. Application threads now stalling to evict pages.`,
        });
      }
    } else {
      cachePressureSustain = 0;
    }

    // ── app-thread eviction storm ─────────────────────────────────────
    evictWindow.push(s.app_eviction_rate);
    if (evictWindow.length > 30) evictWindow.shift();
    const evictMean = evictWindow.reduce((a, b) => a + b, 0) / evictWindow.length;

    if (evictCooldown > 0) {
      evictCooldown--;
    } else if (s.app_eviction_rate > Math.max(200, 5 * evictMean) && evictWindow.length >= 10) {
      events.push({
        t, kind: 'app_eviction_storm', severity: 'CRITICAL', subsystem: 'wtCache',
        description: `Application threads evicting ${s.app_eviction_rate.toFixed(0)} pages/s — ${(s.app_eviction_rate / Math.max(1, evictMean)).toFixed(1)}× above baseline. Background eviction cannot keep up.`,
      });
      evictCooldown = 60;
    }

    // ── checkpoint pressure ───────────────────────────────────────────
    if (s.checkpoint_duration_ms > 30000 && (i === 0 || !frames[i - 1].signals || frames[i - 1].signals.checkpoint_duration_ms < 30000)) {
      events.push({
        t, kind: 'checkpoint_pressure',
        severity: s.checkpoint_duration_ms > 60000 ? 'CRITICAL' : 'WARNING',
        subsystem: 'wtCache',
        description: `Checkpoint took ${(s.checkpoint_duration_ms / 1000).toFixed(0)}s. Long checkpoints indicate dirty data accumulation or disk I/O saturation.`,
      });
    }

    // ── ticket starvation ─────────────────────────────────────────────
    const maxUtil = Math.max(s.read_ticket_util, s.write_ticket_util);
    if (maxUtil > 0.95) {
      ticketSustain++;
      if (ticketSustain === 10) {
        const which = s.write_ticket_util > s.read_ticket_util ? 'write' : 'read';
        events.push({
          t, kind: 'ticket_starvation', severity: 'CRITICAL', subsystem: 'execControl',
          description: `${which} tickets at ${(maxUtil * 100).toFixed(0)}% utilization for 10+ seconds. Operations queuing; latency will spike.`,
        });
      }
    } else {
      ticketSustain = 0;
    }

    // ── lock queue buildup ────────────────────────────────────────────
    if (s.queue_depth > 20) {
      queueSustain++;
      if (queueSustain === 5) {
        events.push({
          t, kind: 'lock_queue_buildup', severity: 'CRITICAL', subsystem: 'operations',
          description: `${s.queue_depth} operations queued waiting for global lock (${s.queue_readers} reads, ${s.queue_writers} writes).`,
        });
      }
    } else {
      queueSustain = 0;
    }

    // ── iowait saturation ─────────────────────────────────────────────
    if (s.cpu_iowait_pct > 0.50) {
      iowaitSustain++;
      if (iowaitSustain === 10) {
        events.push({
          t, kind: 'iowait_saturation', severity: 'WARNING', subsystem: 'diskIO',
          description: `CPU iowait at ${(s.cpu_iowait_pct * 100).toFixed(0)}% for 10+ seconds. Disk I/O is the bottleneck.`,
        });
      }
    } else {
      iowaitSustain = 0;
    }

    // ── connection spike ──────────────────────────────────────────────
    if (connCooldown > 0) {
      connCooldown--;
    } else if (s.conn_util > 0.90) {
      const prevUtil = i > 0 ? (frames[i - 1].signals?.conn_util ?? 0) : 0;
      if (prevUtil <= 0.90) {
        events.push({
          t, kind: 'connection_spike', severity: 'WARNING', subsystem: 'connections',
          description: `Connections at ${s.conn_current} (${(s.conn_util * 100).toFixed(0)}% of limit). Connection pool near exhaustion.`,
        });
        connCooldown = 60;
      }
    }
  }

  // ── causal chain synthesis ────────────────────────────────────────
  // Look for cache_pressure + app_eviction_storm + iowait_saturation within 30s
  const cascadeKinds = new Set(['cache_pressure', 'app_eviction_storm', 'iowait_saturation']);
  for (let i = 0; i < events.length; i++) {
    if (!cascadeKinds.has(events[i].kind)) continue;
    const windowEnd = events[i].t + 30000;
    const coOccurring = new Set([events[i].kind]);
    for (let j = i + 1; j < events.length && events[j].t <= windowEnd; j++) {
      coOccurring.add(events[j].kind);
    }
    if (cascadeKinds.size === [...cascadeKinds].filter(k => coOccurring.has(k)).length) {
      events.push({
        t: events[i].t,
        kind: 'cache_cascade',
        severity: 'CRITICAL',
        subsystem: 'wtCache',
        description: 'WiredTiger cache full → application threads evicting → disk I/O saturation. Working set exceeds cache capacity. Writes competing with reads for cache space.',
        causal: true,
      });
      break; // only one cascade event per file
    }
  }

  events.sort((a, b) => a.t - b.t);
  return events;
}

module.exports = { detectAnomalies };
