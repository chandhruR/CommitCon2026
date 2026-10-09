// 3D view of the planet. Reads mission state every frame; never changes it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { N, SAMPLE_TYPES, COMM_R, SENSOR_R } from './sim.js';

export const VALUE_COLORS = ['#7357c4', '#9473e0', '#b596f2', '#dcc8ff'];
const VS = 0.2;                 // metres -> scene units (1 cell = 10 m = 1 unit, relief exaggerated 2x)
const HALF = (N - 1) / 2;
const SOIL = [new THREE.Color('#b0603a'), new THREE.Color('#cf9459'), new THREE.Color('#6b412e')];
const FOG = new THREE.Color('#2a1c17');
const OCHRE = new THREE.Color('#e8a34a');
const TEAL = new THREE.Color('#2a9e8f');
const HAZARD = new THREE.Color('#e5573f');
const TOOL_RADIUS = { slide: 1.6, storm: 5, outage: COMM_R + 0.5 };

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.15, ...extra });
const shadowed = obj => { obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return obj; };

function makeRover() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.18, 0.55), std('#ddd5c6', { metalness: 0.35 }));
    body.position.y = 0.05;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.68), std('#24324a', { metalness: 0.5, roughness: 0.35 }));
    deck.position.y = 0.17;
    g.add(body, deck);
    const wheelGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.1, 14).rotateX(Math.PI / 2);
    for (const x of [-0.32, 0, 0.32]) for (const z of [-0.34, 0.34]) {
        const w = new THREE.Mesh(wheelGeo, std('#2a2320', { roughness: 0.95 }));
        w.position.set(x, -0.1, z);
        g.add(w);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55), std('#cfc6b6'));
    mast.position.set(0.28, 0.45, -0.15);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.22), std('#e8e2d6'));
    head.position.set(0.3, 0.74, -0.15);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: '#000', emissive: OCHRE, emissiveIntensity: 2 }));
    eye.position.set(0.38, 0.74, -0.15);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45), std('#cfc6b6'));
    antenna.position.set(-0.3, 0.4, 0.2);
    g.add(mast, head, eye, antenna);
    return shadowed(g);
}

function makeLander() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.68, 0.5, 8), std('#c79a43', { metalness: 0.6, roughness: 0.4 }));
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.12, 8), std('#d9d2c3'));
    deck.position.y = 0.31;
    g.add(body, deck);
    for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95), std('#9c9384'));
        leg.position.set(Math.cos(a) * 0.72, -0.2, Math.sin(a) * 0.72);
        leg.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55);
        g.add(leg);
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), std('#e9e4da', { side: THREE.DoubleSide }));
    dish.position.set(0.15, 0.55, 0);
    dish.rotation.z = 0.5;
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshStandardMaterial({ color: '#000', emissive: OCHRE, emissiveIntensity: 2 }));
    beacon.position.set(-0.2, 0.45, 0.15);
    g.add(dish, beacon);
    g.userData.beacon = beacon;
    return shadowed(g);
}

function makeTower() {
    const g = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, 2.4, 6), std('#cfc6b6'));
    mast.position.y = 1.2;
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), std('#e9e4da', { side: THREE.DoubleSide }));
    dish.position.y = 2.35;
    dish.rotation.x = -0.6;
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshStandardMaterial({ color: '#000', emissive: TEAL, emissiveIntensity: 2.5 }));
    light.position.y = 2.5;
    g.add(mast, dish, light);
    g.userData.light = light;
    return shadowed(g);
}

export class View3D {
    constructor(el, { onCellClick, onCellHover }) {
        this.el = el;
        this.onCellClick = onCellClick;
        this.onCellHover = onCellHover;
        this.reveal = false;
        this.follow = true;
        this.tool = null;
        this.tps = 10;

        const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        r.setPixelRatio(Math.min(devicePixelRatio, 2));
        r.shadowMap.enabled = true;
        r.shadowMap.type = THREE.PCFSoftShadowMap;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.2;
        el.appendChild(r.domElement);

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog('#7d4429', 50, 125);
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
        this.controls = new OrbitControls(this.camera, r.domElement);
        this.controls.enableDamping = true;
        this.controls.maxPolarAngle = 1.3;
        this.controls.minDistance = 6;
        this.controls.maxDistance = 95;

        this.scene.add(new THREE.HemisphereLight('#f6c08a', '#3a2216', 1.05));
        const sun = new THREE.DirectionalLight('#ffd9ae', 2.6);
        sun.position.set(-32, 28, -18);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 120 });
        sun.shadow.bias = -0.0006;
        this.scene.add(sun);

        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Pointer: click (not drag) triggers the active tool, hover previews its footprint
        this.raycaster = new THREE.Raycaster();
        let down = null;
        r.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
        r.domElement.addEventListener('pointerup', e => {
            if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) {
                const c = this.pick(e);
                if (c >= 0) this.onCellClick(c);
            }
            down = null;
        });
        r.domElement.addEventListener('pointermove', e => { this.hoverCell = this.pick(e); this.onCellHover?.(this.hoverCell); });
        r.domElement.addEventListener('pointerleave', () => { this.hoverCell = -1; });

        new ResizeObserver(() => this.resize()).observe(el);
        this.resize();
    }

    resize() {
        const w = this.el.clientWidth, h = this.el.clientHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    pick(e) {
        if (!this.terrain) return -1;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
        const hit = this.raycaster.intersectObject(this.terrain)[0];
        if (!hit) return -1;
        const x = Math.round(hit.point.x + HALF), y = Math.round(hit.point.z + HALF);
        return x >= 0 && y >= 0 && x < N && y < N ? y * N + x : -1;
    }

    // Terrain height (scene units) at a scene position, bilinear between cell centres.
    heightAt(wx, wz) {
        const h = this.world.h;
        const gx = Math.min(N - 1.001, Math.max(0, wx + HALF)), gy = Math.min(N - 1.001, Math.max(0, wz + HALF));
        const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
        const a = h[y0 * N + x0], b = h[y0 * N + x0 + 1], c = h[(y0 + 1) * N + x0], d = h[(y0 + 1) * N + x0 + 1];
        return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) * VS;
    }

    cellPos(c, lift = 0) {
        const x = c % N, y = Math.floor(c / N);
        return new THREE.Vector3(x - HALF, this.world.h[c] * VS + lift, y - HALF);
    }

    ringLine(color, opacity, points = 72) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3));
        const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
        line.userData.points = points;
        line.frustumCulled = false;
        this.group.add(line);
        return line;
    }

    placeRing(line, cx, cz, r, lift = 0.12) {
        const pos = line.geometry.attributes.position, n = line.userData.points;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
            pos.setXYZ(i, x, this.heightAt(x, z) + lift, z);
        }
        pos.needsUpdate = true;
    }

    load(mission) {
        this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
        this.scene.remove(this.group);
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.mission = mission;
        const w = this.world = mission.world;
        const rover = mission.rover;

        // Terrain: one vertex per cell, faceted, vertex-coloured by soil and elevation
        const geo = new THREE.PlaneGeometry(N - 1, N - 1, N - 1, N - 1).rotateX(-Math.PI / 2);
        const pos = geo.attributes.position;
        for (let i = 0; i < N * N; i++) pos.setY(i, w.h[i] * VS);
        geo.computeVertexNormals();
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
        this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }));
        this.terrain.receiveShadow = true;
        this.terrain.castShadow = true;
        this.group.add(this.terrain);
        let lo = Infinity, hi = -Infinity;
        for (const v of w.h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        this.baseColors = Array.from({ length: N * N }, (_, c) => {
            const shade = 0.78 + 0.38 * (w.h[c] - lo) / (hi - lo) + (((c * 2654435761) >>> 0) % 100) / 1400;
            return SOIL[w.soilIdx[c]].clone().multiplyScalar(shade);
        });
        this.knownSnap = new Uint8Array(N * N).fill(2); // 2 = force first paint

        // Boulders (instanced). Rockslides append to the same mesh.
        const boulderGeo = new THREE.DodecahedronGeometry(0.42, 0);
        const blockedCount = w.blocked.reduce((s, v) => s + v, 0);
        this.boulders = new THREE.InstancedMesh(boulderGeo, new THREE.MeshStandardMaterial({ color: '#5c3b2b', roughness: 1, flatShading: true }), blockedCount + 400);
        this.boulders.castShadow = true;
        this.boulders.receiveShadow = true;
        this.boulders.count = 0;
        this.boulderAt = new Map();
        this.boulderInfo = [];
        this.drops = [];
        for (let c = 0; c < N * N; c++) if (w.blocked[c]) this.addBoulder(c, false);
        this.group.add(this.boulders);

        this.lander = makeLander();
        this.lander.scale.setScalar(1.4);
        this.lander.position.copy(this.cellPos(w.base, 0.6));
        this.group.add(this.lander);

        this.towers = w.comms.map(t => {
            const g = makeTower();
            g.position.copy(this.cellPos(t.cell, 0));
            this.group.add(g);
            const ring = this.ringLine(TEAL, 0.9, 96);
            const p = this.cellPos(t.cell);
            this.placeRing(ring, p.x, p.z, COMM_R + 0.5, 0.08);
            const dome = new THREE.Mesh(new THREE.SphereGeometry(COMM_R + 0.5, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
            dome.position.set(p.x, p.y - 0.3, p.z);
            this.group.add(dome);
            return { t, g, ring, dome };
        });

        this.samples = new Map();
        for (const [c, s] of w.samples) {
            const color = new THREE.Color(VALUE_COLORS[s.type]);
            const size = [0.17, 0.21, 0.26, 0.34][s.type];
            const gem = new THREE.Mesh(new THREE.OctahedronGeometry(size), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3, transparent: true }));
            const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6, 1, true),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
            const g = new THREE.Group();
            g.add(gem, beam);
            beam.position.y = 1.2;
            g.position.copy(this.cellPos(c, 0.35));
            g.userData = { gem, beam, base: g.position.y, phase: c * 0.37, scale: 1 };
            this.group.add(g);
            this.samples.set(c, g);
        }

        this.roverMesh = makeRover();
        this.roverMesh.scale.setScalar(1.5);
        this.roverMesh.position.copy(this.cellPos(rover.pos, 0.36));
        this.roverTarget = this.roverMesh.position.clone();
        this.roverQuat = new THREE.Quaternion();
        this.group.add(this.roverMesh);

        this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: OCHRE, dashSize: 0.35, gapSize: 0.22, transparent: true, opacity: 0.95 }));
        this.pathLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 600), 3));
        this.pathLine.frustumCulled = false;
        this.group.add(this.pathLine);
        this.targetRing = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: OCHRE }));
        this.group.add(this.targetRing);
        this.sensorRing = this.ringLine('#f1e4d3', 0.22);
        this.toolRing = this.ringLine(HAZARD, 0.95, 64);

        this.storms = new Map();
        this.lastPlan = null;

        const target = this.cellPos(w.base);
        this.controls.target.copy(target);
        this.camera.position.copy(target).add(new THREE.Vector3(-14, 22, 24));
        this.controls.update();
        this.recolor(true);
    }

    addBoulder(c, drop) {
        if (this.boulders.count >= this.boulders.instanceMatrix.count) return;
        const i = this.boulders.count++;
        const rnd = k => (((c * 2654435761 + k * 40503) >>> 0) % 1000) / 1000;
        const p = this.cellPos(c, 0.12);
        p.x += (rnd(1) - 0.5) * 0.3;
        p.z += (rnd(2) - 0.5) * 0.3;
        const info = { cell: c, pos: p, rot: new THREE.Euler(rnd(3) * 6, rnd(4) * 6, rnd(5) * 6), scale: 0.75 + rnd(6) * 0.45, y: drop ? p.y + 7 : p.y, vy: 0 };
        this.boulderInfo[i] = info;
        this.boulderAt.set(c, i);
        if (drop) this.drops.push(i);
        this.writeBoulder(i, true);
    }

    writeBoulder(i, visible) {
        const b = this.boulderInfo[i], m = new THREE.Matrix4();
        const s = visible ? b.scale : 0;
        m.compose(new THREE.Vector3(b.pos.x, b.y, b.pos.z), new THREE.Quaternion().setFromEuler(b.rot), new THREE.Vector3(s, s * 0.8, s));
        this.boulders.setMatrixAt(i, m);
        this.boulders.instanceMatrix.needsUpdate = true;
    }

    // Fog of war: anything the rover hasn't seen is dark, unless "show what the rover hasn't seen" is on.
    recolor(all = false) {
        const known = this.mission.rover.belief.known, col = this.terrain.geometry.attributes.color;
        let changed = false;
        for (let c = 0; c < N * N; c++) {
            const k = known[c] | (this.reveal ? 1 : 0);
            if (!all && this.knownSnap[c] === k) continue;
            this.knownSnap[c] = k;
            changed = true;
            const color = k ? this.baseColors[c] : this.baseColors[c].clone().lerp(FOG, 0.8);
            col.setXYZ(c, color.r, color.g, color.b);
            const bi = this.boulderAt.get(c);
            if (bi !== undefined && !this.drops.includes(bi)) this.writeBoulder(bi, !!k);
        }
        if (changed) col.needsUpdate = true;
    }

    setReveal(on) { this.reveal = on; this.recolor(true); }
    setTool(tool) { this.tool = tool; if (tool) this.el.dataset.tool = tool; else delete this.el.dataset.tool; }

    consume(fx) {
        if (fx.type === 'slide') for (const c of fx.cells) this.addBoulder(c, true);
    }

    render(dt) {
        if (!this.mission) return;
        const { rover, world: w } = this.mission;
        const t = performance.now() / 1000;
        this.recolor();

        // Rover: glide toward its cell, face the direction of travel, tilt with the ground
        this.roverTarget.copy(this.cellPos(rover.pos, 0.36));
        const k = 1 - Math.exp(-dt * Math.max(6, this.tps * 1.6));
        const prev = this.roverMesh.position.clone();
        this.roverMesh.position.lerp(this.roverTarget, k);
        const rp = this.roverMesh.position;
        rp.y = this.heightAt(rp.x, rp.z) + 0.36;
        const move = this.roverTarget.clone().sub(prev);
        if (move.x * move.x + move.z * move.z > 1e-4) this.heading = Math.atan2(-move.z, move.x);
        const e = 0.5, n = new THREE.Vector3(
            this.heightAt(rp.x - e, rp.z) - this.heightAt(rp.x + e, rp.z), 2 * e,
            this.heightAt(rp.x, rp.z - e) - this.heightAt(rp.x, rp.z + e)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n)
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading ?? 0));
        this.roverMesh.quaternion.slerp(q, Math.min(1, dt * 8));

        if (this.follow) {
            const delta = rp.clone().sub(this.controls.target).multiplyScalar(Math.min(1, dt * 3));
            this.controls.target.add(delta);
            this.camera.position.add(delta);
        }

        // Planned route and target
        const plan = rover.plan;
        const path = plan?.path ?? [];
        const pa = this.pathLine.geometry.attributes.position;
        const pts = Math.min(path.length + 1, 600);
        pa.setXYZ(0, rp.x, rp.y - 0.1, rp.z);
        for (let i = 1; i < pts; i++) { const p = this.cellPos(path[i - 1], 0.16); pa.setXYZ(i, p.x, p.y, p.z); }
        pa.needsUpdate = true;
        this.pathLine.geometry.setDrawRange(0, rover.status === 'active' ? pts : 0);
        this.pathLine.computeLineDistances();
        const kindColor = plan?.kind === 'uplink' ? TEAL : plan?.kind === 'return' ? new THREE.Color('#f1e4d3') : OCHRE;
        this.pathLine.material.color.copy(kindColor);
        const targetCell = path.length ? path.at(-1) : -1;
        this.targetRing.visible = targetCell >= 0 && rover.status === 'active';
        if (this.targetRing.visible) {
            this.targetRing.position.copy(this.cellPos(targetCell, 0.12));
            this.targetRing.material.color.copy(kindColor);
            this.targetRing.scale.setScalar(1 + Math.sin(t * 4) * 0.08);
        }
        const sensing = w.storm[rover.pos] > 1 ? 3 : SENSOR_R;
        this.placeRing(this.sensorRing, rp.x, rp.z, sensing, 0.1);
        this.sensorRing.visible = rover.status === 'active';

        const hc = this.hoverCell ?? -1;
        this.toolRing.visible = !!this.tool && hc >= 0;
        if (this.toolRing.visible) {
            const p = this.cellPos(hc);
            this.placeRing(this.toolRing, p.x, p.z, TOOL_RADIUS[this.tool], 0.15);
        }

        // Rockslide boulders fall into place
        for (let j = this.drops.length - 1; j >= 0; j--) {
            const i = this.drops[j], b = this.boulderInfo[i];
            b.vy -= 30 * dt;
            b.y = Math.max(b.pos.y, b.y + b.vy * dt);
            this.writeBoulder(i, true);
            if (b.y === b.pos.y) this.drops.splice(j, 1);
        }

        // Samples: shown once discovered, shrink away when collected
        for (const [c, g] of this.samples) {
            const ud = g.userData, exists = w.samples.has(c);
            const seen = rover.knownSamples.has(c);
            if (!exists) {
                ud.scale = Math.max(0, ud.scale - dt * 3);
                if (ud.scale === 0) { g.visible = false; continue; }
            }
            g.visible = !exists || seen || this.reveal;
            ud.gem.material.opacity = exists && !seen ? 0.45 : 1;
            ud.beam.visible = seen && exists;
            g.scale.setScalar(ud.scale);
            ud.gem.rotation.y = t * 1.4 + ud.phase;
            ud.gem.position.y = Math.sin(t * 2 + ud.phase) * 0.06;
        }

        for (const tw of this.towers) {
            const visible = tw.t.known || this.reveal;
            tw.g.visible = tw.ring.visible = visible;
            tw.dome.visible = visible && tw.t.online;
            tw.ring.material.color.copy(tw.t.online ? TEAL : HAZARD);
            tw.ring.material.opacity = tw.t.online ? 0.9 : 0.6 + Math.sin(t * 6) * 0.3;
            tw.g.userData.light.material.emissiveIntensity = tw.t.online ? 1.5 + Math.sin(t * 3 + tw.t.id) * 1.2 : 0;
        }
        this.lander.userData.beacon.material.emissiveIntensity = 1.2 + Math.sin(t * 2.5) * 1;

        // Dust storms: swirling particle columns that drift with the wind
        const live = new Set(w.storms);
        for (const [s, pts] of this.storms) if (!live.has(s)) { this.group.remove(pts); pts.geometry.dispose(); this.storms.delete(s); }
        for (const s of w.storms) {
            let cloud = this.storms.get(s);
            if (!cloud) {
                const count = 1400, arr = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * s.r;
                    arr.set([Math.cos(a) * r, Math.random() * 3.2, Math.sin(a) * r], i * 3);
                }
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
                cloud = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#d4925c', size: 0.22, transparent: true, opacity: 0.55, depthWrite: false }));
                this.group.add(cloud);
                this.storms.set(s, cloud);
            }
            const x = s.x - HALF, z = s.y - HALF;
            cloud.position.set(x, this.heightAt(x, z) - 0.4, z);
            cloud.rotation.y += dt * 0.8;
            cloud.material.opacity = Math.min(0.55, s.ttl / 30 * 0.55);
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
