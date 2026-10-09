// 2D map of what the rover believes: a survey sheet with hillshade and contours,
// drawn only where the rover has actually looked.
import { N, SAMPLE_TYPES, SOILS, COMM_R, SENSOR_R } from './sim.js';
import { VALUE_COLORS } from './view3d.js';

const SOIL_RGB = [[154, 88, 54], [186, 138, 86], [104, 66, 47]];
const CONTOUR_M = 3;

export class Map2D {
    constructor(canvas, tip, { onCellClick }) {
        this.canvas = canvas;
        this.tip = tip;
        this.reveal = false;
        this.tool = null;
        this.ctx = canvas.getContext('2d');
        this.layer = document.createElement('canvas');
        this.hover = -1;

        canvas.addEventListener('mousemove', e => { this.hover = this.cellFromEvent(e); this.showTip(e); this.draw(); });
        canvas.addEventListener('mouseleave', () => { this.hover = -1; this.tip.hidden = true; this.draw(); });
        canvas.addEventListener('click', e => { const c = this.cellFromEvent(e); if (c >= 0) onCellClick(c); });
        new ResizeObserver(() => this.resize()).observe(canvas);
    }

    resize() {
        const css = this.canvas.clientWidth, dpr = Math.min(devicePixelRatio, 2);
        this.size = Math.round(css * dpr);
        this.canvas.width = this.canvas.height = this.size;
        this.layer.width = this.layer.height = this.size;
        this.cs = this.size / N;
        if (this.mission) { this.snap.fill(255); this.draw(); }
    }

    cellFromEvent(e) {
        const r = this.canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / r.width * N), y = Math.floor((e.clientY - r.top) / r.height * N);
        return x >= 0 && y >= 0 && x < N && y < N ? y * N + x : -1;
    }

    load(mission) {
        this.mission = mission;
        const w = mission.world, h = w.h;
        const at = (x, y) => h[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
        // Hillshade lit from the north-west
        this.shade = new Float32Array(N * N);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
            this.shade[y * N + x] = Math.min(1.3, Math.max(0.5, 0.92 + (at(x - 1, y - 1) - at(x + 1, y + 1)) * 0.07));
        // Contours by marching squares between cell centres, filed under the square's top-left cell
        this.contours = Array.from({ length: N * N }, () => []);
        for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
            const v = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
            const lo = Math.ceil(Math.min(...v) / CONTOUR_M), hi = Math.floor(Math.max(...v) / CONTOUR_M);
            for (let l = lo; l <= hi; l++) {
                const L = l * CONTOUR_M, pts = [];
                const edges = [[0, 1, [0, 0], [1, 0]], [1, 2, [1, 0], [1, 1]], [2, 3, [1, 1], [0, 1]], [3, 0, [0, 1], [0, 0]]];
                for (const [a, b, pa, pb] of edges) {
                    if ((v[a] < L) !== (v[b] < L)) {
                        const t = (L - v[a]) / (v[b] - v[a]);
                        pts.push([x + 0.5 + pa[0] + (pb[0] - pa[0]) * t, y + 0.5 + pa[1] + (pb[1] - pa[1]) * t]);
                    }
                }
                for (let i = 0; i + 1 < pts.length; i += 2) this.contours[y * N + x].push([...pts[i], ...pts[i + 1], l % 5 === 0]);
            }
        }
        this.snap = new Uint8Array(N * N).fill(255);
        this.prevPos = mission.rover.pos;
        this.heading = 0;
        this.resize();
    }

    setReveal(on) { this.reveal = on; this.snap.fill(255); this.draw(); }
    setTool(tool) { this.tool = tool; if (tool) this.canvas.dataset.tool = tool; else delete this.canvas.dataset.tool; }

    // Repaint only the terrain cells whose known/blocked state changed since last time.
    paintTerrain() {
        const { world: w, rover } = this.mission, b = rover.belief, g = this.layer.getContext('2d'), cs = this.cs;
        const dirty = [];
        for (let c = 0; c < N * N; c++) {
            const k = b.known[c] || this.reveal ? 1 : 0;
            const s = k | ((k && (this.reveal ? w.blocked[c] : b.blocked[c])) ? 2 : 0);
            if (this.snap[c] !== s) { this.snap[c] = s; dirty.push(c); }
        }
        if (!dirty.length) return;
        for (const c of dirty) {
            const x = c % N, y = Math.floor(c / N), s = this.snap[c];
            if (!(s & 1)) {
                g.fillStyle = '#120c0a';
                g.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
                g.fillStyle = '#2a1f1a';
                if ((x + y) % 2 === 0) g.fillRect(x * cs + cs * 0.4, y * cs + cs * 0.4, cs * 0.2, cs * 0.2);
                continue;
            }
            const [r, gg, bb] = SOIL_RGB[w.soilIdx[c]], k = this.shade[c];
            g.fillStyle = `rgb(${r * k | 0},${gg * k | 0},${bb * k | 0})`;
            g.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
        }
        // Contours and boulders on top of every repainted cell's neighbourhood
        const touched = new Set();
        for (const c of dirty) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = c % N + dx, y = Math.floor(c / N) + dy;
            if (x >= 0 && y >= 0 && x < N && y < N) touched.add(y * N + x);
        }
        g.lineWidth = Math.max(1, cs * 0.12);
        for (const c of touched) {
            if (!(this.snap[c] & 1)) continue;
            for (const [x1, y1, x2, y2, major] of this.contours[c]) {
                g.strokeStyle = major ? 'rgba(30,16,10,0.55)' : 'rgba(30,16,10,0.28)';
                g.beginPath(); g.moveTo(x1 * cs, y1 * cs); g.lineTo(x2 * cs, y2 * cs); g.stroke();
            }
        }
        for (const c of touched) {
            if (!(this.snap[c] & 2)) continue;
            g.fillStyle = '#2b1a12';
            g.beginPath(); g.arc((c % N + 0.5) * cs, (Math.floor(c / N) + 0.5) * cs, cs * 0.36, 0, Math.PI * 2); g.fill();
        }
    }

    draw() {
        if (!this.mission || !this.cs) return;
        const { world: w, rover } = this.mission, ctx = this.ctx, cs = this.cs;
        const cx = c => (c % N + 0.5) * cs, cy = c => (Math.floor(c / N) + 0.5) * cs;
        this.paintTerrain();
        ctx.clearRect(0, 0, this.size, this.size);
        ctx.drawImage(this.layer, 0, 0);

        for (const s of w.storms) {
            ctx.fillStyle = 'rgba(229,87,63,0.22)';
            ctx.strokeStyle = 'rgba(229,87,63,0.8)';
            ctx.lineWidth = cs * 0.15;
            ctx.beginPath(); ctx.arc((s.x + 0.5) * cs, (s.y + 0.5) * cs, s.r * cs, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); // wind direction
            ctx.moveTo((s.x + 0.5) * cs, (s.y + 0.5) * cs);
            ctx.lineTo((s.x + 0.5 + s.vx * 25) * cs, (s.y + 0.5 + s.vy * 25) * cs);
            ctx.stroke();
        }

        for (const t of w.comms) {
            if (!t.known && !this.reveal) continue;
            ctx.setLineDash(t.online ? [] : [cs * 0.6, cs * 0.4]);
            ctx.fillStyle = t.online ? 'rgba(42,158,143,0.18)' : 'rgba(229,87,63,0.12)';
            ctx.strokeStyle = t.online ? '#6cd3c3' : '#e5573f';
            ctx.lineWidth = cs * 0.22;
            ctx.beginPath(); ctx.arc(cx(t.cell), cy(t.cell), (COMM_R + 0.5) * cs, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fillRect(cx(t.cell) - cs * 0.15, cy(t.cell) - cs * 0.9, cs * 0.3, cs * 1.2); // mast
            ctx.beginPath(); ctx.arc(cx(t.cell), cy(t.cell) - cs * 0.9, cs * 0.45, Math.PI, 0); ctx.fill(); // dish
        }

        // Planned route
        const path = rover.status === 'active' ? rover.plan?.path ?? [] : [];
        if (path.length) {
            ctx.strokeStyle = rover.plan.kind === 'uplink' ? '#6cd3c3' : rover.plan.kind === 'return' ? '#f1e4d3' : '#e8a34a';
            ctx.lineWidth = Math.max(1.5, cs * 0.28);
            ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(cx(rover.pos), cy(rover.pos));
            for (const c of path) ctx.lineTo(cx(c), cy(c));
            ctx.stroke();
            const end = path.at(-1);
            ctx.lineWidth = cs * 0.2;
            ctx.beginPath(); ctx.arc(cx(end), cy(end), cs * 0.9, 0, Math.PI * 2); ctx.stroke();
        }

        for (const [c, s] of w.samples) {
            const seen = rover.knownSamples.has(c);
            if (!seen && !this.reveal) continue;
            const r = cs * [0.42, 0.55, 0.7, 0.9][s.type];
            ctx.beginPath();
            ctx.moveTo(cx(c), cy(c) - r); ctx.lineTo(cx(c) + r, cy(c)); ctx.lineTo(cx(c), cy(c) + r); ctx.lineTo(cx(c) - r, cy(c)); ctx.closePath();
            ctx.lineWidth = cs * 0.14;
            ctx.strokeStyle = '#120c0a';
            ctx.fillStyle = VALUE_COLORS[s.type];
            if (seen) { ctx.fill(); ctx.stroke(); } else { ctx.strokeStyle = VALUE_COLORS[s.type]; ctx.stroke(); }
        }

        // Lander
        ctx.fillStyle = '#f1e4d3';
        ctx.strokeStyle = '#120c0a';
        ctx.lineWidth = cs * 0.15;
        ctx.fillRect(cx(w.base) - cs * 0.6, cy(w.base) - cs * 0.6, cs * 1.2, cs * 1.2);
        ctx.strokeRect(cx(w.base) - cs * 0.6, cy(w.base) - cs * 0.6, cs * 1.2, cs * 1.2);

        // Rover: sensor range + heading triangle
        if (rover.pos !== this.prevPos) {
            this.heading = Math.atan2(Math.floor(rover.pos / N) - Math.floor(this.prevPos / N), rover.pos % N - this.prevPos % N);
            this.prevPos = rover.pos;
        }
        const range = w.storm[rover.pos] > 1 ? 3 : SENSOR_R;
        ctx.strokeStyle = 'rgba(241,228,211,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx(rover.pos), cy(rover.pos), range * cs, 0, Math.PI * 2); ctx.stroke();
        ctx.save();
        ctx.translate(cx(rover.pos), cy(rover.pos));
        ctx.rotate(this.heading);
        ctx.beginPath(); ctx.moveTo(cs * 1.1, 0); ctx.lineTo(-cs * 0.7, cs * 0.75); ctx.lineTo(-cs * 0.7, -cs * 0.75); ctx.closePath();
        ctx.fillStyle = rover.status === 'stranded' ? '#e5573f' : '#e8a34a';
        ctx.lineWidth = cs * 0.18;
        ctx.strokeStyle = '#120c0a';
        ctx.fill(); ctx.stroke();
        ctx.restore();

        if (this.hover >= 0) {
            ctx.strokeStyle = this.tool ? '#e5573f' : 'rgba(241,228,211,0.8)';
            ctx.lineWidth = 1.5;
            const r = this.tool ? { slide: 1.6, storm: 5, outage: COMM_R + 0.5 }[this.tool] * cs : cs * 0.6;
            ctx.beginPath(); ctx.arc(cx(this.hover), cy(this.hover), r, 0, Math.PI * 2); ctx.stroke();
        }
    }

    showTip(e) {
        const c = this.hover;
        if (c < 0 || !this.mission) { this.tip.hidden = true; return; }
        const { world: w, rover } = this.mission;
        const seen = rover.belief.known[c] || this.reveal;
        const lines = [`<b>${c % N}, ${Math.floor(c / N)}</b>${rover.belief.known[c] ? '' : this.reveal ? ' (rover hasn\'t seen this)' : ''}`];
        if (!seen) lines.push('Unexplored');
        else {
            lines.push(`${(this.reveal ? w.blocked[c] : rover.belief.blocked[c]) ? 'Boulders, impassable' : SOILS[w.soilIdx[c]].name}, ${Math.round(w.h[c])} m`);
            const s = w.samples.get(c);
            if (s && (rover.knownSamples.has(c) || this.reveal)) lines.push(`${SAMPLE_TYPES[s.type].name}: ${SAMPLE_TYPES[s.type].value} science, ${SAMPLE_TYPES[s.type].mb} MB`);
        }
        const zone = w.comms.find(t => (t.known || this.reveal) && Math.hypot(t.cell % N - c % N, Math.floor(t.cell / N) - Math.floor(c / N)) <= COMM_R);
        if (zone) lines.push(`Relay ${zone.id} zone${zone.online ? '' : ' (offline)'}`);
        if (w.storm[c] > 1) lines.push('Dust storm: driving costs 60% more');
        if (c === w.base) lines.push('Lander');
        if (rover.homeField && rover.homeField.dist[c] < Infinity && seen) lines.push(`About ${Math.round(rover.homeField.dist[c])} Wh to drive home from here`);
        this.tip.innerHTML = lines.join('<br>');
        this.tip.hidden = false;
        const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        this.tip.style.left = `${Math.min(x + 14, r.width - this.tip.offsetWidth - 4)}px`;
        this.tip.style.top = `${y + 16 + this.tip.offsetHeight > r.height ? y - this.tip.offsetHeight - 10 : y + 16}px`;
    }
}
