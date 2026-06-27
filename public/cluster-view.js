'use strict';

(function() {

const ROLE_BADGE = window.LG.role;
const HCOLOR = {
  GREEN:  window.LG.health.GREEN.border,
  YELLOW: window.LG.health.YELLOW.border,
  RED:    window.LG.health.RED.border,
};
const SHARD_COLORS = window.LG.series;
const LGP = window.LG.palette;

function fmt(n) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toString();
}

function worstHealth(h) {
  const vals = Object.values(h || {});
  if (vals.includes('RED')) return 'RED';
  if (vals.includes('YELLOW')) return 'YELLOW';
  return 'GREEN';
}

// Gauge spec per card: label, signal key, max for bar scaling, formatter
const GAUGES = [
  { label: 'ops/s', key: 'total_ops_rate',  max: 8000, fmt: s => fmt(s.total_ops_rate) },
  { label: 'cache', key: 'cache_fill_pct',  max: 1,    fmt: s => Math.round((s.cache_fill_pct || 0) * 100) + '%' },
  { label: 'cpu',   key: '_cpu',            max: 1,    fmt: s => Math.round((1 - (s.cpu_idle_pct ?? 1)) * 100) + '%',
    val: s => 1 - (s.cpu_idle_pct ?? 1) },
  { label: 'disk w', key: 'disk_write_mbps', max: 500, fmt: s => fmt(s.disk_write_mbps) + ' MB/s' },
];

class ClusterView {
  // hosts: [{ label, role }]
  init(containerEl, hosts) {
    this._container = containerEl;
    this._hosts = hosts;
    this._cards = {};
    this._expanded = null;     // label of host in drill-down
    this._diagram = null;
    this._lastData = null;

    containerEl.innerHTML = '';

    // ── Shard balance bar ──
    const balWrap = document.createElement('div');
    balWrap.className = 'balance-wrap';
    balWrap.innerHTML = '<div class="balance-title">SHARD LOAD BALANCE (ops/s share)</div>';
    const bal = document.createElement('div');
    bal.className = 'balance-bar';
    balWrap.appendChild(bal);
    containerEl.appendChild(balWrap);

    this._balSegs = {};
    const shards = hosts.filter(h => h.role === 'shardsvr' || h.role === 'replset' || h.role === 'standalone');
    this._shardLabels = shards.map(h => h.label);
    shards.forEach((h, i) => {
      const seg = document.createElement('div');
      seg.className = 'balance-seg';
      seg.style.background = SHARD_COLORS[i % SHARD_COLORS.length];
      seg.style.width = (100 / shards.length) + '%';
      seg.innerHTML = `<span>${h.label.split('/')[0]}</span>`;
      bal.appendChild(seg);
      this._balSegs[h.label] = seg;
    });

    // ── Host cards ──
    const grid = document.createElement('div');
    grid.className = 'host-grid';
    containerEl.appendChild(grid);

    for (const h of hosts) {
      const badge = ROLE_BADGE[h.role] || ROLE_BADGE.standalone;
      const card = document.createElement('div');
      card.className = 'host-card';
      card.innerHTML = `
        <div class="host-card-head">
          <span class="role-badge" style="background:${badge.bg};color:${badge.fg}">${badge.txt}</span>
          <span class="host-label">${h.label}</span>
          <span class="host-expand">⤢</span>
        </div>
        <div class="gauges">${GAUGES.map(g => `
          <div class="gauge" data-g="${g.key}">
            <div class="gauge-top"><span class="gauge-label">${g.label}</span><span class="gauge-val">–</span></div>
            <div class="gauge-track"><div class="gauge-fill"></div></div>
          </div>`).join('')}
        </div>`;
      card.addEventListener('click', () => this._expand(h));
      grid.appendChild(card);

      this._cards[h.label] = {
        el: card,
        gauges: GAUGES.map((g, i) => {
          const gel = card.querySelectorAll('.gauge')[i];
          return { spec: g, val: gel.querySelector('.gauge-val'), fill: gel.querySelector('.gauge-fill') };
        }),
      };
    }

    // ── Drill-down overlay (built once, shown on demand) ──
    const overlay = document.createElement('div');
    overlay.className = 'drill-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="drill-head">
        <span class="drill-title"></span>
        <button class="drill-close">✕ Close</button>
      </div>
      <svg class="drill-svg" viewBox="0 0 1200 620" preserveAspectRatio="xMidYMid meet"></svg>`;
    overlay.querySelector('.drill-close').addEventListener('click', e => {
      e.stopPropagation();
      this._collapse();
    });
    containerEl.appendChild(overlay);
    this._overlay = overlay;
  }

  _expand(host) {
    this._expanded = host.label;
    this._overlay.querySelector('.drill-title').textContent = host.label;
    const svg = this._overlay.querySelector('.drill-svg');
    svg.innerHTML = '';
    this._diagram = new Diagram();
    this._diagram.init(svg);
    this._overlay.style.display = 'flex';
    // Paint immediately with last known data instead of waiting for next tick
    const hd = this._lastData?.[host.label];
    if (hd) this._diagram.update(hd.m, hd.h);
  }

  _collapse() {
    this._expanded = null;
    this._diagram = null;
    this._overlay.style.display = 'none';
  }

  // hostsData: { label: { m: signals, h: health } }
  update(hostsData) {
    if (!hostsData) return;
    this._lastData = hostsData;

    let opsTotal = 0;
    const opsBy = {};
    for (const label of this._shardLabels) {
      const ops = hostsData[label]?.m?.total_ops_rate || 0;
      opsBy[label] = ops;
      opsTotal += ops;
    }

    for (const [label, seg] of Object.entries(this._balSegs)) {
      const share = opsTotal > 0 ? opsBy[label] / opsTotal : 1 / this._shardLabels.length;
      seg.style.width = Math.max(3, share * 100) + '%';
    }

    for (const h of this._hosts) {
      const card = this._cards[h.label];
      const hd = hostsData[h.label];
      if (!card || !hd) continue; // gap in this host's data — keep last state

      card.el.style.borderColor = HCOLOR[worstHealth(hd.h)];
      card.el.classList.toggle('card-red', worstHealth(hd.h) === 'RED');

      for (const g of card.gauges) {
        const s = hd.m;
        const raw = g.spec.val ? g.spec.val(s) : (s[g.spec.key] || 0);
        g.val.textContent = g.spec.fmt(s);
        const pct = Math.max(0, Math.min(1, raw / g.spec.max));
        g.fill.style.width = (pct * 100) + '%';
        g.fill.style.background = pct > 0.9 ? LGP.red.light1 : pct > 0.7 ? LGP.yellow.base : LGP.blue.light1;
      }
    }

    if (this._expanded && this._diagram && hostsData[this._expanded]) {
      const hd = hostsData[this._expanded];
      this._diagram.update(hd.m, hd.h);
    }
  }
}

window.ClusterView = ClusterView;
})();
