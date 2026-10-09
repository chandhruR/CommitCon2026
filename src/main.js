// App wiring: the mission loop, the HUD, hazard tools, mission reports and the benchmark.
import { Mission, SCENARIOS, SAMPLE_TYPES, BATTERY_WH, STORAGE_MB, TUNE, runMission, zoneOf } from './sim.js';
import { View3D } from './view3d.js';
import { Map2D } from './map2d.js';
import { TimeChart, groupedBars } from './charts.js';

const $ = id => document.getElementById(id);
const COLORS = { smart: '#c98126', greedy: '#6a8bd0', teal: '#2a9e8f', ink2: '#c2ae99' };
const BRAIN = { smart: 'Smart planner', greedy: 'Greedy baseline' };
const state = { scenario: 'standard', seed: null, strategy: 'smart', chaos: 'normal', running: false, tps: 10, tool: null, logShown: 0, acc: 0, chartAt: 0 };

for (const [id, s] of Object.entries(SCENARIOS)) $('scenario').add(new Option(s.name, id));

const view = new View3D($('view3d'), { onCellClick: applyTool });
const map = new Map2D($('map2d'), $('map-tip'), { onCellClick: applyTool });
const energyChart = new TimeChart($('chart-energy'), {
    unit: ' Wh',
    series: [
        { key: 'energy', label: 'Battery', color: COLORS.smart },
        { key: 'need', label: 'Needed to drive home', short: 'Home', color: COLORS.ink2, dash: true },
    ],
});
const scienceChart = new TimeChart($('chart-science'), {
    stacked: true,
    series: [
        { key: 'uplinked', label: 'Sent to Earth', short: 'Sent', color: COLORS.teal },
        { key: 'carried', label: 'On board, unsent', short: 'On board', color: COLORS.smart },
    ],
});

// ---------- mission lifecycle ----------

function newMission(seed = state.seed) {
    const m = state.mission = new Mission({ scenario: state.scenario, seed: seed ?? undefined, strategy: state.strategy, chaos: state.chaos });
    state.seed = m.seed;
    state.logShown = 0;
    state.acc = 0;
    state.reported = false;
    $('log').replaceChildren();
    view.load(m);
    map.load(m);
    setRunning(false);
    render(true);
    $('reason').textContent = `${m.scn.name}, map ${m.seed}. ${m.scn.blurb}`;
}

function setRunning(on) {
    const m = state.mission;
    state.running = on && !m.done;
    $('btn-play').textContent = m.done ? 'Fly again' : state.running ? 'Pause' : m.tick ? 'Resume' : 'Launch';
}

function frame(now) {
    const dt = Math.min(0.1, (now - (state.last ?? now)) / 1000);
    state.last = now;
    const m = state.mission;
    if (state.running) {
        state.acc += dt * state.tps;
        let steps = 0;
        while (state.acc >= 1 && steps < 30 && !m.done) { m.step(); state.acc -= 1; steps++; }
        if (steps) render();
        if (m.done) finish();
    }
    while (m.fx.length) view.consume(m.fx.shift());
    view.render(dt);
    requestAnimationFrame(frame);
}

function finish() {
    setRunning(false);
    if (state.reported) return;
    state.reported = true;
    saveHistory(state.mission.summary());
    setTimeout(showReport, 1400); // let the docking (or the stranding) sink in first
}

// ---------- HUD ----------

const reserveFor = (strategy, home) => strategy === 'greedy' ? 20 : TUNE.reserveBase * BATTERY_WH + TUNE.reserveFrac * home;

function render(force = false) {
    const m = state.mission, r = m.rover;
    $('tick').textContent = `Tick ${m.tick}`;

    const home = r.homeField ? r.homeField.dist[r.pos] : 0;
    const need = home + reserveFor(m.strategy, home);
    const margin = r.energy - need;
    $('energy').textContent = Math.round(r.energy);
    $('energy-fill').style.width = `${(r.energy / BATTERY_WH) * 100}%`;
    $('energy-need').style.left = `${Math.min(100, (need / BATTERY_WH) * 100)}%`;
    $('energy-bar').setAttribute('aria-label', `Battery ${Math.round(r.energy)} Wh. Getting home safely needs ${Math.round(need)} Wh.`);
    $('margin').textContent = r.status === 'docked' ? `Docked with ${Math.round(r.energy)} Wh to spare.`
        : r.status === 'stranded' ? 'Battery empty. The rover cannot move.'
        : margin > 0 ? `Safe margin: ${Math.round(margin)} Wh beyond what it takes to get home with a reserve.`
        : 'At the point of no return. Only the trip home is safe now.';
    $('energy').closest('.battery').dataset.state = r.status === 'active' && margin < 25 ? 'tight' : '';

    $('science').textContent = r.uplinked;
    $('carried').textContent = r.carried;
    $('storage').textContent = `${Math.round(r.mb)} / ${STORAGE_MB} MB`;
    $('storage-fill').style.width = `${(r.mb / STORAGE_MB) * 100}%`;
    $('explored').textContent = `${Math.round(r.explored * 100)}%`;
    $('distance').textContent = `${(r.distance * 0.01).toFixed(1)} km`;
    $('replans').textContent = r.replans;
    $('blocked').textContent = r.routesBlocked;

    const kind = r.status !== 'active' ? r.status : r.drilling ? 'drill' : r.plan?.kind ?? 'idle';
    const inZone = !!zoneOf(m.world, r.pos);
    $('status-chip').dataset.kind = kind;
    $('status-chip').textContent = {
        idle: 'Waiting on the lander', explore: 'Exploring', collect: 'Heading to a sample', drill: 'Drilling a sample',
        uplink: inZone && r.cargo.length ? 'Uplinking data' : 'Heading to a relay', return: 'Returning to the lander',
        docked: 'Docked safely', stranded: 'Stranded',
    }[kind];
    if (r.plan && m.tick) $('reason').textContent = r.status === 'active' ? r.plan.reason : m.log.at(-1).text;
    renderOptions(r);

    for (; state.logShown < m.log.length; state.logShown++) {
        const e = m.log[state.logShown], li = document.createElement('li');
        li.dataset.kind = e.kind;
        li.innerHTML = `<time>${e.tick}</time><span></span>`;
        li.lastChild.textContent = e.text;
        $('log').prepend(li);
    }

    map.draw();
    const now = performance.now();
    if (force || now - state.chartAt > 120 || m.done) {
        state.chartAt = now;
        energyChart.update(m.telemetry, BATTERY_WH);
        scienceChart.update(m.telemetry, Math.max(100, Math.ceil(Math.max(...m.telemetry.uplinked.map((u, i) => u + m.telemetry.carried[i])) / 100) * 100));
    }
}

function renderOptions(r) {
    const body = $('options').tBodies[0];
    body.replaceChildren();
    if (r.status !== 'active' || !r.plan?.options?.length) return;
    const isChosen = o => o.kind === r.plan.kind && (o.kind === 'uplink' || o.cell === r.plan.cell);
    const rows = r.plan.options.slice(0, 4);
    const chosenRow = r.plan.options.find(isChosen);
    if (chosenRow && !rows.includes(chosenRow)) rows[3] = chosenRow;
    for (const o of rows) {
        const tr = body.insertRow();
        const chosen = isChosen(o);
        tr.className = chosen ? 'chosen' : o.blocked ? 'blocked' : '';
        const label = tr.insertCell();
        label.textContent = o.label;
        if (o.blocked) label.insertAdjacentHTML('beforeend', ` <span class="why">(${o.blocked})</span>`);
        tr.insertCell().textContent = o.kind === 'explore' ? `~${Math.round(o.value)}` : Math.round(o.value);
        tr.insertCell().textContent = `${Math.round(o.cost)} Wh`;
        tr.insertCell().textContent = o.blocked ? '' : `${o.utility.toFixed(2)}/Wh`;
    }
}

let toastTimer;
function toast(text, kind = '') {
    const t = $('toast');
    t.textContent = text;
    t.dataset.kind = kind;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- hazard tools ----------

function setTool(tool) {
    state.tool = state.tool === tool ? null : tool;
    for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === state.tool);
    view.setTool(state.tool);
    map.setTool(state.tool);
    if (state.tool) toast({ slide: 'Click the terrain or the map to drop a rockslide.', storm: 'Click where the dust storm should form.', outage: 'Click near a relay tower to knock it offline (or bring it back).' }[state.tool]);
}

function applyTool(cell) {
    const m = state.mission;
    if (!state.tool || m.done) return;
    const res = state.tool === 'slide' ? m.rockslide(cell) : state.tool === 'storm' ? m.dustStorm(cell) : m.outage(cell);
    if (!res.ok) toast(res.msg, 'bad');
    render(true);
}

// ---------- mission report ----------

function showReport() {
    const m = state.mission, s = m.summary(), r = m.rover, dlg = $('report');
    dlg.dataset.outcome = s.outcome;
    $('report-title').textContent = s.success ? 'Mission complete' : s.outcome === 'stranded' ? 'Rover stranded' : 'Out of time';
    $('report-lede').textContent = s.success
        ? `${BRAIN[m.strategy]} on ${m.scn.name}: ${s.science} science sent home, ${Math.round(s.explored * 100)}% of the map explored, docked with ${Math.round(s.energyLeft)} Wh to spare.`
        : `${BRAIN[m.strategy]} on ${m.scn.name} ran out of power ${(s.distanceKm).toFixed(1)} km into the drive. ${s.science} science made it home; ${s.unsent} science still on board was lost.`;

    const rows = [['Driving', s.used.drive], ['Climbing', s.used.climb], ['Drilling', s.used.drill], ['Uplinking', s.used.uplink], ['Left over', s.energyLeft]];
    $('report-energy').innerHTML = rows.map(([k, v]) =>
        `<div class="bar-row"><span>${k}</span><div><i style="width:${(v / BATTERY_WH) * 100}%"></i></div><span>${Math.round(v)} Wh</span></div>`).join('');

    $('report-science').innerHTML = `<thead><tr><th>Sample</th><th>Collected</th><th>Sent</th><th>Science</th></tr></thead><tbody>${
        SAMPLE_TYPES.map((t, i) => `<tr><td>${t.name}</td><td>${s.collectedByType[i]}</td><td>${s.uplinkedByType[i]}</td><td>${s.uplinkedByType[i] * t.value}</td></tr>`).join('')
    }<tr><td><b>Total</b></td><td>${s.collectedByType.reduce((a, b) => a + b)}</td><td>${s.uplinkedByType.reduce((a, b) => a + b)}</td><td><b>${s.science}</b></td></tr></tbody>`;

    $('report-adapt').innerHTML = [
        ['Replans', s.replans], ['Known routes buried', s.routesBlocked],
        ['Ticks in dust storms', s.stormTicks], ['Relay outages', s.outagesHit],
        ['Distance driven', `${s.distanceKm.toFixed(1)} km`], ['Mission length', `${s.ticks} ticks`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const other = m.strategy === 'smart' ? 'greedy' : 'smart';
    $('btn-compare').textContent = `Run the ${BRAIN[other].toLowerCase()} on this map`;
    $('btn-compare').hidden = false;
    $('report-compare').innerHTML = '<p class="muted">Same map, same random-event schedule. Hazards you dropped by hand aren\'t replayed.</p>';
    $('btn-compare').onclick = () => {
        const o = runMission({ scenario: m.scenarioId, seed: m.seed, strategy: other, chaos: m.chaos });
        const cell = (a, b) => `<span>${a}</span><span>${b}</span>`;
        $('report-compare').innerHTML = `<div class="compare"><span></span><b>${BRAIN[m.strategy]}</b><b>${BRAIN[other]}</b>
            <span>Science sent home</span>${cell(s.science, o.science)}
            <span>Made it home</span>${cell(s.success ? 'Yes' : 'No', o.success ? 'Yes' : 'No')}
            <span>Science lost unsent</span>${cell(s.unsent, o.unsent)}
            <span>Map explored</span>${cell(`${Math.round(s.explored * 100)}%`, `${Math.round(o.explored * 100)}%`)}</div>`;
        $('btn-compare').hidden = true;
    };

    const hist = loadHistory();
    const by = k => hist.filter(h => h.strategy === k);
    const avg = rows => rows.length ? Math.round(rows.reduce((a, h) => a + h.science, 0) / rows.length) : 0;
    $('report-history').textContent = `${hist.length} mission${hist.length === 1 ? '' : 's'} flown on this device, ${hist.filter(h => h.success).length} made it home.`
        + (by('smart').length ? ` Smart planner averages ${avg(by('smart'))} science.` : '')
        + (by('greedy').length ? ` Greedy baseline averages ${avg(by('greedy'))}.` : '');
    dlg.showModal();
}

$('report').addEventListener('close', () => {
    const v = $('report').returnValue;
    if (v === 'again') { newMission(state.seed); setRunning(true); }
    if (v === 'new') { newMission(randomSeed()); setRunning(true); }
});

function loadHistory() {
    try { return JSON.parse(localStorage.getItem('lost-in-space-history')) ?? []; } catch { return []; }
}
function saveHistory(s) {
    try { localStorage.setItem('lost-in-space-history', JSON.stringify([...loadHistory(), { strategy: s.strategy, scenario: s.scenario, seed: s.seed, success: s.success, science: s.science }].slice(-200))); } catch { /* storage unavailable */ }
}

// ---------- benchmark ----------

let worker;
$('btn-bench').addEventListener('click', () => $('bench').showModal());
$('btn-bench-run').addEventListener('click', () => {
    worker?.terminate();
    worker = new Worker(new URL('./bench.worker.js', import.meta.url), { type: 'module' });
    const rows = [];
    $('bench-progress').hidden = false;
    $('btn-bench-run').disabled = true;
    $('bench-status').textContent = 'Flying missions…';
    worker.onmessage = ({ data }) => {
        if (data.type === 'row') {
            rows.push(data.row);
            $('bench-progress').value = data.done / data.total;
            $('bench-status').textContent = `${data.done} of ${data.total} missions flown`;
        } else {
            $('btn-bench-run').disabled = false;
            $('bench-progress').hidden = true;
            $('bench-status').textContent = `${rows.length} missions, ${rows.length / 2} maps.`;
            renderBench(rows);
        }
    };
    worker.postMessage({ seeds: +$('bench-seeds').value, chaos: state.chaos });
});

function renderBench(rows) {
    const pick = k => rows.filter(r => r.strategy === k);
    const avg = (rs, f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    const S = pick('smart'), G = pick('greedy');
    const sciS = avg(S, r => r.science), sciG = avg(G, r => r.science);
    const homeS = avg(S, r => r.success) * 100, homeG = avg(G, r => r.success) * 100;
    $('bench-summary').innerHTML = `
        <div><b>${sciS > sciG ? '+' : ''}${Math.round((sciS / sciG - 1) * 100)}%</b><span>more science per mission (${Math.round(sciS)} vs ${Math.round(sciG)})</span></div>
        <div><b>${Math.round(homeS)}%</b><span>of smart missions made it home, against ${Math.round(homeG)}% for greedy</span></div>
        <div><b>${Math.round(avg(G, r => r.unsent))}</b><span>science per mission the greedy rover collected but never sent (smart: ${Math.round(avg(S, r => r.unsent))})</span></div>`;
    const series = [{ label: 'Smart planner', color: COLORS.smart }, { label: 'Greedy baseline', color: COLORS.greedy }];
    const groups = Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.name.split(' ')[0] }));
    const byScn = (k, id, f) => avg(rows.filter(r => r.strategy === k && r.scenario === id), f);
    const sci = groups.map(g => ({ label: g.label, values: [byScn('smart', g.id, r => r.science), byScn('greedy', g.id, r => r.science)] }));
    groupedBars($('chart-bench-science'), { groups: sci, series, max: Math.ceil(Math.max(...sci.flatMap(g => g.values)) / 100) * 100 });
    groupedBars($('chart-bench-success'), { groups: groups.map(g => ({ label: g.label, values: [byScn('smart', g.id, r => r.success) * 100, byScn('greedy', g.id, r => r.success) * 100] })), series, max: 100, unit: '%' });
    $('bench-table').innerHTML = `<thead><tr><th>Scenario</th><th>Map</th><th>Brain</th><th>Home</th><th>Science</th><th>Lost unsent</th><th>Energy left</th></tr></thead><tbody>${
        rows.map(r => `<tr><td>${SCENARIOS[r.scenario].name}</td><td>${r.seed}</td><td>${BRAIN[r.strategy]}</td><td>${r.success ? 'Yes' : 'No'}</td><td>${r.science}</td><td>${r.unsent}</td><td>${Math.round(r.energyLeft)} Wh</td></tr>`).join('')
    }</tbody>`;
}

// ---------- controls ----------

const randomSeed = () => Math.floor(Math.random() * 1e6);

$('btn-play').addEventListener('click', () => {
    if (state.mission.done) { newMission(state.seed); setRunning(true); return; }
    setRunning(!state.running);
});
$('btn-step').addEventListener('click', () => {
    const m = state.mission;
    setRunning(false);
    if (!m.done) { m.step(); render(true); if (m.done) finish(); }
});
$('btn-reset').addEventListener('click', () => newMission(state.seed));
$('btn-newmap').addEventListener('click', () => newMission(randomSeed()));
$('scenario').addEventListener('change', e => { state.scenario = e.target.value; newMission(null); });
$('chaos').addEventListener('change', e => { state.chaos = e.target.value; state.mission.chaos = state.chaos; });
$('speed').addEventListener('input', e => { state.tps = +e.target.value; view.tps = state.tps; });
$('reveal').addEventListener('change', e => { view.setReveal(e.target.checked); map.setReveal(e.target.checked); });
$('follow').addEventListener('change', e => { view.follow = e.target.checked; });
for (const b of document.querySelectorAll('[data-strategy]')) {
    b.addEventListener('click', () => {
        state.strategy = b.dataset.strategy;
        for (const o of document.querySelectorAll('[data-strategy]')) o.setAttribute('aria-checked', o === b);
        newMission(state.seed); // same map, different brain
    });
}
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

document.addEventListener('keydown', e => {
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest('input, select, textarea') || document.querySelector('dialog[open]')) return;
    if ((e.key === ' ' || e.code === 'Space') && !target.closest('button')) { e.preventDefault(); $('btn-play').click(); }
    else if (e.key === 'n' || e.key === 'N') $('btn-step').click();
    else if (e.key === '1') setTool('slide');
    else if (e.key === '2') setTool('storm');
    else if (e.key === '3') setTool('outage');
    else if (e.key === 'Escape' && state.tool) setTool(state.tool);
});

$('intro').addEventListener('close', () => { if ($('intro').returnValue === 'launch') setRunning(true); });

newMission(null);
view.tps = state.tps;
requestAnimationFrame(frame);
$('intro').showModal();
