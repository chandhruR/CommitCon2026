// Headless benchmark + invariants. Run: node test/sim.test.mjs [seedsPerScenario]
// Smart planner vs greedy baseline on identical maps, across every scenario.
import assert from 'node:assert/strict';
import { Mission, SCENARIOS, N, BATTERY_WH } from '../src/sim.js';

const seeds = +process.argv[2] || 6;
const results = { smart: [], greedy: [] };

for (const scenario of Object.keys(SCENARIOS)) {
    for (let i = 0; i < seeds; i++) {
        const seed = SCENARIOS[scenario].seed + i * 101;
        for (const strategy of ['smart', 'greedy']) {
            const m = new Mission({ scenario, seed, strategy });
            const w = m.world;
            assert.ok(w.samples.size >= 16, `${scenario}/${seed}: only ${w.samples.size} samples placed`);
            let science = 0;
            while (!m.done) {
                m.step();
                const r = m.rover;
                assert.ok(!w.blocked[r.pos], `${scenario}/${seed}/${strategy}: rover inside rock at tick ${m.tick}`);
                assert.ok(r.uplinked >= science, 'uplinked science never decreases');
                if (r.uplinked > science) assert.ok(r.pos === r.pos && w.comms.some(t => t.online && Math.hypot(t.cell % N - r.pos % N, ((t.cell / N) | 0) - ((r.pos / N) | 0)) <= 3), 'science only counts inside an online relay zone');
                science = r.uplinked;
                assert.ok(r.energy >= 0 && r.energy <= BATTERY_WH);
            }
            results[strategy].push({ scenario, ...m.summary() });
        }
    }
}

const agg = rows => ({
    missions: rows.length,
    success: `${Math.round(rows.filter(r => r.success).length / rows.length * 100)}%`,
    avgScience: Math.round(rows.reduce((s, r) => s + r.science, 0) / rows.length),
    avgUnsent: Math.round(rows.reduce((s, r) => s + r.unsent, 0) / rows.length),
    avgExplored: `${Math.round(rows.reduce((s, r) => s + r.explored, 0) / rows.length * 100)}%`,
    avgEnergyLeft: Math.round(rows.reduce((s, r) => s + r.energyLeft, 0) / rows.length),
    routesBlocked: rows.reduce((s, r) => s + r.routesBlocked, 0),
});
console.table({ smart: agg(results.smart), greedy: agg(results.greedy) });
const byScn = {};
for (const s of Object.keys(SCENARIOS)) {
    const a = agg(results.smart.filter(r => r.scenario === s)), b = agg(results.greedy.filter(r => r.scenario === s));
    byScn[s] = { smartOk: a.success, smartSci: a.avgScience, greedyOk: b.success, greedySci: b.avgScience };
}
console.table(byScn);

const rate = rows => rows.filter(r => r.success).length / rows.length;
const sci = rows => rows.reduce((s, r) => s + r.science, 0) / rows.length;
assert.ok(rate(results.smart) >= 0.9, 'smart planner should bring the rover home in >= 90% of missions');
assert.ok(sci(results.smart) > sci(results.greedy) * 1.2, 'smart planner should return clearly more science than greedy');
assert.ok(results.smart.some(r => r.explored < 0.95), 'energy should be a real constraint');
assert.ok(results.smart.reduce((s, r) => s + r.routesBlocked, 0) > 0, 'adaptation to blocked routes should be exercised');
console.log('ok');
