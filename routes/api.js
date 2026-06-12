'use strict';

const { Router } = require('express');
const { processFTDC } = require('../lib/pipeline');
const sessionStore = require('../lib/session-store');

const router = Router();

router.post('/api/upload', async (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty or invalid body' });
    }
    const { frames, metricKeys, anomalies } = await processFTDC(buffer);
    const timeRange = [frames[0].t, frames[frames.length - 1].t];
    const sessionId = sessionStore.create({ frames, metricKeys, anomalies, timeRange, nFrames: frames.length });
    res.json({ sessionId, nFrames: frames.length, timeRange, anomalies });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/sessions/:id/metadata', (req, res) => {
  const session = sessionStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: session.id, nFrames: session.nFrames, timeRange: session.timeRange, anomalies: session.anomalies });
});

module.exports = router;
