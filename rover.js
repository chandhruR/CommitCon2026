export class RoverAlgorithm {
    constructor(startX, startY, startZ, config) {
        this.x = startX;
        this.y = startY;
        this.z = startZ !== undefined ? startZ : Math.floor(config.layers / 2);
        this.baseX = this.x;
        this.baseY = this.y;
        this.baseZ = this.z;

        this.energy = config.maxEnergy || 1800;
        this.maxEnergy = config.maxEnergy || 1800;
        this.config = {
            rows: config.rows || 16,
            cols: config.cols || 16,
            layers: config.layers || 16,
            ...config
        };
        
        // Multi-tier inventory
        this.inventory = { low: 0, med: 0, high: 0 };
        this.uploadedData = { low: 0, med: 0, high: 0 };
        this.totalScore = 0;
        
        this.state = 'INITIALIZING';
        this.decisionReason = 'Calibrating zero-g thrusters and space radar';
        
        // 3D Belief Map: null = unexplored, '.' = empty space, '#' = asteroid/rock, 'B' = mothership base,
        // 'D_LOW' / 'D_MED' / 'D_HIGH' = space crystal, 'C' = comm beacon, 'X' = hazard field
        this.beliefMap = Array.from({ length: this.config.layers }, () =>
            Array.from({ length: this.config.rows }, () =>
                Array(this.config.cols).fill(null)
            )
        );
        this.beliefMap[this.z][this.y][this.x] = 'B';

        // 3D Hazard/Density belief (1 = normal void, 2 = cosmic dust/rough, 3 = high radiation)
        this.terrainBelief = Array.from({ length: this.config.layers }, () =>
            Array.from({ length: this.config.rows }, () =>
                Array(this.config.cols).fill(1)
            )
        );

        this.currentPath = [];
        this.currentTarget = null;
        this.targetType = null;
        
        // Metrics & Analytics
        this.cellsExplored = 1;
        this.totalCells = this.config.cols * this.config.rows * this.config.layers;
        this.totalDistanceTraveled = 0;
        this.replansTriggered = 0;
        this.stormEventsEvaded = 0;
        
        // Zero-G Thruster Energy consumption model
        this.baseMoveCost = 1.0;
        this.carryingPayloadMassCost = 0.18; // Mass inertia penalty per data crystal carried
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

    // 3D Radar Sensor Observation
    observe(world) {
        const r = 2; // 3D sphere sensor radius
        for (let dz = -r; dz <= r; dz++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    const nz = this.z + dz;
                    const ny = this.y + dy;
                    const nx = this.x + dx;

                    if (
                        nz >= 0 && nz < this.config.layers &&
                        ny >= 0 && ny < this.config.rows &&
                        nx >= 0 && nx < this.config.cols
                    ) {
                        if (this.beliefMap[nz][ny][nx] === null) {
                            this.cellsExplored++;
                        }
                        if (this.beliefMap[nz][ny][nx] !== 'B') {
                            this.beliefMap[nz][ny][nx] = world.map[nz][ny][nx];
                            this.terrainBelief[nz][ny][nx] = world.terrain[nz][ny][nx] || 1;
                        }
                    }
                }
            }
        }
    }

    // 3D A* Pathfinding considering space rocks, hazard zones, and zero-g inertia
    aStar(startX, startY, startZ, isGoalFn, onlyExplored = false) {
        const key = (x, y, z) => `${x},${y},${z}`;
        const openSet = [{ x: startX, y: startY, z: startZ, f: 0, g: 0 }];
        const cameFrom = new Map();
        const gScore = new Map();
        const startKey = key(startX, startY, startZ);
        gScore.set(startKey, 0);

        const closedSet = new Set();
        const payloadPenalty = 1 + (this.getPayloadCount() * this.carryingPayloadMassCost);

        // Predefine 3D directions (26 neighborhood: 6 cardinal + 12 face diagonals + 8 corner diagonals)
        const dirs = [];
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    dirs.push({ dx, dy, dz, dist: Math.hypot(dx, dy, dz) });
                }
            }
        }

        let iterations = 0;
        const maxIter = 3000;

        while (openSet.length > 0 && iterations++ < maxIter) {
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift();
            const currKey = key(current.x, current.y, current.z);

            if (isGoalFn(current.x, current.y, current.z)) {
                // Reconstruct 3D path
                const path = [];
                let traceKey = currKey;
                while (traceKey && traceKey !== startKey) {
                    const [tx, ty, tz] = traceKey.split(',').map(Number);
                    path.unshift([tx, ty, tz]);
                    traceKey = cameFrom.get(traceKey);
                }
                return { path, target: [current.x, current.y, current.z], cost: gScore.get(currKey) };
            }

            closedSet.add(currKey);

            for (const { dx, dy, dz, dist } of dirs) {
                const nx = current.x + dx;
                const ny = current.y + dy;
                const nz = current.z + dz;

                if (
                    nx < 0 || nx >= this.config.cols ||
                    ny < 0 || ny >= this.config.rows ||
                    nz < 0 || nz >= this.config.layers
                ) continue;

                const nKey = key(nx, ny, nz);
                if (closedSet.has(nKey)) continue;

                const cell = this.beliefMap[nz][ny][nx];
                if (cell === '#') continue; // Impassable asteroid rock
                if (onlyExplored && cell === null) continue; // Unexplored fog space

                const hazard = this.terrainBelief[nz][ny][nx] || 1;
                const stepCost = (dist * hazard * this.baseMoveCost) * payloadPenalty;
                const tentativeG = gScore.get(currKey) + stepCost;

                if (!gScore.has(nKey) || tentativeG < gScore.get(nKey)) {
                    cameFrom.set(nKey, currKey);
                    gScore.set(nKey, tentativeG);

                    // 3D Euclidean distance heuristic
                    let h = 0;
                    if (isGoalFn.targetPos) {
                        const [tx, ty, tz] = isGoalFn.targetPos;
                        h = Math.hypot(nx - tx, ny - ty, nz - tz);
                    }
                    const f = tentativeG + h;

                    const existing = openSet.find(n => n.x === nx && n.y === ny && n.z === nz);
                    if (!existing) {
                        openSet.push({ x: nx, y: ny, z: nz, f, g: tentativeG });
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
        const goalFn = (x, y, z) => x === this.baseX && y === this.baseY && z === this.baseZ;
        goalFn.targetPos = [this.baseX, this.baseY, this.baseZ];
        const res = this.aStar(this.x, this.y, this.z, goalFn, true);
        if (res) return res.cost;
        const optRes = this.aStar(this.x, this.y, this.z, goalFn, false);
        return optRes ? optRes.cost : Infinity;
    }

    getPathToBase() {
        const goalFn = (x, y, z) => x === this.baseX && y === this.baseY && z === this.baseZ;
        goalFn.targetPos = [this.baseX, this.baseY, this.baseZ];
        let res = this.aStar(this.x, this.y, this.z, goalFn, true);
        if (!res) {
            res = this.aStar(this.x, this.y, this.z, goalFn, false);
        }
        return res;
    }

    // High-Level 3D Zero-G Space Mission Planner
    decideNextMission(world) {
        const safeBaseCost = this.getSafeCostToBase();
        const emergencyBuffer = 40; // Thruster reserve for asteroid avoidance & cosmic storms

        // 1. Critical Return Override
        if (this.energy <= safeBaseCost + emergencyBuffer) {
            this.state = 'RETURNING';
            this.decisionReason = `Critical fuel (${Math.round(this.energy)}J). Vectoring to Mothership Station. Base Return Cost: ${Math.round(safeBaseCost)}J.`;
            this.targetType = 'BASE';
            return this.getPathToBase();
        }

        // 2. Discover and Uplink Payload if holding valuable data crystals
        const payloadCount = this.getPayloadCount();
        const payloadVal = this.getPayloadScore();

        const commGoalFn = (x, y, z) => this.beliefMap[z][y][x] === 'C';
        const nearestComm = this.aStar(this.x, this.y, this.z, commGoalFn, false);

        if (payloadCount >= 2 || (payloadVal >= 50 && nearestComm) || (this.energy <= safeBaseCost + 140 && payloadCount > 0 && nearestComm)) {
            if (nearestComm) {
                const [cx, cy, cz] = nearestComm.target;
                const homeFromCommFn = (x, y, z) => x === this.baseX && y === this.baseY && z === this.baseZ;
                homeFromCommFn.targetPos = [this.baseX, this.baseY, this.baseZ];
                const homeFromComm = this.aStar(cx, cy, cz, homeFromCommFn, false)?.cost || 999;

                if (this.energy > nearestComm.cost + homeFromComm + emergencyBuffer) {
                    this.state = 'UPLINK_TRANSIT';
                    this.decisionReason = `Transmitting ${payloadCount} crystals (${payloadVal}pts) via Comm Beacon [${cx}, ${cy}, ${cz}].`;
                    this.targetType = 'COMM';
                    return nearestComm;
                }
            }
        }

        // 3. Evaluate known Space Data Crystals by ROI (Utility = Score / Energy Investment)
        const knownDataSites = [];
        for (let z = 0; z < this.config.layers; z++) {
            for (let y = 0; y < this.config.rows; y++) {
                for (let x = 0; x < this.config.cols; x++) {
                    const c = this.beliefMap[z][y][x];
                    if (c && c.startsWith('D_')) {
                        const tier = c.split('_')[1];
                        const pts = tier === 'HIGH' ? 60 : (tier === 'MED' ? 25 : 10);
                        knownDataSites.push({ x, y, z, tier, pts });
                    }
                }
            }
        }

        if (knownDataSites.length > 0 && payloadCount < 4) {
            let bestSite = null;
            let bestUtility = -Infinity;
            let bestPath = null;

            for (const site of knownDataSites) {
                const dataGoalFn = (x, y, z) => x === site.x && y === site.y && z === site.z;
                dataGoalFn.targetPos = [site.x, site.y, site.z];
                const res = this.aStar(this.x, this.y, this.z, dataGoalFn, false);

                if (res) {
                    const [dx, dy, dz] = res.target;
                    const homeFromDataFn = (x, y, z) => x === this.baseX && y === this.baseY && z === this.baseZ;
                    homeFromDataFn.targetPos = [this.baseX, this.baseY, this.baseZ];
                    const homeCost = this.aStar(dx, dy, dz, homeFromDataFn, false)?.cost || 999;

                    if (this.energy > res.cost + homeCost + emergencyBuffer) {
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
                this.decisionReason = `Intercepting ${bestSite.tier} Space Crystal (+${bestSite.pts}pts) at 3D pos [${bestSite.x}, ${bestSite.y}, ${bestSite.z}] (ROI: ${bestUtility.toFixed(2)}).`;
                this.targetType = 'DATA';
                return bestPath;
            }
        }

        // 4. Frontier 3D Space Exploration
        const frontierGoalFn = (x, y, z) => this.beliefMap[z][y][x] === null;
        const frontierRes = this.aStar(this.x, this.y, this.z, frontierGoalFn, false);

        if (frontierRes) {
            const [fx, fy, fz] = frontierRes.target;
            const homeFromFrontierFn = (x, y, z) => x === this.baseX && y === this.baseY && z === this.baseZ;
            homeFromFrontierFn.targetPos = [this.baseX, this.baseY, this.baseZ];
            const homeCost = this.aStar(fx, fy, fz, homeFromFrontierFn, false)?.cost || 999;

            if (this.energy > frontierRes.cost + homeCost + emergencyBuffer) {
                this.state = 'EXPLORING';
                this.decisionReason = `Scanning uncharted deep space sector near coordinates [${fx}, ${fy}, ${fz}].`;
                this.targetType = 'FRONTIER';
                return frontierRes;
            }
        }

        // 5. Survey complete; return to Mothership
        this.state = 'RETURNING';
        this.decisionReason = 'All 3D space sectors surveyed. Returning to Mothership Station docking bay.';
        this.targetType = 'BASE';
        return this.getPathToBase();
    }

    step(world) {
        if (this.energy <= 0) {
            return {
                done: true,
                success: false,
                reason: 'Thruster fuel depleted in deep space void.',
                msg: 'CRITICAL FAILURE: Zero-G energy core drained completely.',
                type: 'error'
            };
        }

        // 1. Observe 3D surroundings
        this.observe(world);

        // 2. Interact with current 3D voxel
        const currentCell = world.map[this.z][this.y][this.x];

        // Harvesting Floating Data Crystal
        if (currentCell && currentCell.startsWith('D_')) {
            const tier = currentCell.split('_')[1].toLowerCase();
            this.inventory[tier]++;
            const pts = tier === 'high' ? 60 : (tier === 'med' ? 25 : 10);

            world.map[this.z][this.y][this.x] = '.';
            this.beliefMap[this.z][this.y][this.x] = '.';
            this.currentPath = []; // Replanning
            
            return {
                msg: `Harvested ${tier.toUpperCase()} Space Crystal (+${pts} pts)! Payload Mass: ${this.getPayloadCount()}`,
                type: 'success'
            };
        }

        // Uplinking through Comm Relay
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

            this.currentPath = []; // Replanning

            return {
                msg: `Space Satellite Uplink Active: Securely beamed ${count} data cores (+${earned} pts)!`,
                type: 'success'
            };
        }

        // Docking at Mothership Base
        if (this.x === this.baseX && this.y === this.baseY && this.z === this.baseZ && (this.state === 'RETURNING' || this.energy <= 40)) {
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
                msg: `Docking confirmed at Mothership Station. Total Scientific Yield: ${this.totalScore} pts!`,
                type: 'success'
            };
        }

        // Check if next 3D step in path is blocked by rock
        if (this.currentPath.length > 0) {
            const [nx, ny, nz] = this.currentPath[0];
            if (this.beliefMap[nz][ny][nx] === '#') {
                this.replansTriggered++;
                this.currentPath = [];
                return {
                    msg: `Trajectory blocked by drifting asteroid rock at [${nx}, ${ny}, ${nz}]! Recalculating vector...`,
                    type: 'warning'
                };
            }
        }

        // Calculate Plan if path empty
        if (this.currentPath.length === 0) {
            const plan = this.decideNextMission(world);
            if (!plan || plan.path.length === 0) {
                const returnPlan = this.getPathToBase();
                if (returnPlan && returnPlan.path.length > 0) {
                    this.state = 'RETURNING';
                    this.decisionReason = 'Forced emergency backtrack to Mothership Station';
                    this.currentPath = returnPlan.path;
                } else if (this.x === this.baseX && this.y === this.baseY && this.z === this.baseZ) {
                    return {
                        done: true,
                        success: true,
                        reason: `3D Deep Space Survey concluded. Yield: ${this.getUploadedScore()} pts.`,
                        msg: 'All 3D space sectors fully surveyed.',
                        type: 'info'
                    };
                } else {
                    return {
                        done: true,
                        success: false,
                        reason: 'Space probe surrounded by dense asteroid cluster.',
                        msg: 'EMERGENCY: Thruster escape vectors blocked.',
                        type: 'error'
                    };
                }
            } else {
                this.currentPath = plan.path;
            }
        }

        // Execute 3D move step
        if (this.currentPath.length > 0) {
            const [nx, ny, nz] = this.currentPath.shift();
            
            if (world.map[nz][ny][nx] !== '#') {
                this.x = nx;
                this.y = ny;
                this.z = nz;
                this.totalDistanceTraveled++;

                const hazard = world.terrain[nz][ny][nx] || 1;
                const weightFactor = 1 + (this.getPayloadCount() * this.carryingPayloadMassCost);
                const stepEnergy = hazard * this.baseMoveCost * weightFactor;

                this.energy = Math.max(0, this.energy - stepEnergy);
            } else {
                this.beliefMap[nz][ny][nx] = '#';
                this.replansTriggered++;
                this.currentPath = [];
                return {
                    msg: `Asteroid proximity warning at [${nx}, ${ny}, ${nz}]. Autonomous evasion engaged.`,
                    type: 'warning'
                };
            }
        }

        return { msg: null };
    }
}

