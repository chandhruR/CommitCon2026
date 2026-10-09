// Runs smart-vs-greedy missions off the main thread so the 3D view stays smooth.
import { runMission, SCENARIOS } from './sim.js';

self.onmessage = ({ data: { seeds, chaos } }) => {
    const jobs = [];
    for (const scenario of Object.keys(SCENARIOS))
        for (let i = 0; i < seeds; i++) jobs.push({ scenario, seed: SCENARIOS[scenario].seed + i * 101 });
    let done = 0;
    for (const job of jobs) {
        for (const strategy of ['smart', 'greedy']) {
            self.postMessage({ type: 'row', row: runMission({ ...job, strategy, chaos }), done: ++done, total: jobs.length * 2 });
        }
    }
    self.postMessage({ type: 'done' });
};
