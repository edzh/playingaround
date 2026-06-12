'use strict';

const { parseFile } = require('./ftdc-parser');
const { extractSignals, isRelevantMetric } = require('./metric-extractor');
const { detectAnomalies } = require('./anomaly-detector');

async function processFTDC(buffer) {
  const { frames, metricKeys } = await parseFile(buffer, { keep: isRelevantMetric });
  if (frames.length === 0) throw new Error('No metric frames found in FTDC file');
  extractSignals(frames); // mutates frames in place, frees raw metrics
  const anomalies = detectAnomalies(frames);
  return { frames, metricKeys, anomalies };
}

module.exports = { processFTDC };
