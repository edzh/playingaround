'use strict';

(function() {

const NODE_GEO = {
  clients:     { x: 18,   y: 255, w: 120, h: 100 },
  connections: { x: 185,  y: 255, w: 145, h: 100 },
  execControl: { x: 382,  y: 235, w: 158, h: 130 },
  operations:  { x: 595,  y: 255, w: 155, h: 100 },
  wtCache:     { x: 805,  y: 155, w: 195, h: 185 },
  diskIO:      { x: 1050, y: 255, w: 135, h: 100 },
  replication: { x: 18,   y: 75,  w: 148, h: 80  },
  cpu:         { x: 382,  y: 80,  w: 158, h: 100 },
};

function pt(id, side) {
  const n = NODE_GEO[id];
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  if (side === 'r') return [n.x + n.w, cy];
  if (side === 'l') return [n.x, cy];
  if (side === 't') return [cx, n.y];
  if (side === 'b') return [cx, n.y + n.h];
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
  ];
}

function evalEdge(e, t) {
  if (e.type === 'bezier') {
    return cubicBezier(e.p0, e.p1, e.p2, e.p3, t);
  }
  // polyline
  let d = t * e.totalLen;
  for (const seg of e.segs) {
    if (d <= seg.len || seg === e.segs[e.segs.length - 1]) {
      const u = seg.len > 0 ? Math.min(1, d / seg.len) : 0;
      return [seg.a[0] + u * (seg.b[0] - seg.a[0]), seg.a[1] + u * (seg.b[1] - seg.a[1])];
    }
    d -= seg.len;
  }
}

function bezierEdge(a, b, dx = 55) {
  return { type: 'bezier', p0: a, p1: [a[0]+dx, a[1]], p2: [b[0]-dx, b[1]], p3: b };
}

function polylineEdge(points) {
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len });
    totalLen += len;
  }
  return { type: 'polyline', segs, totalLen };
}

function buildLanes() {
  const dBot = pt('diskIO', 'b'), cBot = pt('wtCache', 'b');
  const midY = Math.max(dBot[1], cBot[1]) + 40;
  const F = window.LG.flow;

  return [
    { color: F.ops, signal: 'total_ops_rate',    maxVal: 10000, maxRate: 12,
      edge: bezierEdge(pt('clients','r'), pt('connections','l'), 55) },
    { color: F.ops, signal: 'total_ops_rate',    maxVal: 10000, maxRate: 12,
      edge: bezierEdge(pt('connections','r'), pt('execControl','l'), 55) },
    { color: F.ops, signal: 'total_ops_rate',    maxVal: 10000, maxRate: 12,
      edge: bezierEdge(pt('execControl','r'), pt('operations','l'), 55) },
    { color: F.ops, signal: 'total_ops_rate',    maxVal: 10000, maxRate: 12,
      edge: bezierEdge(pt('operations','r'), pt('wtCache','l'), 90) },
    { color: F.evict, signal: 'app_eviction_rate', maxVal: 1000,  maxRate: 8,
      edge: bezierEdge(pt('wtCache','r'), pt('diskIO','l'), 70) },
    { color: F.read, signal: 'disk_read_mbps',    maxVal: 500,   maxRate: 6,
      edge: polylineEdge([dBot, [dBot[0], midY], [cBot[0], midY], cBot]) },
    { color: F.repl, signal: 'insert_rate',       maxVal: 5000,  maxRate: 5,
      edge: { type: 'bezier',
        p0: pt('operations','t'),
        p1: [pt('operations','t')[0], pt('operations','t')[1] - 70],
        p2: [pt('replication','r')[0] + 70, pt('replication','r')[1]],
        p3: pt('replication','r') } },
  ];
}

class Particles {
  init(canvasEl) {
    this._canvas = canvasEl;
    this._ctx = canvasEl.getContext('2d');
    this._lanes = buildLanes().map(l => ({ ...l, particles: [], _acc: 0 }));
    this._signals = {};
    this._lastT = null;
    this._xfm = { scale: 1, ox: 0, oy: 0 };

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._raf = requestAnimationFrame(t => this._loop(t));
  }

  _resize() {
    const c = this._canvas.parentElement;
    const W = c.clientWidth || 1200, H = c.clientHeight || 620;
    this._canvas.width  = W;
    this._canvas.height = H;
    const scale = Math.min(W / 1200, H / 620);
    this._xfm = { scale, ox: (W - 1200 * scale) / 2, oy: (H - 620 * scale) / 2 };
  }

  update(signals) { this._signals = signals || {}; }

  _toCanvas(x, y) {
    const { scale, ox, oy } = this._xfm;
    return [x * scale + ox, y * scale + oy];
  }

  _loop(now) {
    const dt = this._lastT ? Math.min((now - this._lastT) / 1000, 0.1) : 0.016;
    this._lastT = now;

    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

    for (const lane of this._lanes) {
      const rawVal = this._signals[lane.signal] || 0;
      const ratio  = Math.min(1, rawVal / lane.maxVal);
      if (ratio === 0 && lane.particles.length === 0) continue;

      // Spawn
      lane._acc += ratio * lane.maxRate * dt;
      while (lane._acc >= 1) {
        lane._acc -= 1;
        lane.particles.push({
          t:     Math.random() * 0.05,
          speed: 0.25 + ratio * 0.30 + Math.random() * 0.10,
          r:     1.2 + ratio * 1.4,
          alpha: 0.6 + Math.random() * 0.3,
        });
      }

      // Move + draw
      const scale = this._xfm.scale;
      lane.particles = lane.particles.filter(p => {
        p.t += p.speed * dt;
        if (p.t >= 1) return false;
        const [sx, sy] = evalEdge(lane.edge, p.t);
        const [cx, cy] = this._toCanvas(sx, sy);
        // Fade out in final 15% of path
        const fade = p.t > 0.85 ? 1 - (p.t - 0.85) / 0.15 : 1;
        ctx.globalAlpha = p.alpha * fade;
        ctx.fillStyle   = lane.color;
        ctx.beginPath();
        ctx.arc(cx, cy, p.r * scale, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
    }

    ctx.globalAlpha = 1;
    this._raf = requestAnimationFrame(t => this._loop(t));
  }

  destroy() {
    cancelAnimationFrame(this._raf);
  }
}

window.Particles = Particles;
})();
