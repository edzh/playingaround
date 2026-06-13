'use strict';

const { WebSocketServer } = require('ws');
const { computeSubsystemHealth } = require('./metric-extractor');

function attach(httpServer, sessionStore) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/ws\/([^/?]+)/);
    if (!match) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, match[1]));
  });

  wss.on('connection', (ws, _req, sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      ws.close();
      return;
    }

    const state = { frameIndex: 0, speed: 1, timer: null };

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    const isCluster = session.type === 'cluster';

    const sendFrame = (idx) => {
      if (ws.bufferedAmount > 65536) return; // skip if backpressured
      const frame = session.frames[idx];
      if (!frame) return;
      if (isCluster) {
        const hosts = {};
        for (const [label, m] of Object.entries(frame.hosts)) {
          hosts[label] = { m, h: computeSubsystemHealth(m) };
        }
        send({ type: 'cluster-frame', i: idx, t: frame.t, hosts });
      } else {
        if (!frame.signals) return;
        send({ type: 'frame', i: idx, t: frame.t, m: frame.signals, h: computeSubsystemHealth(frame.signals) });
      }
    };

    const startTimer = () => {
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => {
        if (state.frameIndex >= session.frames.length) {
          send({ type: 'done' });
          clearInterval(state.timer);
          state.timer = null;
          return;
        }
        sendFrame(state.frameIndex++);
      }, Math.max(16, Math.floor(1000 / state.speed)));
    };

    send({ type: 'ready', nFrames: session.nFrames, timeRange: session.timeRange, hosts: session.hosts || null });
    send({ type: 'anomalies', events: session.anomalies });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      switch (msg.type) {
        case 'play':
          state.speed = [1, 5, 10, 60].includes(Number(msg.speed)) ? Number(msg.speed) : 1;
          startTimer();
          break;
        case 'pause':
          if (state.timer) { clearInterval(state.timer); state.timer = null; }
          break;
        case 'seek': {
          const t = msg.t;
          let best = 0, bestDiff = Infinity;
          for (let i = 0; i < session.frames.length; i++) {
            const d = Math.abs(session.frames[i].t - t);
            if (d < bestDiff) { bestDiff = d; best = i; }
            if (d > bestDiff) break; // frames are sorted
          }
          state.frameIndex = best;
          sendFrame(best);
          break;
        }
        case 'step':
          state.frameIndex = Math.max(0, Math.min(session.frames.length - 1, state.frameIndex + (msg.dir === -1 ? -1 : 1)));
          sendFrame(state.frameIndex);
          break;
      }
    });

    ws.on('close', () => { if (state.timer) clearInterval(state.timer); });
  });
}

module.exports = { attach };
