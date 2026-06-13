'use strict';

class WsClient {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this._ws = null;
    this.onReady        = null;
    this.onAnomalies    = null;
    this.onFrame        = null;
    this.onClusterFrame = null;
    this.onDone         = null;
    this.onError        = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._ws = new WebSocket(`${proto}//${location.host}/ws/${this.sessionId}`);
    this._ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case 'ready':     this.onReady?.(msg);        break;
        case 'anomalies': this.onAnomalies?.(msg.events); break;
        case 'frame':         this.onFrame?.(msg);        break;
        case 'cluster-frame': this.onClusterFrame?.(msg); break;
        case 'done':      this.onDone?.();             break;
        case 'error':     this.onError?.(msg.message); break;
      }
    };
    this._ws.onerror = () => this.onError?.('WebSocket error');
  }

  play(speed) { this._send({ type: 'play',  speed: Number(speed) }); }
  pause()     { this._send({ type: 'pause' }); }
  seek(t)     { this._send({ type: 'seek',  t }); }
  step(dir)   { this._send({ type: 'step',  dir }); }

  _send(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(msg));
  }

  close() { this._ws?.close(); }
}
