'use strict';

const { Router } = require('express');
const { processFTDC } = require('../lib/pipeline');
const { generateDemo } = require('../lib/demo-data');
const { generateClusterDemo } = require('../lib/cluster-demo');
const { buildClusterSession } = require('../lib/cluster-session');
const sessionStore = require('../lib/session-store');

const router = Router();

router.post('/api/upload', async (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty or invalid body' });
    }
    const { frames, metricKeys, anomalies, hostInfo } = await processFTDC(buffer);
    const timeRange = [frames[0].t, frames[frames.length - 1].t];
    const sessionId = sessionStore.create({ frames, metricKeys, anomalies, hostInfo, timeRange, nFrames: frames.length });
    res.json({ sessionId, nFrames: frames.length, timeRange, anomalies, hostInfo });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Merge N previously-uploaded sessions into one time-aligned cluster session.
// Body: { sessions: [{ sessionId, label }] }
router.post('/api/cluster', (req, res) => {
  try {
    const specs = req.body?.sessions;
    if (!Array.isArray(specs) || specs.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 sessions to build a cluster' });
    }
    const hostSessions = specs.map(spec => {
      const s = sessionStore.get(spec.sessionId);
      if (!s) throw new Error(`Session not found: ${spec.sessionId}`);
      return {
        label: spec.label || s.hostInfo?.uniqueLabel || spec.sessionId.slice(0, 8),
        role:  s.hostInfo?.role || 'standalone',
        frames: s.frames,
        anomalies: s.anomalies,
      };
    });
    const data = buildClusterSession(hostSessions);
    const sessionId = sessionStore.create(data);
    // Single-host sessions are no longer needed once merged
    for (const spec of specs) sessionStore.delete(spec.sessionId);
    res.json({ sessionId, type: 'cluster', hosts: data.hosts, nFrames: data.nFrames, timeRange: data.timeRange, anomalies: data.anomalies });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/demo', (req, res) => {
  try {
    const data = generateDemo();
    const sessionId = sessionStore.create(data);
    res.json({ sessionId, nFrames: data.nFrames, timeRange: data.timeRange, anomalies: data.anomalies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/cluster-demo', (req, res) => {
  try {
    const data = generateClusterDemo();
    const sessionId = sessionStore.create(data);
    res.json({ sessionId, type: 'cluster', hosts: data.hosts, nFrames: data.nFrames, timeRange: data.timeRange, anomalies: data.anomalies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/sessions/:id/metadata', (req, res) => {
  const session = sessionStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: session.id, type: session.type || 'single', hosts: session.hosts, nFrames: session.nFrames, timeRange: session.timeRange, anomalies: session.anomalies });
});

module.exports = router;
