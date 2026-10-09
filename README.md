# Lost in Space: Rover Mission Control

A rover lands on a planet nobody has mapped. It has **380 Wh of battery**, **80 MB of storage** and one job: bring back as much science as it can, and get home before the power runs out.

The catch: it starts blind. Science only counts once it's been **uplinked from a relay zone**. And the planet keeps changing. Rockslides bury routes it already knows, dust storms roll across the plains and relay towers drop offline.

## Run it

No build step and no install. It's a static page with ES modules, so it needs any local web server:

```bash
python -m http.server 8080
```

Open http://localhost:8080 and press **Launch mission**.

Run the headless benchmark and invariant checks (Node 18+):

```bash
node test/sim.test.mjs
```

## How it meets the brief

| The brief asks for | What the rover does |
|---|---|
| An unknown environment | Each map is a seeded 48×48 heightmap (480 m square) with craters, dunes, rock fields, boulders and cliffs. The rover starts knowing only its landing site. |
| Tracking explored vs. unexplored | The rover keeps a belief map built by a **line-of-sight** mast camera: hills hide what's behind them. In 3D, unexplored ground sits in shadow. The 2D map draws only what the rover has seen, as a survey sheet with contour lines. |
| Limited energy | Every move costs energy: distance × terrain (plains 1.0, sand 1.7, rock 2.3) plus 0.5 Wh per metre climbed. Drilling and uplinking cost energy too. The battery bar shows a live **"Home" marker**: the energy needed to get back safely. |
| Discovering useful locations | Samples (10 to 120 science) and relay beacons appear only when the rover spots them. |
| Collecting and transporting data | Samples take storage space (8 to 30 MB of 80) and drill time. Data on board is at risk until it's sent. |
| Communication zones | Science counts **only** when uplinked inside an online relay zone (bandwidth halves in a dust storm). Before chasing a sample, the planner checks it can still reach a relay *and* get home afterwards. |
| Adapting when paths get blocked | Rockslides land on the rover's **planned route**. When the rover sees a buried cell it re-plans. Known routes buried, replans, storms and outages are all counted. |
| The best target isn't the easiest | Biosignatures (120 science) sit on crater floors and ridge tops; ice hides in low ground. "Crater jackpot" puts the prize at the bottom of a deep crater. |
| Measurable results | Live charts track energy against the energy needed to get home, plus science sent vs. on board. Each mission ends with a debrief (where the energy went, science by sample, how it handled surprises) and a running record across missions. |
| Early decisions matter | Every option is judged against the rest of the mission: an option is rejected if, after taking it, the rover could no longer uplink and get home with a reserve. |

## The planner

Each time it re-plans, the rover runs three Dijkstra searches over what it believes the map looks like:

1. **From here:** the energy to reach every cell.
2. **To home:** the energy to drive home from every cell. Unexplored ground is priced like a rock field, since an unexplored shortcut home is where rovers find the boulder field that strands them.
3. **Via a relay, then home:** for every cell, the cheapest way to fly to an online relay, uplink and get home.

It then scores every option (collect each known sample, explore each frontier, uplink, return) by **science per watt-hour**. Exploring is valued at the science the rover expects to find, learned from what it has found so far. An option is only allowed if the rover can still afford **the option, then uplink everything, then get home with a reserve**. It uplinks when it passes a relay, when storage fills, or when it's carrying more than 100 unsent science.

The decision card in the corner shows the options it weighed, their cost and score, and why it picked one.

### Is it actually smart? The benchmark

The **greedy baseline** gets the same maps, sensors and pathfinding. It always goes for the nearest sample, explores the nearest unknown ground, uplinks only when storage is full and heads home with a fixed 20 Wh margin. Results over 40 maps (8 per scenario, `node test/sim.test.mjs`):

| Random events | Smart: made it home | Smart: science | Greedy: made it home | Greedy: science |
|---|---|---|---|---|
| Off | 100% | 319 | 88% | 248 |
| Normal | **100%** | **296** | 90% | 221 |
| Intense | 100% | 263 | 88% | 206 |

At normal settings the smart planner returns **34% more science**, never strands, and loses 11 science per mission to unsent data against greedy's 84. The planner's knobs live in `TUNE` (`src/sim.js`). They were tuned on one set of seeds and checked on a held-out set.

You can run the same race from the app: **Run the benchmark** at the bottom of the side panel.

## Demo in two minutes

1. **Launch mission** on *Standard survey*. Point at the decision card: it's weighing science against energy, live.
2. Point at the battery's **Home** marker. Every plan keeps the battery to the right of it.
3. Press **1** and click on the rover's dashed route. The rockslide lands, the rover spots it and reroutes ("Rockslide buried the planned route").
4. Press **3** and click the relay it's heading to. It goes offline and the rover re-plans its uplink.
5. Switch to **Crater jackpot** and turn on **Reveal the whole map**: is the 120-science biosignature worth the climb back out?
6. At the end, the debrief's **Compare** runs the greedy rover on the same map.
7. **Run the benchmark** for the numbers above.

Keys: Space plays and pauses, N steps one tick, 1, 2 and 3 pick a hazard, Esc cancels.

## Project layout

```
index.html            page shell
style.css             Mars dusk theme
src/sim.js            world generation, rover planners, events (no DOM, runs in Node too)
src/view3d.js         Three.js terrain, rover, relays, storms, hazards
src/map2d.js          the rover's belief map with hillshade and contours
src/charts.js         SVG telemetry and benchmark charts
src/main.js           app loop, HUD, tools, debrief, benchmark
src/bench.worker.js   runs benchmark missions off the main thread
test/sim.test.mjs     benchmark plus invariants (science only scores in an online relay zone, etc.)
```
