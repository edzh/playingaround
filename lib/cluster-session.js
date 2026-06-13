'use strict';

// Merges N single-host sessions into one cluster session whose frames are
// aligned to a shared 1-second grid covering the time window where every
// host was recording concurrently.

const MAX_GRID = 86400;       // cap merged session at 24h of 1s ticks
const SNAP_TOLERANCE = 1500;  // ms — host frame must be this close to a grid tick

// Guarantee unique labels even when two files report the same host:port
// (e.g. both ran on "localhost"). Appends #2, #3, ... on collision.
function dedupeLabels(hosts) {
  const seen = new Map();
  for (const h of hosts) {
    const base = h.label;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) h.label = `${base}#${n}`;
  }
  return hosts;
}

// hostSessions: [{ label, role, frames: [{t, signals}], anomalies }]
function buildClusterSession(hostSessions) {
  if (hostSessions.length < 2) throw new Error('Cluster session needs at least 2 hosts');

  const hosts = dedupeLabels(hostSessions.map(h => ({
    label: h.label,
    role:  h.role || 'standalone',
  })));

  // Intersection window: every host must be recording
  let start = -Infinity, end = Infinity;
  for (const h of hostSessions) {
    if (!h.frames.length) throw new Error(`Host "${h.label}" has no frames`);
    start = Math.max(start, h.frames[0].t);
    end   = Math.min(end,   h.frames[h.frames.length - 1].t);
  }
  if (end - start < 10_000) {
    throw new Error('FTDC files do not overlap in time (need at least 10s of common window)');
  }

  // 1-second grid, capped at MAX_GRID ticks (keep the most recent window)
  let nTicks = Math.floor((end - start) / 1000) + 1;
  if (nTicks > MAX_GRID) {
    start = end - (MAX_GRID - 1) * 1000;
    nTicks = MAX_GRID;
  }

  // For each host, walk a pointer through its sorted frames picking the
  // nearest frame for each tick (O(frames) total per host, not O(n²)).
  const frames = new Array(nTicks);
  for (let i = 0; i < nTicks; i++) {
    frames[i] = { t: start + i * 1000, hosts: {} };
  }

  for (let hi = 0; hi < hostSessions.length; hi++) {
    const label = hosts[hi].label;
    const hf = hostSessions[hi].frames;
    let p = 0;
    for (let i = 0; i < nTicks; i++) {
      const t = frames[i].t;
      while (p + 1 < hf.length && Math.abs(hf[p + 1].t - t) <= Math.abs(hf[p].t - t)) p++;
      if (Math.abs(hf[p].t - t) <= SNAP_TOLERANCE && hf[p].signals) {
        frames[i].hosts[label] = hf[p].signals;
      }
      // else: gap in this host's data — card shows last known state client-side
    }
  }

  // Merge anomalies, tag with host, keep only those inside the window
  const anomalies = [];
  for (let hi = 0; hi < hostSessions.length; hi++) {
    const label = hosts[hi].label;
    for (const ev of hostSessions[hi].anomalies || []) {
      if (ev.t < start || ev.t > end) continue;
      anomalies.push({ ...ev, host: label, description: `[${label}] ${ev.description}` });
    }
  }
  anomalies.sort((a, b) => a.t - b.t);

  return {
    type: 'cluster',
    hosts,
    frames,
    anomalies,
    nFrames: nTicks,
    timeRange: [start, start + (nTicks - 1) * 1000],
  };
}

module.exports = { buildClusterSession };
