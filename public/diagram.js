'use strict';

(function() {

// LeafyGreen health tokens (border + dimmed surface tint per state)
const H = window.LG.health;
const P = window.LG.palette;
const HBG  = { GREEN: H.GREEN.bg, YELLOW: H.YELLOW.bg, RED: H.RED.bg };
const HBDR = { GREEN: H.GREEN.border, YELLOW: H.YELLOW.border, RED: H.RED.border };

function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return digits > 0 ? n.toFixed(digits) : Math.round(n).toString();
}
function fmtMB(n) {
  if (!n) return '–';
  return n >= 1024 ? (n / 1024).toFixed(1) + 'GB' : Math.round(n) + 'MB';
}
function pct(n) { return ((n || 0) * 100).toFixed(0) + '%'; }

// Node definitions — x,y,w,h define the bounding rect
const NODES = [
  {
    id: 'clients', label: 'CLIENTS',
    x: 18, y: 255, w: 120, h: 100,
    primary: s => Math.min(1, (s?.total_ops_rate || 0) / 10000),
    lines: [
      { t: s => fmt(s?.total_ops_rate) + ' ops/s', w: () => false },
    ],
  },
  {
    id: 'connections', label: 'CONNECTIONS',
    x: 185, y: 255, w: 145, h: 100,
    primary: s => s?.conn_util || 0,
    lines: [
      { t: s => `curr: ${s?.conn_current | 0}`, w: s => (s?.conn_util || 0) > 0.85 },
      { t: s => `util: ${pct(s?.conn_util)}`,   w: s => (s?.conn_util || 0) > 0.85 },
    ],
  },
  {
    id: 'execControl', label: 'EXEC CONTROL',
    x: 382, y: 235, w: 158, h: 130,
    primary: s => Math.max(s?.read_ticket_util || 0, s?.write_ticket_util || 0),
    lines: [
      { t: s => `R: ${s?.read_tickets_out | 0}/${s?.read_tickets_total | 0}`,  w: s => (s?.read_ticket_util || 0) > 0.8 },
      { t: s => `W: ${s?.write_tickets_out | 0}/${s?.write_tickets_total | 0}`, w: s => (s?.write_ticket_util || 0) > 0.8 },
      { t: s => (s?.queue_depth || 0) > 0 ? `Q: ${s.queue_depth | 0} waiting` : 'Q: idle', w: s => (s?.queue_depth || 0) > 10, c: s => (s?.queue_depth || 0) > 30 },
    ],
  },
  {
    id: 'operations', label: 'OPERATIONS',
    x: 595, y: 255, w: 155, h: 100,
    primary: s => Math.min(1, (s?.queue_depth || 0) / 50),
    lines: [
      { t: s => `q:${fmt(s?.query_rate)} i:${fmt(s?.insert_rate)}`, w: () => false },
      { t: s => `u:${fmt(s?.update_rate)} d:${fmt(s?.delete_rate)}`, w: () => false },
    ],
  },
  {
    id: 'wtCache', label: 'WIREDTIGER CACHE',
    x: 805, y: 155, w: 195, h: 185,
    primary: s => s?.cache_fill_pct || 0,
    lines: [
      { t: s => `fill:  ${pct(s?.cache_fill_pct)}`,  w: s => (s?.cache_fill_pct || 0) > 0.80, c: s => (s?.cache_fill_pct || 0) > 0.92 },
      { t: s => `dirty: ${pct(s?.dirty_pct)}`,        w: s => (s?.dirty_pct || 0) > 0.15 },
      { t: s => `evict: ${fmt(s?.app_eviction_rate)}/s`, w: s => (s?.app_eviction_rate || 0) > 0, c: s => (s?.app_eviction_rate || 0) > 100 },
      { t: s => (s?.checkpoint_duration_ms || 0) > 500 ? `ckpt:  ${((s.checkpoint_duration_ms) / 1000).toFixed(0)}s ⏱` : 'ckpt:  –', w: s => (s?.checkpoint_duration_ms || 0) > 30000 },
    ],
  },
  {
    id: 'diskIO', label: 'DISK I/O',
    x: 1050, y: 255, w: 135, h: 100,
    primary: s => Math.min(1, (s?.disk_write_mbps || 0) / 500),
    lines: [
      { t: s => `wr: ${fmt(s?.disk_write_mbps, 1)} MB/s`, w: s => (s?.disk_write_mbps || 0) > 200 },
      { t: s => `rd: ${fmt(s?.disk_read_mbps, 1)} MB/s`,  w: () => false },
    ],
  },
  {
    id: 'replication', label: 'REPLICATION',
    x: 18, y: 75, w: 148, h: 80,
    primary: () => 0,
    lines: [
      { t: () => 'lag: –', w: () => false },
    ],
  },
  {
    id: 'cpu', label: 'CPU',
    x: 382, y: 80, w: 158, h: 100,
    primary: s => 1 - (s?.cpu_idle_pct || 1),
    lines: [
      { t: s => `usr:${pct(s?.cpu_user_pct)} sys:${pct(s?.cpu_sys_pct)}`, w: () => false },
      { t: s => `iowait: ${pct(s?.cpu_iowait_pct)}`, w: s => (s?.cpu_iowait_pct || 0) > 0.25, c: s => (s?.cpu_iowait_pct || 0) > 0.5 },
    ],
  },
  {
    id: 'network', label: 'NETWORK',
    x: 805, y: 465, w: 155, h: 80,
    primary: s => Math.min(1, (s?.net_out_mbps || 0) / 100),
    lines: [
      { t: s => `tx: ${fmt(s?.net_out_mbps, 1)} MB/s`, w: () => false },
      { t: s => `rx: ${fmt(s?.net_in_mbps, 1)} MB/s`,  w: () => false },
    ],
  },
  {
    id: 'memory', label: 'MEMORY',
    x: 595, y: 465, w: 155, h: 80,
    primary: () => 0,
    lines: [
      { t: s => `res:  ${fmtMB(s?.mem_resident_mb)}`, w: () => false },
      { t: s => `virt: ${fmtMB(s?.mem_virtual_mb)}`,  w: () => false },
    ],
  },
];

const NM = Object.fromEntries(NODES.map(n => [n.id, n]));

function pt(id, side) {
  const n = NM[id];
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  switch (side) {
    case 'r': return [n.x + n.w, cy];
    case 'l': return [n.x, cy];
    case 't': return [cx, n.y];
    case 'b': return [cx, n.y + n.h];
  }
}

function bezier(x1, y1, x2, y2, dx = 55) {
  return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
}

function buildEdges() {
  const edges = [];
  const add = (id, f, fs, t, ts, color, cls, signal, maxVal, ctor) => {
    const [x1,y1] = pt(f, fs), [x2,y2] = pt(t, ts);
    edges.push({ id, d: ctor ? ctor(x1,y1,x2,y2) : bezier(x1,y1,x2,y2), color, cls, signal, maxVal });
  };

  const F = window.LG.flow;
  add('e-cli-conn',  'clients','r',  'connections','l', F.ops,'edge-flow','total_ops_rate',10000);
  add('e-conn-exec', 'connections','r','execControl','l',F.ops,'edge-flow','total_ops_rate',10000);
  add('e-exec-ops',  'execControl','r','operations','l', F.ops,'edge-flow','total_ops_rate',10000);
  add('e-ops-cache', 'operations','r','wtCache','l',     F.ops,'edge-flow','total_ops_rate',10000,
    (x1,y1,x2,y2) => bezier(x1,y1,x2,y2,90));
  add('e-cache-disk','wtCache','r',  'diskIO','l',       F.evict,'edge-flow','app_eviction_rate',1000,
    (x1,y1,x2,y2) => bezier(x1,y1,x2,y2,70));

  // Disk → Cache (read path, below both nodes)
  {
    const [x1,y1] = pt('diskIO','b'), [x2,y2] = pt('wtCache','b');
    const my = Math.max(y1,y2) + 40;
    edges.push({ id:'e-disk-cache', d:`M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`, color:F.read, cls:'edge-back', signal:'disk_read_mbps', maxVal:500 });
  }

  // Operations → Replication
  {
    const [x1,y1] = pt('operations','t'), [x2,y2] = pt('replication','r');
    edges.push({ id:'e-ops-repl', d:`M${x1},${y1} C${x1},${y1-70} ${x2+70},${y2} ${x2},${y2}`, color:F.repl, cls:'edge-info', signal:'insert_rate', maxVal:5000 });
  }

  // ExecControl → CPU
  {
    const [x1,y1] = pt('execControl','t'), [x2,y2] = pt('cpu','b');
    edges.push({ id:'e-exec-cpu', d:`M${x1},${y1} L${x2},${y2}`, color:F.info, cls:'edge-info', signal:'cpu_iowait_pct', maxVal:1 });
  }

  return edges;
}

class Diagram {
  init(svgEl) {
    this._edges = buildEdges();
    const svg = d3.select(svgEl);

    svg.append('rect').attr('width',1200).attr('height',620).attr('fill',P.black);

    // Edges
    const eg = svg.append('g');
    this._edgeEls = {};
    for (const e of this._edges) {
      this._edgeEls[e.id] = eg.append('path')
        .attr('class', e.cls)
        .attr('d', e.d)
        .attr('stroke', e.color)
        .attr('stroke-width', 1.5);
    }

    // Nodes
    const ng = svg.append('g');
    this._nodes = {};
    for (const node of NODES) {
      const g = ng.append('g').attr('id', `nd-${node.id}`);
      const bg = g.append('rect')
        .attr('x', node.x).attr('y', node.y).attr('width', node.w).attr('height', node.h)
        .attr('rx', 7).attr('fill', HBG.GREEN).attr('stroke', HBDR.GREEN).attr('stroke-width', 1.5);

      g.append('text').attr('class','node-label')
        .attr('x', node.x+7).attr('y', node.y+13)
        .attr('fill',P.gray.base).attr('font-size',10).attr('font-weight',700)
        .attr('letter-spacing','0.07em').attr('font-family',"'Euclid Circular A','Helvetica Neue',sans-serif")
        .text(node.label);

      const barY = node.y + node.h - 7;
      g.append('rect').attr('x',node.x+4).attr('y',barY-3).attr('width',node.w-8).attr('height',4).attr('rx',2).attr('fill',P.gray.dark3);
      const bar = g.append('rect').attr('x',node.x+4).attr('y',barY-3).attr('width',0).attr('height',4).attr('rx',2).attr('fill',HBDR.GREEN);

      const lineEls = node.lines.map((ln, i) =>
        g.append('text').attr('x',node.x+7).attr('y',node.y+26+i*16)
         .attr('class','node-value').attr('fill',P.gray.light2)
         .attr('font-size',11).attr('font-family',"'Source Code Pro',ui-monospace,Menlo,monospace").text('–')
      );

      this._nodes[node.id] = { g, bg, bar, barMax: node.w-8, lineEls };
    }

    svg.append('text').attr('x',600).attr('y',612).attr('text-anchor','middle')
      .attr('fill',P.gray.dark2).attr('font-size',10).attr('font-family',"'Euclid Circular A','Helvetica Neue',sans-serif")
      .text('drag timeline to seek  •  click anomaly markers to jump');
  }

  update(signals, health) {
    if (!signals || !this._nodes) return;
    const s = signals;

    for (const node of NODES) {
      const el = this._nodes[node.id];
      const h = health?.[node.id] || 'GREEN';

      el.bg.attr('fill', HBG[h]).attr('stroke', HBDR[h]);
      el.bar.attr('fill', HBDR[h]).attr('width', Math.max(0, Math.min(1, node.primary(s))) * el.barMax);
      el.g.attr('class', h === 'RED' ? 'health-red' : h === 'YELLOW' ? 'health-yellow' : '');

      node.lines.forEach((ln, i) => {
        const txt = ln.t(s) || '';
        el.lineEls[i].text(txt)
          .attr('class', ln.c?.(s) ? 'node-value crit' : ln.w?.(s) ? 'node-value warn' : 'node-value')
          .attr('fill', ln.c?.(s) ? P.red.light1 : ln.w?.(s) ? P.yellow.base : P.gray.light2);
      });
    }

    for (const e of this._edges) {
      const val = s?.[e.signal] || 0;
      this._edgeEls[e.id]?.attr('stroke-width', 1 + Math.min(1, val / e.maxVal) * 3);
    }
  }
}

window.Diagram = Diagram;
})();
