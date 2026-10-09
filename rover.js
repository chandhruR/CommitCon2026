export class RoverAlgorithm {
    constructor(startX, startY, config) {
        this.x = startX;
        this.y = startY;
        this.baseX = startX;
        this.baseY = startY;
        this.energy = config.maxEnergy;
        this.maxEnergy = config.maxEnergy;
        this.config = config;
        
        // Multi-tier inventory
        this.inventory = {
            low: 0,
            med: 0,
            high: 0
        };
        this.uploadedData = {
            low: 0,
            med: 0,
            high: 0
        };
        this.totalScore = 0;
        
        this.state = 'INITIALIZING';
        this.decisionReason = 'Calibrating sensors at landing site';
        
        // Belief Map: null = unexplored, '.' = clear, '#' = obstacle/crater, 'B' = base,
        // 'D_LOW' / 'D_MED' / 'D_HIGH' = data cache, 'C' = comm dish
        this.beliefMap = Array.from({length: config.rows}, () => Array(config.cols).fill(null));
        this.beliefMap[startY][startX] = 'B';

        // Terrain cost belief: 1 for regular, 2 for rough, 3 for steep ridge
        this.terrainBelief = Array.from({length: config.rows}, () => Array(config.cols).fill(1));

        this.currentPath = [];
        this.currentTarget = null;
        this.targetType = null;
        
        // Metrics & Analytics
        this.cellsExplored = 1;
        this.totalCells = config.rows * config.cols;
        this.totalDistanceTraveled = 0;
        this.replansTriggered = 0;
        this.stormEventsEvaded = 0;
        
        // Energy consumption model
        this.baseMoveCost = 1.0;
        this.carryingPayloadMassCost = 0.15; // Energy cost penalty per data crystal carried
    }

    getPayloadCount() {
        return this.inventory.low + this.inventory.med + this.inventory.high;
    }

    getPayloadScore() {
        return (this.inventory.low * 10) + (this.inventory.med * 25) + (this.inventory.high * 60);
    }

    getUploadedScore() {
        return (this.uploadedData.low * 10) + (this.uploadedData.med * 25) + (this.uploadedData.high * 60);
    }

    observe(world) {
        const r = 2; // 5x5 sensor radius
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const ny = this.y + dy;
                const nx = this.x + dx;
                if (ny >= 0 && ny < this.config.rows && nx >= 0 && nx < this.config.cols) {
                    if (this.beliefMap[ny][nx] === null) {
                        this.cellsExplored++;
                    }
                    if (this.beliefMap[ny][nx] !== 'B') {
                        this.beliefMap[ny][nx] = world.map[ny][nx];
                        this.terrainBelief[ny][nx] = world.terrain[ny][nx] || 1;
                    }
                }
            }
        }
    }

    // A* Pathfinding considering terrain elevation, obstacle hazards, and carry weight
    aStar(startX, startY, isGoalFn, onlyExplored = false) {
        const key = (x, y) => `${x},${y}`;
        const openSet = [{ x: startX, y: startY, f: 0, g: 0 }];
        const cameFrom = new Map();
        const gScore = new Map();
        gScore.set(key(startX, startY), 0);

        const closedSet = new Set();
        const payloadPenalty = 1 + (this.getPayloadCount() * this.carryingPayloadMassCost);

        while (openSet.length > 0) {
            // Find node in openSet with lowest f score
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift();
            const currKey = key(current.x, current.y);

            if (isGoalFn(current.x, current.y)) {
                // Reconstruct trajectory
                const path = [];
                let traceKey = currKey;
                while (traceKey && traceKey !== key(startX, startY)) {
                    const [tx, ty] = traceKey.split(',').map(Number);
                    path.unshift([tx, ty]);
                    traceKey = cameFrom.get(traceKey);
                }
                return { path, target: [current.x, current.y], cost: gScore.get(currKey) };
            }

            closedSet.add(currKey);

            const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
            for (const [dx, dy] of dirs) {
                const nx = current.x + dx;
                const ny = current.y + dy;

                if (nx < 0 || nx >= this.config.cols || ny < 0 || ny >= this.config.rows) continue;

                const nKey = key(nx, ny);
                if (closedSet.has(nKey)) continue;

                const cell = this.beliefMap[ny][nx];
                if (cell === '#') continue; // Impassable crater or active dustwall
                if (onlyExplored && cell === null) continue; // Unexplored fog cell

                // Movement energy cost with terrain roughness factor
                const roughness = this.terrainBelief[ny][nx] || 1;
                const stepCost = (roughness * this.baseMoveCost) * payloadPenalty;
                const tentativeG = gScore.get(currKey) + stepCost;

                if (!gScore.has(nKey) || tentativeG < gScore.get(nKey)) {
                    cameFrom.set(nKey, currKey);
                    gScore.set(nKey, tentativeG);

                    // Admissible heuristic: Manhattan distance
                    const h = isGoalFn.targetPos ? (Math.abs(nx - isGoalFn.targetPos[0]) + Math.abs(ny - isGoalFn.targetPos[1])) : 0;
                    const f = tentativeG + h;

                    const existing = openSet.find(n => n.x === nx && n.y === ny);
                    if (!existing) {
                        openSet.push({ x: nx, y: ny, f, g: tentativeG });
                    } else if (tentativeG < existing.g) {
                        existing.g = tentativeG;
                        existing.f = f;
                    }
                }
            }
        }

        return null;
    }

    getSafeCostToBase() {
        const goalFn = (x, y) => x === this.baseX && y === this.baseY;
        goalFn.targetPos = [this.baseX, this.baseY];
        const res = this.aStar(this.x, this.y, goalFn, true);
        if (res) return res.cost;
        const optRes = this.aStar(this.x, this.y, goalFn, false);
        return optRes ? optRes.cost : Infinity;
    }

    getPathToBase() {
        const goalFn = (x, y) => x === this.baseX && y === this.baseY;
        goalFn.targetPos = [this.baseX, this.baseY];
        let res = this.aStar(this.x, this.y, goalFn, true);
        if (!res) {
            res = this.aStar(this.x, this.y, goalFn, false);
        }
        return res;
    }

    // High-Level Utility / Value-to-Risk Planner
    decideNextMission(world) {
        const safeBaseCost = this.getSafeCostToBase();
        const emergencyBuffer = 35; // Safe reserve for sandstorms and rough detours

        // 1. Critical Return Override
        if (this.energy <= safeBaseCost + emergencyBuffer) {
            this.state = 'RETURNING';
            this.decisionReason = `Critical energy (${Math.round(this.energy)}J). Safe return cost: ${Math.round(safeBaseCost)}J + reserve. Heading Base.`;
            this.targetType = 'BASE';
            return this.getPathToBase();
        }

        // 2. Discover and Uplink Payload if holding valuable data
        const payloadCount = this.getPayloadCount();
        const payloadVal = this.getPayloadScore();

        // Locate known Comm Relays
        const commGoalFn = (x, y) => this.beliefMap[y][x] === 'C';
        const nearestComm = this.aStar(this.x, this.y, commGoalFn, false);

        if (payloadCount >= 2 || (payloadVal >= 50 && nearestComm) || (this.energy <= safeBaseCost + 120 && payloadCount > 0 && nearestComm)) {
            if (nearestComm) {
                const [cx, cy] = nearestComm.target;
                const homeFromCommFn = (x, y) => x === this.baseX && y === this.baseY;
                homeFromCommFn.targetPos = [this.baseX, this.baseY];
                const homeFromComm = this.aStar(cx, cy, homeFromCommFn, false)?.cost || 999;

                if (this.energy > nearestComm.cost + homeFromComm + emergencyBuffer) {
                    this.state = 'UPLINK_TRANSIT';
                    this.decisionReason = `Transmitting ${payloadCount} crystals (${payloadVal}pts) via Relay [${cx}, ${cy}].`;
                    this.targetType = 'COMM';
                    return nearestComm;
                }
            }
        }

        // 3. Evaluate known Data Crystals by ROI (Utility = Score / (PathCost + ReturnPenalty))
        const knownDataSites = [];
        for (let y = 0; y < this.config.rows; y++) {
            for (let x = 0; x < this.config.cols; x++) {
                const c = this.beliefMap[y][x];
                if (c && c.startsWith('D_')) {
                    const tier = c.split('_')[1];
                    const pts = tier === 'HIGH' ? 60 : (tier === 'MED' ? 25 : 10);
                    knownDataSites.push({ x, y, tier, pts });
                }
            }
        }

        if (knownDataSites.length > 0 && payloadCount < 4) {
            let bestSite = null;
            let bestUtility = -Infinity;
            let bestPath = null;

            for (const site of knownDataSites) {
                const dataGoalFn = (x, y) => x === site.x && y === site.y;
                dataGoalFn.targetPos = [site.x, site.y];
                const res = this.aStar(this.x, this.y, dataGoalFn, false);

                if (res) {
                    const [dx, dy] = res.target;
                    const homeFromDataFn = (x, y) => x === this.baseX && y === this.baseY;
                    homeFromDataFn.targetPos = [this.baseX, this.baseY];
                    const homeCost = this.aStar(dx, dy, homeFromDataFn, false)?.cost || 999;

                    // Ensure safe return feasibility
                    if (this.energy > res.cost + homeCost + emergencyBuffer) {
                        // Utility = Value / Estimated Energy Investment
                        const utility = site.pts / Math.max(1, (res.cost + 5));
                        if (utility > bestUtility) {
                            bestUtility = utility;
                            bestSite = site;
                            bestPath = res;
                        }
                    }
                }
            }

            if (bestPath) {
                this.state = 'EXTRACTION';
                this.decisionReason = `Navigating to ${bestSite.tier} tier Data (+${bestSite.pts}pts) at [${bestSite.x}, ${bestSite.y}] (ROI: ${bestUtility.toFixed(2)}).`;
                this.targetType = 'DATA';
                return bestPath;
            }
        }

        // 4. Frontier Exploration (Explore nearest boundary to unknown planet sectors)
        const frontierGoalFn = (x, y) => this.beliefMap[y][x] === null;
        const frontierRes = this.aStar(this.x, this.y, frontierGoalFn, false);

        if (frontierRes) {
            const [fx, fy] = frontierRes.target;
            const homeFromFrontierFn = (x, y) => x === this.baseX && y === this.baseY;
            homeFromFrontierFn.targetPos = [this.baseX, this.baseY];
            const homeCost = this.aStar(fx, fy, homeFromFrontierFn, false)?.cost || 999;

            if (this.energy > frontierRes.cost + homeCost + emergencyBuffer) {
                this.state = 'EXPLORING';
                this.decisionReason = `Scanning uncharted planetary sector near [${fx}, ${fy}].`;
                this.targetType = 'FRONTIER';
                return frontierRes;
            }
        }

        // 5. No further safe exploration reachable; return to base station
        this.state = 'RETURNING';
        this.decisionReason = 'All accessible perimeter surveyed. Commencing safe home docking.';
        this.targetType = 'BASE';
        return this.getPathToBase();
    }

    step(world) {
        if (this.energy <= 0) {
            return {
                done: true,
                success: false,
                reason: 'Energy depleted in alien wasteland.',
                msg: 'CRITICAL FAILURE: Energy reserves drained.',
                type: 'error'
            };
        }

        // 1. Sense and observe surroundings
        this.observe(world);

        // 2. Interact with current tile
        const currentCell = world.map[this.y][this.x];

        // Harvesting Alien Data
        if (currentCell && currentCell.startsWith('D_')) {
            const tier = currentCell.split('_')[1].toLowerCase();
            this.inventory[tier]++;
            const pts = tier === 'high' ? 60 : (tier === 'med' ? 25 : 10);

            world.map[this.y][this.x] = '.';
            this.beliefMap[this.y][this.x] = '.';
            this.currentPath = []; // Invalidate path to replan next best opportunity
            
            return {
                msg: `Harvested ${tier.toUpperCase()} Data Crystal (+${pts} pts)! Payload Mass: ${this.getPayloadCount()}`,
                type: 'success'
            };
        }

        // Transmitting through Comm Zone
        if (currentCell === 'C' && this.getPayloadCount() > 0) {
            const count = this.getPayloadCount();
            const earned = (this.inventory.low * 10) + (this.inventory.med * 25) + (this.inventory.high * 60);

            this.uploadedData.low += this.inventory.low;
            this.uploadedData.med += this.inventory.med;
            this.uploadedData.high += this.inventory.high;
            this.totalScore += earned;

            this.inventory.low = 0;
            this.inventory.med = 0;
            this.inventory.high = 0;

            this.currentPath = []; // Force replan

            return {
                msg: `Orbital Uplink Established: Transmitted ${count} data cores (+${earned} score secured)!`,
                type: 'success'
            };
        }

        // Safe Base Docking
        if (this.x === this.baseX && this.y === this.baseY && (this.state === 'RETURNING' || this.energy <= 40)) {
            // Unload remaining payloads at base
            const remainingCount = this.getPayloadCount();
            const remainingScore = this.getPayloadScore();
            if (remainingCount > 0) {
                this.uploadedData.low += this.inventory.low;
                this.uploadedData.med += this.inventory.med;
                this.uploadedData.high += this.inventory.high;
                this.totalScore += remainingScore;
                this.inventory.low = 0;
                this.inventory.med = 0;
                this.inventory.high = 0;
            }

            return {
                done: true,
                success: true,
                reason: `Mission complete! Secured ${this.getUploadedScore()} points with ${Math.round(this.energy)}J energy remaining.`,
                msg: `Docking confirmed at Base Station. Final Scientific Yield: ${this.totalScore} pts!`,
                type: 'success'
            };
        }

        // Check if next tile in planned path is suddenly blocked (e.g., dynamic dust wall)
        if (this.currentPath.length > 0) {
            const [nx, ny] = this.currentPath[0];
            if (this.beliefMap[ny][nx] === '#') {
                this.replansTriggered++;
                this.currentPath = [];
                return {
                    msg: `Path blocked by dynamic obstruction at [${nx}, ${ny}]! Recalculating trajectory...`,
                    type: 'warning'
                };
            }
        }

        // Calculate Plan if no path exists
        if (this.currentPath.length === 0) {
            const plan = this.decideNextMission(world);
            if (!plan || plan.path.length === 0) {
                const returnPlan = this.getPathToBase();
                if (returnPlan && returnPlan.path.length > 0) {
                    this.state = 'RETURNING';
                    this.decisionReason = 'Forced emergency backtrack to Base';
                    this.currentPath = returnPlan.path;
                } else if (this.x === this.baseX && this.y === this.baseY) {
                    return {
                        done: true,
                        success: true,
                        reason: `Exploration concluded. Total Data Yield: ${this.getUploadedScore()} pts.`,
                        msg: 'Surrounding sectors fully surveyed. Mission accomplished.',
                        type: 'info'
                    };
                } else {
                    return {
                        done: true,
                        success: false,
                        reason: 'Rover trapped by impenetrable terrain.',
                        msg: 'EMERGENCY: All escape vectors blocked.',
                        type: 'error'
                    };
                }
            } else {
                this.currentPath = plan.path;
            }
        }

        // Execute motion step
        if (this.currentPath.length > 0) {
            const [nx, ny] = this.currentPath.shift();
            
            // Check world collision
            if (world.map[ny][nx] !== '#') {
                this.x = nx;
                this.y = ny;
                this.totalDistanceTraveled++;

                // Energy consumption = base + terrain cost + payload weight penalty
                const terrainFriction = world.terrain[ny][nx] || 1;
                const weightFactor = 1 + (this.getPayloadCount() * this.carryingPayloadMassCost);
                const stepEnergy = terrainFriction * this.baseMoveCost * weightFactor;

                this.energy = Math.max(0, this.energy - stepEnergy);
            } else {
                // Unexpected obstacle detected!
                this.beliefMap[ny][nx] = '#';
                this.replansTriggered++;
                this.currentPath = [];
                return {
                    msg: `Obstacle collision avoided at [${nx}, ${ny}]. Dynamic replan engaged.`,
                    type: 'warning'
                };
            }
        }

        return { msg: null };
    }
}
