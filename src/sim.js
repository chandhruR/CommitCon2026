// Lost in Space: simulation core. Pure JS with no DOM, so the 3D app, the benchmark worker and
// the Node test all run exactly this code.

export const N = 48;              // the map is N x N cells
export const CELL_M = 10;         // metres per cell
export const BATTERY_WH = 380;
export const STORAGE_MB = 80;
export const SENSOR_R = 6;        // cells, line of sight from the mast camera
export const COMM_R = 3;          // uplink zone radius around a relay tower
export const COMM_DETECT_R = COMM_R + 6;
export const MAX_TICKS = 2500;

const STORM_SENSOR_R = 3;
const STORM_COST = 1.6;           // driving through a dust storm costs 60% more
const UNKNOWN_SOIL = 1.4;         // unexplored ground is priced as "probably a bit rough"
const CLIMB_WH_PER_M = 0.5;
const CLIFF_M = 3.5;              // steeper than this between neighbouring cells is impassable
const MAST_M = 2;
const DRILL_TICKS = 3;
const DRILL_WH = 3;
const UPLINK_MB_PER_TICK = 10;
const UPLINK_WH_PER_TICK = 0.6;
const REPLAN_EVERY = 6;

// Smart planner knobs, tuned with test/sim.test.mjs (exported so the benchmark can sweep them).
export const TUNE = {
    riskCap: 100,        // unsent science the rover will carry before detouring to secure it
    storageFrac: 0.6,    // uplink once storage is this full
    reserveBase: 0.04,   // safety reserve: fraction of battery...
    reserveFrac: 0.12,   // ...plus a fraction of the remaining route home (uncertainty grows with distance)
    exploreWeight: 0.5,  // discount on the science we only expect to find by exploring
    unknownHomeCost: 2.6, // Wh per cell assumed for unexplored ground on the way home (about a rock field)
    returnWeight: 0,     // weight of the extra drive home in a target's cost. 0 wins: getting home is already a hard
                         // constraint, and charging it per step double-counts and keeps the rover near the lander
};

export const SOILS = [
    { name: 'Plains', cost: 1.0 },
    { name: 'Dune sand', cost: 1.7 },
    { name: 'Rock field', cost: 2.3 },
];

export const SAMPLE_TYPES = [
    { name: 'Regolith core', value: 10, mb: 8, count: 8 },
    { name: 'Mineral vein', value: 25, mb: 14, count: 6 },
    { name: 'Subsurface ice', value: 50, mb: 22, count: 4 },
    { name: 'Biosignature', value: 120, mb: 30, count: 2 },
];

// Each scenario is a fixed seed plus how often the planet throws problems at the rover.
export const SCENARIOS = {
    standard: { name: 'Standard survey', seed: 1207, comms: 3, craters: 3, every: 60, mix: { slide: 0.45, storm: 0.35, outage: 0.2 },
        blurb: 'A balanced map. Three relay towers, a few craters, the occasional surprise.' },
    crater: { name: 'Crater jackpot', seed: 4242, comms: 3, craters: 2, bigCrater: true, every: 70, mix: { slide: 0.4, storm: 0.4, outage: 0.2 },
        blurb: 'A biosignature sits on the floor of a deep crater. Worth 120 science, if the rover can afford the climb back out.' },
    blackout: { name: 'Comm blackout', seed: 3141, comms: 2, craters: 3, every: 45, mix: { slide: 0.2, storm: 0.2, outage: 0.6 },
        blurb: 'Only two relay towers, and they keep dropping offline. Data is worthless until it is sent.' },
    rockslide: { name: 'Rockslide alley', seed: 777, comms: 3, craters: 4, every: 28, mix: { slide: 0.8, storm: 0.1, outage: 0.1 },
        blurb: 'Unstable slopes. Routes the rover already knows keep getting buried.' },
    dust: { name: 'Dust season', seed: 2024, comms: 3, craters: 3, every: 35, mix: { slide: 0.1, storm: 0.8, outage: 0.1 },
        blurb: 'Roaming dust storms blind the cameras, slow the wheels and halve uplink speed.' },
};

// ---------- grid helpers ----------

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const LEN = DX.map((dx, k) => Math.hypot(dx, DY[k]));
const NB = new Int32Array(N * N * 8);
for (let i = 0; i < N * N; i++) {
    for (let k = 0; k < 8; k++) {
        const x = (i % N) + DX[k], y = Math.floor(i / N) + DY[k];
        NB[i * 8 + k] = x < 0 || y < 0 || x >= N || y >= N ? -1 : y * N + x;
    }
}

export const xy = c => [c % N, Math.floor(c / N)];
export const cellAt = (x, y) => y * N + x;
export const fmt = c => `(${c % N}, ${Math.floor(c / N)})`;
const dist = (a, b) => Math.hypot((a % N) - (b % N), Math.floor(a / N) - Math.floor(b / N));
const inside = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

function disc(r) {
    const out = [];
    for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
            if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
    return out;
}
const SENSOR_DISC = disc(SENSOR_R);
const STORM_SENSOR_DISC = disc(STORM_SENSOR_R);

// Seeded PRNG so every map, event and benchmark is reproducible.
export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Fractal value noise in [0, 1].
function fbm(rand, periods) {
    const out = new Float32Array(N * N);
    const smooth = t => t * t * (3 - 2 * t);
    let amp = 1;
    for (const p of periods) {
        const g = Math.ceil(N / p) + 2;
        const lattice = Float32Array.from({ length: g * g }, rand);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const fx = x / p, fy = y / p, ix = Math.floor(fx), iy = Math.floor(fy);
                const tx = smooth(fx - ix), ty = smooth(fy - iy);
                const a = lattice[iy * g + ix], b = lattice[iy * g + ix + 1];
                const c = lattice[(iy + 1) * g + ix], d = lattice[(iy + 1) * g + ix + 1];
                out[y * N + x] += amp * (a + (b - a) * tx + (c + (d - c) * tx - a - (b - a) * tx) * ty);
            }
        }
        amp *= 0.5;
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo);
    return out;
}

// ---------- terrain costs & shortest paths ----------
// A "model" is a terrain as some observer sees it: { h, soil, blocked, known, storm }.
// The world is the truth (known everywhere); each rover keeps its own belief model.

function edgeCost(m, a, b, k) {
    if (m.blocked[a] || m.blocked[b]) return Infinity;
    if (k >= 4 && (m.blocked[a + DX[k]] || m.blocked[a + DY[k] * N])) return Infinity; // no corner cutting
    let climb = 0;
    if (m.known[a] && m.known[b]) {
        const dh = m.h[b] - m.h[a];
        if (dh > CLIFF_M || dh < -CLIFF_M) return Infinity;
        if (dh > 0) climb = dh * CLIMB_WH_PER_M;
    }
    return LEN[k] * m.soil[b] * m.storm[b] + climb;
}

const heapK = new Float64Array(N * N * 9);
const heapV = new Int32Array(N * N * 9);

// Dijkstra from seeds [[cell, startCost], ...]. Forward: cost to reach each cell from the seeds.
// Reverse: cost from each cell to reach the seeds, with prev pointing one step closer to them.
export function dijkstra(m, seeds, reverse = false) {
    const D = new Float64Array(N * N).fill(Infinity);
    const prev = new Int32Array(N * N).fill(-1);
    let n = 0;
    const push = (key, v) => {
        let i = n++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heapK[p] <= key) break;
            heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p;
        }
        heapK[i] = key; heapV[i] = v;
    };
    for (const [c, d] of seeds) if (d < D[c]) { D[c] = d; push(d, c); }
    while (n) {
        const d = heapK[0], u = heapV[0];
        const key = heapK[--n], val = heapV[n];
        for (let i = 0; ;) {
            let c = 2 * i + 1;
            if (c >= n) { heapK[i] = key; heapV[i] = val; break; }
            if (c + 1 < n && heapK[c + 1] < heapK[c]) c++;
            if (heapK[c] >= key) { heapK[i] = key; heapV[i] = val; break; }
            heapK[i] = heapK[c]; heapV[i] = heapV[c]; i = c;
        }
        if (d > D[u]) continue;
        for (let k = 0; k < 8; k++) {
            const v = NB[u * 8 + k];
            if (v < 0) continue;
            const c = reverse ? edgeCost(m, v, u, OPP[k]) : edgeCost(m, u, v, k);
            if (c === Infinity) continue;
            if (d + c < D[v]) { D[v] = d + c; prev[v] = u; push(d + c, v); }
        }
    }
    return { dist: D, prev };
}

const trace = (F, target) => { const p = []; for (let c = target; F.prev[c] !== -1; c = F.prev[c]) p.push(c); return p.reverse(); };
const follow = (R, from) => { const p = []; for (let c = R.prev[from]; c !== -1; c = R.prev[c]) p.push(c); return p; };
const dirIndex = (a, b) => { for (let k = 0; k < 8; k++) if (NB[a * 8 + k] === b) return k; return -1; };

// ---------- world generation ----------

export function createWorld(scn, seed) {
    const rand = rng(seed);
    const h = fbm(rand, [24, 12, 6, 3]);
    for (let i = 0; i < h.length; i++) h[i] *= 26;
    const soilNoise = fbm(rand, [16, 8, 4]);
    const craterFloor = new Uint8Array(N * N);

    const pick = (test, tries = 4000) => {
        for (let t = 0; t < tries; t++) {
            const c = Math.floor(rand() * N * N);
            if (test(c)) return c;
        }
        return -1;
    };
    const slope = c => {
        let s = 0;
        for (let k = 0; k < 8; k++) { const v = NB[c * 8 + k]; if (v >= 0) s = Math.max(s, Math.abs(h[v] - h[c])); }
        return s;
    };

    const center = cellAt(N >> 1, N >> 1);

    const crater = (cx, cy, R, depth) => {
        for (let y = Math.max(0, Math.floor(cy - R * 1.6)); y < Math.min(N, cy + R * 1.6); y++) {
            for (let x = Math.max(0, Math.floor(cx - R * 1.6)); x < Math.min(N, cx + R * 1.6); x++) {
                const d = Math.hypot(x - cx, y - cy) / R;
                const c = cellAt(x, y);
                if (d < 1) { h[c] -= depth * (1 - d * d); if (d < 0.55) craterFloor[c] = 1; }
                h[c] += depth * 0.35 * Math.exp(-(((d - 1) / 0.25) ** 2)) * (0.75 + 0.5 * rand());
            }
        }
    };
    for (let i = 0; i < scn.craters; i++) {
        const c = pick(c => dist(c, center) > 11);
        crater(c % N, Math.floor(c / N), 3 + rand() * 4, 6 + rand() * 6);
    }
    let bigCrater = -1;
    if (scn.bigCrater) {
        bigCrater = pick(c => { const d = dist(c, center); const [x, y] = xy(c); return d > 13 && d < 17 && x > 9 && y > 9 && x < N - 10 && y < N - 10; });
        crater(bigCrater % N, Math.floor(bigCrater / N), 8, 19);
    }

    // Landing site: gentle ground near the middle, inside a large connected region
    let base = -1;
    const flat = { h, soil: new Float32Array(N * N).fill(1), blocked: new Uint8Array(N * N), known: new Uint8Array(N * N).fill(1), storm: new Float32Array(N * N).fill(1) };
    for (let tries = 0; tries < 30; tries++) {
        base = pick(c => dist(c, center) < 8 && slope(c) < 1.2);
        if (base < 0) base = pick(c => dist(c, center) < 8);
        if (dijkstra(flat, [[base, 0]]).dist.filter(d => d < Infinity).length > N * N * 0.7) break;
    }

    const soilIdx = new Uint8Array(N * N);
    const soil = new Float32Array(N * N);
    const blocked = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) {
        soilIdx[c] = soilNoise[c] > 0.66 ? 1 : soilNoise[c] < 0.3 || slope(c) > 2.6 ? 2 : 0;
        soil[c] = SOILS[soilIdx[c]].cost;
        const boulderOdds = [0.025, 0.008, 0.11][soilIdx[c]];
        if (dist(c, base) > 2.5 && rand() < boulderOdds) blocked[c] = 1;
    }
    for (let c = 0; c < N * N; c++) if (dist(c, base) <= 1.5) { blocked[c] = 0; soilIdx[c] = 0; soil[c] = 1; }

    const world = {
        scn, seed, h, soil, soilIdx, blocked, craterFloor, base, bigCrater,
        known: new Uint8Array(N * N).fill(1),
        storm: new Float32Array(N * N).fill(1),
        comms: [], samples: new Map(), storms: [], tick: 0, version: 0,
        eventRand: rng(seed ^ 0x5bd1e995),
    };

    let reach = dijkstra(world, [[base, 0]]).dist;
    const ok = c => !blocked[c] && reach[c] < Infinity && !world.samples.has(c) && !world.comms.some(t => t.cell === c);

    // Relay towers: spread out around the landing site, on flat reachable ground
    for (let i = 0; i < scn.comms; i++) {
        const angle = (i / scn.comms) * Math.PI * 2 + rand() * 1.2;
        let best = -1;
        for (let r = 13; r <= 21 && best < 0; r++) {
            for (let a = 0; a < 12 && best < 0; a++) {
                const x = Math.round(base % N + Math.cos(angle + a * 0.15) * r), y = Math.round(Math.floor(base / N) + Math.sin(angle + a * 0.15) * r);
                if (inside(x, y) && ok(cellAt(x, y)) && slope(cellAt(x, y)) < 2) best = cellAt(x, y);
            }
        }
        if (best < 0) best = pick(c => ok(c) && dist(c, base) > 10);
        world.comms.push({ id: i + 1, cell: best, online: true, outage: 0, known: false });
    }

    // Samples: the most valuable ones live in the hardest places
    const ranked = (score) => {
        const cells = [];
        for (let c = 0; c < N * N; c++) if (ok(c) && dist(c, base) > 5) cells.push([c, score(c)]);
        return cells.sort((a, b) => b[1] - a[1]).map(([c]) => c);
    };
    const place = (type, score, poolFrac) => {
        const pool = ranked(score);
        const top = pool.slice(0, Math.max(8, Math.floor(pool.length * poolFrac)));
        for (let tries = 0; tries < 50; tries++) {
            const c = top[Math.floor(rand() * top.length)];
            if (ok(c) && [...world.samples.keys()].every(o => dist(o, c) > 3)) { world.samples.set(c, { type, cell: c }); return; }
        }
    };
    const hMin = Math.min(...h), hMax = Math.max(...h);
    for (let i = 0; i < SAMPLE_TYPES[3].count; i++) {
        if (i === 0 && bigCrater >= 0) {
            place(3, c => (craterFloor[c] ? 100 : 0) - dist(c, bigCrater), 0.002);
        } else {
            place(3, c => (craterFloor[c] ? 2 : 0) + Math.abs(h[c] - (hMin + hMax) / 2) / 8 + dist(c, base) / 20, 0.04);
        }
    }
    for (let i = 0; i < SAMPLE_TYPES[2].count; i++) place(2, c => -h[c] + (craterFloor[c] ? 6 : 0), 0.12);
    for (let i = 0; i < SAMPLE_TYPES[1].count; i++) place(1, c => (soilIdx[c] === 2 ? 1 : 0) + rand() * 0.5, 0.3);
    for (let i = 0; i < SAMPLE_TYPES[0].count; i++) place(0, c => (soilIdx[c] === 0 ? 1 : 0) + rand(), 0.6);

    return world;
}

function rebuildStorms(world) {
    world.storm.fill(1);
    for (const s of world.storms) {
        for (let y = Math.max(0, Math.floor(s.y - s.r)); y <= Math.min(N - 1, s.y + s.r); y++)
            for (let x = Math.max(0, Math.floor(s.x - s.r)); x <= Math.min(N - 1, s.x + s.r); x++)
                if (Math.hypot(x - s.x, y - s.y) <= s.r) world.storm[cellAt(x, y)] = STORM_COST;
    }
}

export const inStorm = (world, c) => world.storm[c] > 1;
export const zoneOf = (world, c) => world.comms.find(t => t.online && dist(t.cell, c) <= COMM_R);

// ---------- the rover ----------

export class Rover {
    constructor(world, strategy, say) {
        this.strategy = strategy;
        this.say = say;
        this.pos = world.base;
        this.energy = BATTERY_WH;
        this.cargo = [];           // [{ type, value, mb, left }]
        this.uplinked = 0;
        this.uplinkedByType = [0, 0, 0, 0];
        this.collectedByType = [0, 0, 0, 0];
        this.used = { drive: 0, climb: 0, drill: 0, uplink: 0 };
        this.status = 'active';    // active | docked | stranded
        this.plan = null;          // { kind, cell, path, reason, options }
        this.sinceReplan = 0;
        this.seenVersion = -1;
        this.drilling = 0;
        this.distance = 0;
        this.replans = 0;
        this.routesBlocked = 0;
        this.stormTicks = 0;
        this.homeField = null;
        this.discoveredValue = 0;
        this.knownCount = 0;
        this.knownSamples = new Set();
        this.belief = {
            h: new Float32Array(N * N), soil: new Float32Array(N * N).fill(UNKNOWN_SOIL),
            blocked: new Uint8Array(N * N), known: new Uint8Array(N * N), storm: world.storm,
        };
        this.reveal(world, world.base);
        this.sense(world);
    }

    get mb() { return this.cargo.reduce((s, d) => s + d.left, 0); }
    get carried() { return this.cargo.reduce((s, d) => s + d.value, 0); }
    get explored() { return this.knownCount / (N * N); }

    reveal(world, c) {
        const b = this.belief;
        if (b.known[c]) {
            if (world.blocked[c] && !b.blocked[c]) { b.blocked[c] = 1; return 'buried'; } // rockslide on known ground
            return null;
        }
        b.known[c] = 1;
        b.h[c] = world.h[c];
        b.soil[c] = world.soil[c];
        b.blocked[c] = world.blocked[c];
        this.knownCount++;
        if (world.samples.has(c)) {
            this.knownSamples.add(c);
            const t = SAMPLE_TYPES[world.samples.get(c).type];
            this.discoveredValue += t.value;
            this.say(`Spotted ${t.name.toLowerCase()} at ${fmt(c)}, worth ${t.value} science.`, 'info');
            return 'sample';
        }
        return 'new';
    }

    // Line of sight from the mast camera: hills hide what is behind them.
    sense(world) {
        const [x0, y0] = xy(this.pos);
        const eye = world.h[this.pos] + MAST_M;
        const changes = { buried: [], found: false };
        for (const [dx, dy] of inStorm(world, this.pos) ? STORM_SENSOR_DISC : SENSOR_DISC) {
            const x = x0 + dx, y = y0 + dy;
            if (!inside(x, y)) continue;
            const c = cellAt(x, y);
            if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) {
                const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2, target = world.h[c] + 0.5;
                let seen = true;
                for (let s = 1; s < steps && seen; s++) {
                    const t = s / steps;
                    if (world.h[cellAt(Math.round(x0 + dx * t), Math.round(y0 + dy * t))] > eye + (target - eye) * t) seen = false;
                }
                if (!seen) continue;
            }
            const r = this.reveal(world, c);
            if (r === 'buried') changes.buried.push(c);
            if (r === 'sample') changes.found = true;
        }
        for (const t of world.comms) {
            if (!t.known && dist(t.cell, this.pos) <= COMM_DETECT_R) {
                t.known = true;
                changes.found = true;
                this.say(`Picked up relay tower ${t.id}'s beacon at ${fmt(t.cell)}. Uplink zone located.`, 'good');
            }
        }
        return changes;
    }

    spend(kind, wh) {
        this.used[kind] += wh;
        this.energy -= wh;
        if (this.energy <= 0) {
            this.energy = 0;
            this.status = 'stranded';
        }
    }

    step(world) {
        if (this.status !== 'active') return;
        const changes = this.sense(world);
        if (inStorm(world, this.pos)) this.stormTicks++;

        if (this.drilling > 0) {
            if (--this.drilling === 0) {
                const s = world.samples.get(this.pos), t = SAMPLE_TYPES[s.type];
                world.samples.delete(this.pos);
                this.knownSamples.delete(this.pos);
                this.cargo.push({ type: s.type, value: t.value, mb: t.mb, left: t.mb });
                this.cargo.sort((a, b) => b.value / b.mb - a.value / a.mb);
                this.collectedByType[s.type]++;
                this.say(`Collected ${t.name.toLowerCase()}. ${this.carried} science on board, not yet sent.`, 'good');
                this.plan = null;
            }
            return;
        }

        if (this.plan?.kind === 'uplink' && !this.plan.path.length && this.cargo.length && zoneOf(world, this.pos)) {
            this.transmit(world);
            return;
        }

        // Has anything made the current route impossible?
        let broken = null;
        if (this.plan) {
            let a = this.pos;
            for (const c of this.plan.path) {
                if (edgeCost(this.belief, a, c, dirIndex(a, c)) === Infinity) { broken = c; break; }
                a = c;
            }
        }
        if (broken !== null) {
            this.replans++;
            const known = changes.buried.some(c => dist(c, broken) < 1.5); // a slide on ground it had already mapped
            if (known) this.routesBlocked++;
            this.say(known
                ? `Rockslide buried the planned route at ${fmt(broken)}. Rerouting.`
                : `New scan shows the route is blocked at ${fmt(broken)}. Rerouting.`, 'warn');
        }

        const arrived = this.plan && !this.plan.path.length;
        if (!this.plan || broken !== null || arrived || changes.found || world.version !== this.seenVersion || this.sinceReplan >= REPLAN_EVERY) {
            if (arrived && this.plan.kind === 'return' && this.pos === world.base) {
                this.status = 'docked';
                return;
            }
            if (arrived && this.plan.kind === 'collect' && world.samples.has(this.pos)) {
                this.drilling = DRILL_TICKS;
                this.spend('drill', DRILL_WH);
                return;
            }
            this.decide(world);
        }

        const next = this.plan.path[0];
        if (next === undefined) {
            if (this.plan.kind === 'uplink' && zoneOf(world, this.pos)) this.transmit(world);
            else if (this.plan.kind === 'return' && this.pos === world.base) this.status = 'docked';
            return;
        }
        const k = dirIndex(this.pos, next);
        const cost = edgeCost(world, this.pos, next, k);
        if (cost === Infinity) { this.plan = null; return; } // only possible if a slide landed this very tick
        const climb = Math.max(0, world.h[next] - world.h[this.pos]) * CLIMB_WH_PER_M;
        this.spend('climb', climb);
        this.spend('drive', cost - climb);
        this.distance += LEN[k];
        this.pos = next;
        this.plan.path.shift();
        this.sinceReplan++;
    }

    transmit(world) {
        let budget = UPLINK_MB_PER_TICK * (inStorm(world, this.pos) ? 0.5 : 1);
        this.spend('uplink', UPLINK_WH_PER_TICK);
        while (budget > 0 && this.cargo.length) {
            const d = this.cargo[0], sent = Math.min(budget, d.left);
            d.left -= sent;
            budget -= sent;
            if (d.left <= 0) {
                this.cargo.shift();
                this.uplinked += d.value;
                this.uplinkedByType[d.type]++;
            }
        }
        if (!this.cargo.length) {
            this.say(`Uplink complete. ${this.uplinked} science safely back on Earth.`, 'good');
            this.plan = null;
        }
    }

    decide(world) {
        const prev = this.plan;
        this.plan = this.strategy === 'greedy' ? this.planGreedy(world) : this.planSmart(world);
        this.sinceReplan = 0;
        this.seenVersion = world.version;
        // Log decisions, not every re-scored exploration waypoint
        if (!prev || prev.kind !== this.plan.kind || (this.plan.kind !== 'explore' && prev.cell !== this.plan.cell)) this.say(this.plan.reason, 'plan');
    }

    // The belief map with unexplored ground priced pessimistically (for safety estimates only).
    cautious() {
        const b = this.belief;
        this.wary ??= { ...b, soil: new Float32Array(N * N) };
        for (let c = 0; c < N * N; c++) this.wary.soil[c] = b.known[c] ? b.soil[c] : TUNE.unknownHomeCost;
        return this.wary;
    }

    zoneCells(world) {
        const cells = [];
        for (const t of world.comms) {
            if (!t.known || !t.online) continue;
            const [tx, ty] = xy(t.cell);
            for (let y = ty - COMM_R; y <= ty + COMM_R; y++)
                for (let x = tx - COMM_R; x <= tx + COMM_R; x++)
                    if (inside(x, y) && Math.hypot(x - tx, y - ty) <= COMM_R && !this.belief.blocked[cellAt(x, y)]) cells.push(cellAt(x, y));
        }
        return cells;
    }

    frontier(F) {
        const b = this.belief, out = [];
        for (let c = 0; c < N * N; c++) {
            if (!b.known[c] || b.blocked[c] || F.dist[c] === Infinity) continue;
            let edge = false;
            for (let k = 0; k < 8 && !edge; k++) { const v = NB[c * 8 + k]; if (v >= 0 && !b.known[v]) edge = true; }
            if (!edge) continue;
            const [x, y] = xy(c);
            let gain = 0;
            for (const [dx, dy] of SENSOR_DISC) if (inside(x + dx, y + dy) && !b.known[cellAt(x + dx, y + dy)]) gain++;
            if (gain >= 4) out.push({ cell: c, gain });
        }
        return out;
    }

    // Smart planner: score every option by science per *extra* watt-hour it costs on top of finishing
    // the mission right now, and only accept options that still leave enough energy to uplink
    // everything on board and drive home with a safety reserve.
    planSmart(world) {
        const b = this.belief, here = this.pos, E = this.energy, mb = this.mb, carried = this.carried;
        const F = dijkstra(b, [[here, 0]]);
        // Explore optimistically, but price unexplored shortcuts home pessimistically: that is where
        // rovers find the boulder field that strands them.
        const H = dijkstra(this.cautious(), [[world.base, 0]], true);
        this.homeField = H;
        const zones = this.zoneCells(world);
        const Z = zones.length ? dijkstra(b, zones.map(c => [c, H.dist[c]]), true) : null;
        const uplinkWh = s => Math.ceil(s / UPLINK_MB_PER_TICK) * UPLINK_WH_PER_TICK;
        const finish = (c, s) => (s > 0 && Z ? Z.dist[c] + uplinkWh(s) : H.dist[c]);
        const reserve = f => TUNE.reserveBase * BATTERY_WH + TUNE.reserveFrac * f;
        const finishNow = finish(here, mb);
        const options = [];

        for (const c of this.knownSamples) {
            const t = SAMPLE_TYPES[world.samples.get(c).type];
            const go = F.dist[c] + DRILL_WH;
            if (go === Infinity) continue;
            const after = finish(c, mb + t.mb);
            const o = { kind: 'collect', cell: c, value: t.value, cost: go, label: `Collect ${t.name.toLowerCase()} at ${fmt(c)}`,
                utility: t.value / Math.max(1, go + TUNE.returnWeight * (after - finishNow)) };
            if (mb + t.mb > STORAGE_MB) o.blocked = 'storage full';
            else if (go + after + reserve(after) > E) o.blocked = 'could not get back';
            options.push(o);
        }

        // Expected science per newly seen cell, learned from what has been found so far.
        const density = (0.29 * 300 + this.discoveredValue) / (300 + this.knownCount);
        const commBonus = Z ? 1 : mb > 0 ? 2.5 : 1.5;
        const explore = this.frontier(F).map(({ cell, gain }) => {
            const after = finish(cell, mb), go = F.dist[cell];
            const value = TUNE.exploreWeight * gain * density * commBonus;
            const o = { kind: 'explore', cell, value, cost: go, gain, label: `Explore around ${fmt(cell)}`,
                utility: value / Math.max(1, go + TUNE.returnWeight * (after - finishNow)) };
            if (go + after + reserve(after) > E) o.blocked = 'could not get back';
            return o;
        }).sort((p, q) => (!!p.blocked - !!q.blocked) || q.utility - p.utility);
        options.push(...explore.slice(0, 3));

        let up = null;
        if (mb > 0 && Z) {
            const cost = Z.dist[here] + uplinkWh(mb);
            up = { kind: 'uplink', cell: -1, value: carried, cost, label: `Uplink ${carried} science`, utility: carried / Math.max(1, cost) };
            if (cost === Infinity || cost + reserve(cost) > E) up.blocked = 'could not get back';
            options.push(up);
        }

        const viable = options.filter(o => !o.blocked && o.kind !== 'uplink').sort((p, q) => q.utility - p.utility);
        let best = viable[0];
        if (best && this.plan && (this.plan.kind === 'collect' || this.plan.kind === 'explore')) {
            const cur = viable.find(o => o.kind === this.plan.kind && o.cell === this.plan.cell);
            if (cur && cur.utility >= 0.8 * best.utility) best = cur; // don't flip-flop between near-equal targets
        }
        const fullFor = options.find(o => o.blocked === 'storage full' && (!best || o.utility > best.utility));
        const inZone = !!zoneOf(world, here) && Z && Z.prev[here] === -1;

        let choice, reason;
        const home = H.dist[here];
        if (up && !up.blocked && (inZone || !best || carried >= TUNE.riskCap || mb >= TUNE.storageFrac * STORAGE_MB || fullFor)) {
            choice = up;
            reason = inZone ? `In relay range: uplinking ${carried} science before doing anything else.`
                : !best ? `Nothing else is affordable, so uplinking ${carried} science and heading home.`
                : carried >= TUNE.riskCap ? `Carrying ${carried} unsent science. Too much to risk, uplinking it now.`
                : fullFor ? `Storage too full for ${fullFor.label.slice(8)}. Uplinking first to make room.`
                : `Storage ${Math.round(mb / STORAGE_MB * 100)}% full. Uplinking ${carried} science.`;
            choice.path = follow(Z, here);
        } else if (best) {
            choice = best;
            reason = best.kind === 'collect'
                ? `${best.label}: ${best.value} science for ${Math.round(best.cost)} Wh. After that there is still enough to ${Z ? 'uplink and ' : ''}get home.`
                : `${best.label}: about ${best.gain} unseen cells, worth ~${Math.round(best.value)} science on current finds.`;
            choice.path = trace(F, best.cell);
        } else {
            choice = { kind: 'return', cell: world.base, label: 'Return to lander', cost: home, value: 0, utility: 0 };
            reason = carried > 0
                ? `Not enough energy to reach a relay. Returning home with ${carried} science unsent.`
                : `Nothing left worth the energy. Returning with ${Math.round(E)} Wh, ${Math.round(home)} Wh needed.`;
            choice.path = follow(H, here);
        }
        options.sort((p, q) => (!!p.blocked - !!q.blocked) || q.utility - p.utility);
        return { ...choice, reason, options: options.slice(0, 6), finishNow, reserve: reserve(finishNow) };
    }

    // Greedy baseline: same sensors and pathfinding, simple rules. Nearest sample first, nearest
    // unexplored area otherwise, uplink only when storage is full, go home with a fixed 20 Wh margin.
    planGreedy(world) {
        const b = this.belief, here = this.pos, mb = this.mb;
        const F = dijkstra(b, [[here, 0]]);
        const H = dijkstra(b, [[world.base, 0]], true);
        this.homeField = H;
        const done = (kind, cell, path, reason) => ({ kind, cell, path, reason, label: reason, options: [], finishNow: H.dist[here], reserve: 20 });

        if (this.energy <= H.dist[here] + 20) return done('return', world.base, follow(H, here), 'Battery low, heading home.');
        const zones = this.zoneCells(world);
        const samples = [...this.knownSamples].filter(c => F.dist[c] < Infinity).sort((p, q) => F.dist[p] - F.dist[q]);
        const fits = samples.find(c => mb + SAMPLE_TYPES[world.samples.get(c).type].mb <= STORAGE_MB);
        if (zones.length && mb > 0 && (mb >= 0.85 * STORAGE_MB || (samples.length && fits === undefined))) {
            const z = zones.reduce((p, q) => (F.dist[q] < F.dist[p] ? q : p));
            return done('uplink', z, trace(F, z), 'Storage full, going to the nearest relay.');
        }
        if (fits !== undefined) return done('collect', fits, trace(F, fits), `Going for the nearest sample at ${fmt(fits)}.`);
        const f = this.frontier(F).sort((p, q) => F.dist[p.cell] - F.dist[q.cell])[0];
        if (f) return done('explore', f.cell, trace(F, f.cell), `Exploring the nearest unknown area near ${fmt(f.cell)}.`);
        return done('return', world.base, follow(H, here), 'Map explored, heading home.');
    }
}

// ---------- a whole mission: world + rover + changing conditions + telemetry ----------

export class Mission {
    constructor({ scenario = 'standard', seed, strategy = 'smart', chaos = 'normal' } = {}) {
        this.scenarioId = scenario;
        this.scn = SCENARIOS[scenario];
        this.seed = seed ?? this.scn.seed;
        this.strategy = strategy;
        this.chaos = chaos;
        this.world = createWorld(this.scn, this.seed);
        this.log = [];
        this.fx = [];              // world changes for the renderer to animate
        this.tick = 0;
        this.done = false;
        this.outagesHit = 0;
        this.nextEventAt = 50;
        this.telemetry = { energy: [], need: [], uplinked: [], carried: [], explored: [] };
        this.rover = new Rover(this.world, strategy, (text, kind) => this.say(text, kind));
        this.record();
    }

    say(text, kind = 'info') {
        this.log.push({ tick: this.tick, text, kind });
    }

    step() {
        if (this.done) return;
        this.tick++;
        const w = this.world;
        w.tick = this.tick;

        if (w.storms.length) {
            for (const s of w.storms) {
                s.x += s.vx; s.y += s.vy;
                if (s.x < 0 || s.x >= N) s.vx *= -1;
                if (s.y < 0 || s.y >= N) s.vy *= -1;
                if (--s.ttl <= 0) { this.say('The dust storm has blown itself out.', 'event'); w.version++; }
            }
            w.storms = w.storms.filter(s => s.ttl > 0);
            rebuildStorms(w);
        }
        for (const t of w.comms) {
            if (!t.online && --t.outage <= 0) {
                t.online = true; w.version++;
                this.say(`Relay tower ${t.id} is back online.`, 'event');
                this.fx.push({ type: 'outage', comm: t });
            }
        }

        if (this.chaos !== 'off' && this.tick >= this.nextEventAt) {
            const every = this.scn.every * (this.chaos === 'intense' ? 0.5 : 1);
            this.nextEventAt = this.tick + Math.round(every * (0.7 + 0.6 * w.eventRand()));
            this.randomEvent();
        }

        this.rover.step(w);
        this.record();

        const r = this.rover;
        if (r.status !== 'active' || this.tick >= MAX_TICKS) {
            this.done = true;
            this.success = r.status === 'docked';
            if (r.status === 'docked') this.say(`Docked at the lander with ${Math.round(r.energy)} Wh left. Mission complete: ${r.uplinked} science returned.`, 'good');
            else if (r.status === 'stranded') this.say(`Battery empty at ${fmt(r.pos)}. The rover is stranded. ${r.carried} unsent science is lost.`, 'bad');
            else this.say('Mission clock ran out before the rover made it home.', 'bad');
        }
    }

    record() {
        const r = this.rover, t = this.telemetry;
        t.energy.push(r.energy);
        t.need.push(r.homeField ? r.homeField.dist[r.pos] : 0);
        t.uplinked.push(r.uplinked);
        t.carried.push(r.carried);
        t.explored.push(r.explored);
    }

    // ----- changing conditions (also exposed as click tools) -----

    randomEvent() {
        const w = this.world, rand = w.eventRand, mix = this.scn.mix;
        const roll = rand();
        const path = this.rover.plan?.path ?? [];
        if (roll < mix.slide) {
            const ahead = path.slice(3, 14);
            for (let tries = 0; tries < 6; tries++) {
                const c = ahead.length ? ahead[Math.floor(rand() * ahead.length)] : this.nearRover(10);
                if (this.rockslide(c, true).ok) return;
            }
        } else if (roll < mix.slide + mix.storm) {
            const c = path.length > 8 ? path[8] : this.nearRover(9);
            this.dustStorm(c, true);
        } else {
            const target = this.rover.plan?.kind === 'uplink' ? zoneOf(w, this.rover.plan.path.at(-1) ?? this.rover.pos) : null;
            const t = target ?? w.comms[Math.floor(rand() * w.comms.length)];
            if (t.online) this.outage(t.cell, true);
        }
    }

    nearRover(r) {
        const [x, y] = xy(this.rover.pos), rand = this.world.eventRand;
        const nx = Math.min(N - 1, Math.max(0, Math.round(x + (rand() * 2 - 1) * r)));
        const ny = Math.min(N - 1, Math.max(0, Math.round(y + (rand() * 2 - 1) * r)));
        return cellAt(nx, ny);
    }

    rockslide(c, auto = false) {
        const w = this.world, [cx, cy] = xy(c), rand = w.eventRand, cells = [];
        const protectedCell = p => dist(p, w.base) <= 2 || p === this.rover.pos || w.samples.has(p) || w.comms.some(t => t.cell === p) || w.blocked[p];
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const p = cellAt(cx + dx, cy + dy);
                if (inside(cx + dx, cy + dy) && (dx === 0 && dy === 0 || rand() < 0.55) && !protectedCell(p)) cells.push(p);
            }
        if (!cells.length) return { ok: false, msg: 'Nothing can slide there.' };
        for (const p of cells) w.blocked[p] = 1;
        // Never let a slide make the mission impossible: the rover must still reach home and every tower.
        const reach = dijkstra(w, [[this.rover.pos, 0]]).dist;
        if (reach[w.base] === Infinity || w.comms.some(t => reach[t.cell] === Infinity)) {
            for (const p of cells) w.blocked[p] = 0;
            return { ok: false, msg: 'That rockslide would trap the rover. Try another spot.' };
        }
        this.fx.push({ type: 'slide', cells });
        this.say(`${auto ? 'Seismic alert' : 'Rockslide triggered'}: rocks came down around ${fmt(c)}.`, 'event');
        return { ok: true };
    }

    dustStorm(c, auto = false) {
        const w = this.world, rand = w.eventRand, [x, y] = xy(c);
        const a = rand() * Math.PI * 2;
        w.storms.push({ x, y, r: 5, vx: Math.cos(a) * 0.12, vy: Math.sin(a) * 0.12, ttl: 150 });
        w.version++;
        rebuildStorms(w);
        this.say(`${auto ? 'Weather alert' : 'Dust storm triggered'}: a dust storm is forming at ${fmt(c)}.`, 'event');
        return { ok: true };
    }

    outage(c, auto = false) {
        const w = this.world;
        const t = w.comms.reduce((p, q) => (dist(q.cell, c) < dist(p.cell, c) ? q : p));
        if (!auto && dist(t.cell, c) > 8) return { ok: false, msg: 'Click closer to a relay tower.' };
        t.online = !t.online;
        t.outage = t.online ? 0 : 90;
        w.version++;
        if (!t.online) this.outagesHit++;
        this.fx.push({ type: 'outage', comm: t });
        this.say(t.online ? `Relay tower ${t.id} restored.` : `Relay tower ${t.id} has gone offline${auto ? ' (power fault)' : ''}.`, 'event');
        return { ok: true };
    }

    summary() {
        const r = this.rover;
        return {
            scenario: this.scenarioId, seed: this.seed, strategy: this.strategy,
            success: !!this.success, outcome: r.status === 'active' ? 'timeout' : r.status,
            science: r.uplinked, unsent: r.carried, ticks: this.tick,
            energyLeft: r.energy, used: { ...r.used }, distanceKm: r.distance * CELL_M / 1000,
            explored: r.explored, replans: r.replans, routesBlocked: r.routesBlocked,
            stormTicks: r.stormTicks, outagesHit: this.outagesHit,
            uplinkedByType: [...r.uplinkedByType], collectedByType: [...r.collectedByType],
        };
    }
}

export function runMission(opts) {
    const m = new Mission(opts);
    while (!m.done) m.step();
    return m.summary();
}
