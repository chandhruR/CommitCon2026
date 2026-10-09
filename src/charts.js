// Small SVG charts: live telemetry over time and grouped bars for the benchmark.
// Thin marks, recessive grid, a legend plus hover tooltips; colours come from validated pairs.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent?.appendChild(n);
    return n;
};
const niceStep = max => {
    const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f > 5 ? 10 : f > 2 ? 5 : f > 1 ? 2 : 1) * mag;
};

function legend(host, series) {
    const div = document.createElement('div');
    div.className = 'chart-legend';
    for (const s of series) {
        const span = document.createElement('span');
        span.innerHTML = `<i class="${s.dash ? 'dash' : ''}" style="background:${s.color}"></i>${s.label}`;
        div.appendChild(span);
    }
    host.appendChild(div);
}

function tooltip(host) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.appendChild(tip);
    return tip;
}

function placeTip(host, tip, x, y) {
    tip.hidden = false;
    const w = host.clientWidth;
    tip.style.left = `${Math.min(Math.max(0, x + 12), w - tip.offsetWidth)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
}

// Time series. `stacked` stacks the series as areas (bottom first); otherwise lines.
export class TimeChart {
    constructor(host, { series, stacked = false, unit = '', height = 118 }) {
        Object.assign(this, { host, series, stacked, unit, height });
        this.svg = el('svg', { height, role: 'img' }, host);
        this.gGrid = el('g', {}, this.svg);
        this.gMarks = el('g', {}, this.svg);
        this.gLabels = el('g', {}, this.svg);
        this.cross = el('line', { class: 'crosshair', visibility: 'hidden' }, this.svg);
        this.dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: '#201713', 'stroke-width': 2, visibility: 'hidden' }, this.svg));
        this.hit = el('rect', { fill: 'transparent' }, this.svg);
        legend(host, series);
        this.tip = tooltip(host);
        this.hit.addEventListener('mousemove', e => { this.hoverX = e.clientX - this.svg.getBoundingClientRect().left - this.m.l; this.drawHover(); });
        this.hit.addEventListener('mouseleave', () => { this.hoverX = null; this.drawHover(); });
    }

    update(data, yMax) {
        this.data = data;
        const W = this.host.clientWidth || 340, H = this.height, m = { l: 34, r: 6, t: 8, b: 18 };
        this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const n = data[this.series[0].key].length;
        const xMax = Math.max(100, n - 1);
        const x = i => m.l + (i / xMax) * (W - m.l - m.r);
        const y = v => H - m.b - (v / yMax) * (H - m.t - m.b);
        Object.assign(this, { W, m, x, y, xMax, n });

        this.gGrid.replaceChildren();
        const step = niceStep(yMax);
        for (let v = 0; v <= yMax + 1e-9; v += step) {
            el('line', { class: v === 0 ? 'baseline' : 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, this.gGrid);
            el('text', { class: 'tick-label', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, this.gGrid).textContent = v;
        }
        el('text', { class: 'tick-label', x: W - m.r, y: H - 4, 'text-anchor': 'end' }, this.gGrid).textContent = `tick ${n - 1}`;

        this.gMarks.replaceChildren();
        this.gLabels.replaceChildren();
        const stack = new Float64Array(n);
        const labels = [];
        for (const s of this.series) {
            const vals = data[s.key];
            if (this.stacked) {
                const top = [], bottom = [];
                for (let i = 0; i < n; i++) { bottom.push(`${x(i)},${y(stack[i])}`); stack[i] += vals[i]; top.push(`${x(i)},${y(stack[i])}`); }
                el('polygon', { points: [...top, ...bottom.reverse()].join(' '), fill: s.color, 'fill-opacity': 0.85 }, this.gMarks);
                el('polyline', { points: top.join(' '), fill: 'none', stroke: '#201713', 'stroke-width': 2 }, this.gMarks); // surface gap
                labels.push({ s, v: vals[n - 1], y: y(stack[n - 1] - vals[n - 1] / 2) });
            } else {
                const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
                el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash ? '5 4' : 'none', 'stroke-linejoin': 'round' }, this.gMarks);
                labels.push({ s, v: vals[n - 1], y: y(vals[n - 1]) - 7 });
            }
        }
        // Direct labels at the current end of each series, nudged apart if they collide
        labels.sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
        const lx = Math.min(x(n - 1) + 4, W - m.r);
        for (const l of labels) {
            if (this.stacked && l.v <= 0) continue;
            const t = el('text', { class: 'series-label', x: lx, y: Math.max(m.t + 10, Math.min(H - m.b - 2, l.y)), 'text-anchor': lx > W - 90 ? 'end' : 'start' }, this.gLabels);
            t.textContent = `${l.s.short ?? l.s.label} ${Math.round(l.v)}`;
        }
        this.hit.setAttribute('x', m.l);
        this.hit.setAttribute('y', 0);
        this.hit.setAttribute('width', W - m.l - m.r);
        this.hit.setAttribute('height', H);
        this.drawHover();
    }

    drawHover() {
        if (this.hoverX == null || !this.data) {
            this.cross.setAttribute('visibility', 'hidden');
            this.dots.forEach(d => d.setAttribute('visibility', 'hidden'));
            this.tip.hidden = true;
            return;
        }
        const i = Math.max(0, Math.min(this.n - 1, Math.round((this.hoverX / (this.W - this.m.l - this.m.r)) * this.xMax)));
        const px = this.x(i);
        Object.entries({ x1: px, x2: px, y1: this.m.t, y2: this.height - this.m.b, visibility: 'visible' }).forEach(([k, v]) => this.cross.setAttribute(k, v));
        let acc = 0;
        const rows = this.series.map((s, j) => {
            const v = this.data[s.key][i];
            acc += this.stacked ? v : 0;
            const d = this.dots[j];
            d.setAttribute('cx', px);
            d.setAttribute('cy', this.y(this.stacked ? acc : v));
            d.setAttribute('visibility', 'visible');
            return `<div><i style="background:${s.color}"></i>${s.label} <b>${Math.round(v)}${this.unit}</b></div>`;
        });
        this.tip.innerHTML = `<div>Tick ${i}</div>${rows.join('')}`;
        placeTip(this.host, this.tip, px, this.m.t + 10);
    }
}

// Grouped bars: one group per category, one bar per series. Bars grow from the baseline with a
// rounded data end and a 2px gap between neighbours.
export function groupedBars(host, { groups, series, max, unit = '', height = 190 }) {
    host.replaceChildren();
    const W = host.clientWidth || 520, H = height, m = { l: 34, r: 4, t: 10, b: 34 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' }, host);
    const y = v => H - m.b - (v / max) * (H - m.t - m.b);
    const step = niceStep(max);
    for (let v = 0; v <= max + 1e-9; v += step) {
        el('line', { class: v === 0 ? 'baseline' : 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
        el('text', { class: 'tick-label', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = `${v}${unit}`;
    }
    const gw = (W - m.l - m.r) / groups.length, bw = Math.min(26, (gw * 0.7) / series.length);
    const tip = tooltip(host);
    groups.forEach((g, gi) => {
        const x0 = m.l + gi * gw + (gw - bw * series.length - 2 * (series.length - 1)) / 2;
        g.values.forEach((v, si) => {
            const x = x0 + si * (bw + 2), top = y(v), h = Math.max(0, H - m.b - top), r = Math.min(4, h, bw / 2);
            const d = `M${x},${H - m.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - m.b} Z`;
            const bar = el('path', { d, fill: series[si].color }, svg);
            const hit = el('rect', { x: x - 1, y: m.t, width: bw + 2, height: H - m.t - m.b, fill: 'transparent' }, svg);
            hit.addEventListener('mouseenter', () => {
                bar.setAttribute('fill-opacity', 0.8);
                tip.innerHTML = `<div>${g.label}</div><div><i style="background:${series[si].color}"></i>${series[si].label} <b>${Math.round(v)}${unit}</b></div>`;
                placeTip(host, tip, x, top);
            });
            hit.addEventListener('mouseleave', () => { bar.setAttribute('fill-opacity', 1); tip.hidden = true; });
        });
        el('text', { class: 'tick-label', x: m.l + gi * gw + gw / 2, y: H - m.b + 15, 'text-anchor': 'middle' }, svg).textContent = g.label;
    });
    legend(host, series);
}
