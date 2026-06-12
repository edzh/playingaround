'use strict';

(function() {

const SEV_COLOR = { WARNING: '#eab308', CRITICAL: '#ef4444' };

class Timeline {
  init(svgEl, timeRange, anomalies) {
    this._anomalies  = anomalies || [];
    this._timeRange  = timeRange;
    this._onSeek     = null;
    this._opsData    = [];
    this._cacheData  = [];

    const el    = svgEl.parentElement;
    const W     = el.clientWidth || 1200;
    const H     = 120;
    const ml = 10, mr = 10, mt = 10, mb = 22;

    this._iw = W - ml - mr;
    this._ih = H - mt - mb;

    this._xScale = d3.scaleTime()
      .domain([new Date(timeRange[0]), new Date(timeRange[1])])
      .range([0, this._iw]);

    this._opsY   = d3.scaleLinear().domain([0, 10000]).range([this._ih - 2, 2]);
    this._cacheY = d3.scaleLinear().domain([0, 1]).range([this._ih - 2, 2]);

    const svg = d3.select(svgEl).attr('width', W).attr('height', H);
    svg.append('rect').attr('width', W).attr('height', H).attr('fill', '#161b22');

    const g = svg.append('g').attr('transform', `translate(${ml},${mt})`);

    // Axis
    g.append('g').attr('class','tl-axis')
      .attr('transform', `translate(0,${this._ih})`)
      .call(
        d3.axisBottom(this._xScale).ticks(8).tickSize(-this._ih)
          .tickFormat(d => d3.timeFormat('%H:%M')(d))
      )
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('.tick line').attr('stroke','#21262d'))
      .call(ax => ax.selectAll('.tick text').attr('fill','#6b7280').attr('font-size',9).attr('font-family','ui-monospace,monospace'));

    // Sparkline legend
    g.append('rect').attr('x', this._iw - 120).attr('y', 2).attr('width', 10).attr('height', 3).attr('fill', '#3b82f6').attr('opacity', 0.7);
    g.append('text').attr('x', this._iw - 107).attr('y', 6).attr('fill','#6b7280').attr('font-size',9).attr('font-family','ui-monospace,monospace').text('ops/s');
    g.append('rect').attr('x', this._iw - 70).attr('y', 2).attr('width', 10).attr('height', 3).attr('fill', '#f97316').attr('opacity', 0.7);
    g.append('text').attr('x', this._iw - 57).attr('y', 6).attr('fill','#6b7280').attr('font-size',9).attr('font-family','ui-monospace,monospace').text('cache%');

    // Sparkline paths
    this._opsPath   = g.append('path').attr('class','sparkline').attr('stroke','#3b82f6').attr('opacity',0.7);
    this._cachePath = g.append('path').attr('class','sparkline').attr('stroke','f97316').attr('stroke','#f97316').attr('opacity',0.7);

    // Anomaly markers
    const mg = g.append('g');
    for (const ev of this._anomalies) {
      const x = this._xScale(new Date(ev.t));
      if (x < 0 || x > this._iw) continue;
      const color = SEV_COLOR[ev.severity] || '#8b949e';
      const mg2 = mg.append('g').attr('class','anomaly-marker')
        .attr('transform', `translate(${x},${this._ih})`);
      mg2.append('path')
        .attr('d', d3.symbol().type(d3.symbolTriangle).size(30)())
        .attr('fill', color)
        .attr('transform', 'rotate(180) translate(0,0)');
      mg2.append('title').text(`${new Date(ev.t).toISOString().slice(11,19)} ${ev.severity}: ${ev.description}`);
      mg2.on('click', () => this._onSeek?.(ev.t));
    }

    // Playhead
    this._playhead = g.append('line')
      .attr('class','playhead')
      .attr('y1', 0).attr('y2', this._ih + 4)
      .attr('x1', 0).attr('x2', 0);

    // Click/drag to seek
    svg.style('cursor','col-resize')
      .on('click', (event) => {
        const [mx] = d3.pointer(event);
        const x = Math.max(0, Math.min(this._iw, mx - ml));
        this._onSeek?.(this._xScale.invert(x).getTime());
      });

    this._lineGen = d3.line().x(d => d.x).y(d => d.y).curve(d3.curveMonotoneX);
    this._g = g;
  }

  onSeek(cb) { this._onSeek = cb; }

  update(t, signals) {
    if (!this._xScale || !signals) return;
    const x = this._xScale(new Date(t));
    if (x >= 0 && x <= this._iw) {
      this._playhead.attr('x1', x).attr('x2', x);
    }

    this._opsData.push({ x, y: this._opsY(Math.min(10000, signals.total_ops_rate || 0)) });
    this._cacheData.push({ x, y: this._cacheY(Math.min(1, signals.cache_fill_pct || 0)) });
    if (this._opsData.length > 400)   { this._opsData.shift();   this._cacheData.shift(); }

    this._opsPath.attr('d',   this._lineGen(this._opsData)   || '');
    this._cachePath.attr('d', this._lineGen(this._cacheData) || '');
  }
}

window.Timeline = Timeline;
})();
