import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoverAlgorithm } from './rover.js';

// ---- Config & 3D Space Volume Dimensions ----
const COLS = 16;
const ROWS = 16;
const LAYERS = 16;
const SPACING = 3.5; // Distance between 3D grid centers
const CONFIG = { rows: ROWS, cols: COLS, layers: LAYERS, maxEnergy: 1800 };

let scene, camera, renderer, controls;
let probeMesh, mothershipMesh;
let thrusterParticles = [];
let starField, nebulaParticles = [];
let asteroidMeshes = [];
let dataMeshes = new Map();
let commMeshes = [];
let hazardMeshes = [];
let fogNodes = []; // 3D Fog of War spatial markers

let world = { map: [], terrain: [] };
let spaceProbe;
let simulationInterval;
let speedMs = 250;
let isRunning = false;

// HUD Elements
const elEnergy = document.getElementById('energy-val');
const elEnergyFill = document.getElementById('energy-fill');
const elScore = document.getElementById('score-val');
const elCargo = document.getElementById('cargo-val');
const elState = document.getElementById('state-badge');
const elDecision = document.getElementById('decision-text');
const elExplored = document.getElementById('explored-pct');
const elDist = document.getElementById('dist-val');
const elTerrain = document.getElementById('terrain-name');
const elWeather = document.getElementById('weather-alert');
const elLogs = document.getElementById('logs');
const btnStart = document.getElementById('btn-start');
const speedSlider = document.getElementById('speed-slider');
const cameraSelect = document.getElementById('camera-select');
const overlay = document.getElementById('overlay');
const btnRestart = document.getElementById('btn-restart');
const overlayTitle = document.getElementById('overlay-title');
const overlayMsg = document.getElementById('overlay-msg');

function gridToWorld(x, y, z) {
    return new THREE.Vector3(
        (x - COLS / 2) * SPACING,
        (y - ROWS / 2) * SPACING,
        (z - LAYERS / 2) * SPACING
    );
}

function initThreeJS() {
    const container = document.getElementById('canvas-container');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020208);
    // Deep space fog
    scene.fog = new THREE.FogExp2(0x020208, 0.003);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(35, 30, 45);
    
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxDistance = 250;
    controls.minDistance = 5;

    // Deep Space Lighting System
    const ambientLight = new THREE.AmbientLight(0x334466, 0.6);
    scene.add(ambientLight);

    // Primary Distant Star / Sun Light
    const sunLight = new THREE.DirectionalLight(0xfffaed, 2.5);
    sunLight.position.set(80, 100, 60);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 300;
    const d = 50;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    scene.add(sunLight);

    // Deep Space Blue Ambient Glow
    const blueSpaceLight = new THREE.PointLight(0x00F0FF, 3, 100);
    blueSpaceLight.position.set(-40, -20, -30);
    scene.add(blueSpaceLight);

    // Violet Cosmic Secondary Glow
    const violetLight = new THREE.PointLight(0x8B5CF6, 2.5, 120);
    violetLight.position.set(40, 40, -40);
    scene.add(violetLight);

    createSpaceEnvironment();

    window.addEventListener('resize', onWindowResize, false);
}

// Build 3D Deep Space Stars and Nebulae (NO GROUND)
function createSpaceEnvironment() {
    // 1. Starfield Particles
    const starCount = 3500;
    const starGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);

    const colorPalette = [
        new THREE.Color(0xffffff),
        new THREE.Color(0x7dd3fc),
        new THREE.Color(0xa5b4fc),
        new THREE.Color(0xfef08a),
        new THREE.Color(0xf472b6)
    ];

    for (let i = 0; i < starCount; i++) {
        // Distribute in a spherical galaxy shell around scene
        const u = Math.random();
        const v = Math.random();
        const theta = u * 2.0 * Math.PI;
        const phi = Math.acos(2.0 * v - 1.0);
        const r = 150 + Math.random() * 250;

        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.sin(phi) * Math.sin(theta);
        const z = r * Math.cos(phi);

        starPositions[i * 3] = x;
        starPositions[i * 3 + 1] = y;
        starPositions[i * 3 + 2] = z;

        const c = colorPalette[Math.floor(Math.random() * colorPalette.length)];
        starColors[i * 3] = c.r;
        starColors[i * 3 + 1] = c.g;
        starColors[i * 3 + 2] = c.b;
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));

    const starMat = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.85
    });

    starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // 2. Cosmic Nebula Particle Dust
    for (let k = 0; k < 5; k++) {
        const count = 400;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(count * 3);
        const center = new THREE.Vector3(
            (Math.random() - 0.5) * 120,
            (Math.random() - 0.5) * 120,
            (Math.random() - 0.5) * 120
        );

        for (let i = 0; i < count; i++) {
            pos[i * 3] = center.x + (Math.random() - 0.5) * 60;
            pos[i * 3 + 1] = center.y + (Math.random() - 0.5) * 60;
            pos[i * 3 + 2] = center.z + (Math.random() - 0.5) * 60;
        }

        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const nebColors = [0x3b82f6, 0x8b5cf6, 0xec4899, 0x06b6d4];
        const mat = new THREE.PointsMaterial({
            color: nebColors[k % nebColors.length],
            size: 8.0,
            transparent: true,
            opacity: 0.15,
            blending: THREE.AdditiveBlending
        });
        const neb = new THREE.Points(geo, mat);
        scene.add(neb);
        nebulaParticles.push(neb);
    }
}

// Generate Realistic 3D Asteroids / Space Rocks
function createAsteroidMesh(size, colorHex) {
    // Perturbed irregular dodecahedron for natural space rock shape
    const baseGeo = new THREE.DodecahedronGeometry(size, 1);
    const pos = baseGeo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        // Add rocky roughness displacement
        const noise = (Math.sin(v.x * 3) + Math.cos(v.y * 3) + Math.sin(v.z * 3)) * (size * 0.15);
        v.addScalar(noise);
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    baseGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
        color: colorHex || 0x3a3d45,
        roughness: 0.9,
        metalness: 0.2,
        flatShading: true
    });

    const mesh = new THREE.Mesh(baseGeo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Random tumble spin speed
    mesh.userData.spinSpeed = new THREE.Vector3(
        (Math.random() - 0.5) * 0.015,
        (Math.random() - 0.5) * 0.015,
        (Math.random() - 0.5) * 0.015
    );

    return mesh;
}

// Create Futuristic 3D Mothership Base Station
function createMothershipMesh() {
    const group = new THREE.Group();

    // Core Command Sphere
    const coreGeo = new THREE.SphereGeometry(2.0, 32, 32);
    const coreMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        metalness: 0.9,
        roughness: 0.2,
        emissive: 0x0284c7,
        emissiveIntensity: 0.4
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.castShadow = true;
    group.add(core);

    // Rotating Solar Array Rings
    const ringGeo = new THREE.TorusGeometry(3.5, 0.2, 16, 64);
    const ringMat = new THREE.MeshStandardMaterial({
        color: 0x00F0FF,
        emissive: 0x00F0FF,
        emissiveIntensity: 0.8,
        metalness: 0.8
    });
    const ring1 = new THREE.Mesh(ringGeo, ringMat);
    group.add(ring1);

    const ring2Geo = new THREE.TorusGeometry(4.8, 0.15, 16, 64);
    const ring2Mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.6
    });
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
    ring2.rotation.x = Math.PI / 3;
    group.add(ring2);

    // Docking Field Pulse Ring
    const dockGeo = new THREE.RingGeometry(1.2, 2.8, 32);
    const dockMat = new THREE.MeshBasicMaterial({
        color: 0x00F0FF,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.4
    });
    const dockRing = new THREE.Mesh(dockGeo, dockMat);
    dockRing.rotation.x = Math.PI / 2;
    group.add(dockRing);

    // Navigational Beacon Light
    const beaconLight = new THREE.PointLight(0x00F0FF, 3, 15);
    beaconLight.position.set(0, 3, 0);
    group.add(beaconLight);

    group.userData.ring1 = ring1;
    group.userData.ring2 = ring2;

    return group;
}

// Create 3D Spacecraft Probe
function createSpaceProbeMesh() {
    const probe = new THREE.Group();

    // Main fuselage
    const bodyGeo = new THREE.ConeGeometry(0.7, 2.2, 8);
    bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        metalness: 0.85,
        roughness: 0.15
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    probe.add(body);

    // Solar Wings
    const wingGeo = new THREE.BoxGeometry(3.2, 0.05, 0.6);
    const wingMat = new THREE.MeshStandardMaterial({
        color: 0x0284c7,
        emissive: 0x0369a1,
        emissiveIntensity: 0.6,
        metalness: 0.9
    });
    const wings = new THREE.Mesh(wingGeo, wingMat);
    wings.position.set(0, 0, -0.2);
    probe.add(wings);

    // Forward Sensor Dome
    const sensorGeo = new THREE.SphereGeometry(0.35, 16, 16);
    const sensorMat = new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0x00F0FF,
        emissiveIntensity: 0.9
    });
    const sensor = new THREE.Mesh(sensorGeo, sensorMat);
    sensor.position.set(0, 0, 1.0);
    probe.add(sensor);

    // Engine Thruster Nozzle & Glowing Exhaust
    const engineGeo = new THREE.CylinderGeometry(0.4, 0.5, 0.6, 16);
    engineGeo.rotateX(Math.PI / 2);
    const engineMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9 });
    const engine = new THREE.Mesh(engineGeo, engineMat);
    engine.position.set(0, 0, -1.2);
    probe.add(engine);

    // Thruster Flame Cone
    const flameGeo = new THREE.ConeGeometry(0.35, 1.2, 16);
    flameGeo.rotateX(-Math.PI / 2);
    const flameMat = new THREE.MeshBasicMaterial({
        color: 0x00F0FF,
        transparent: true,
        opacity: 0.85
    });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(0, 0, -1.8);
    probe.add(flame);
    probe.userData.flame = flame;

    // Probe Thruster Spotlight
    const spotlight = new THREE.SpotLight(0x00F0FF, 3, 20, Math.PI / 6, 0.5);
    spotlight.position.set(0, 0, 1);
    spotlight.target.position.set(0, 0, 10);
    probe.add(spotlight);
    probe.add(spotlight.target);

    return probe;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Generate 3D Space Volume World
function generateWorld() {
    // Clear old 3D objects
    asteroidMeshes.forEach(m => scene.remove(m));
    dataMeshes.forEach(m => scene.remove(m));
    commMeshes.forEach(m => scene.remove(m));
    hazardMeshes.forEach(m => scene.remove(m));
    fogNodes.forEach(m => scene.remove(m));
    if (probeMesh) scene.remove(probeMesh);
    if (mothershipMesh) scene.remove(mothershipMesh);

    asteroidMeshes = [];
    dataMeshes.clear();
    commMeshes = [];
    hazardMeshes = [];
    fogNodes = [];

    world.map = Array.from({ length: LAYERS }, () =>
        Array.from({ length: ROWS }, () =>
            Array(COLS).fill('.')
        )
    );
    world.terrain = Array.from({ length: LAYERS }, () =>
        Array.from({ length: ROWS }, () =>
            Array(COLS).fill(1)
        )
    );

    const startX = Math.floor(COLS / 2);
    const startY = Math.floor(ROWS / 2);
    const startZ = Math.floor(LAYERS / 2);

    // 1. Scatter 3D Space Rocks / Asteroids
    const totalVoxels = COLS * ROWS * LAYERS;
    const obstacleCount = Math.floor(totalVoxels * 0.12);

    for (let i = 0; i < obstacleCount; i++) {
        let ax, ay, az;
        do {
            ax = Math.floor(Math.random() * COLS);
            ay = Math.floor(Math.random() * ROWS);
            az = Math.floor(Math.random() * LAYERS);
        } while (
            world.map[az][ay][ax] !== '.' ||
            Math.hypot(ax - startX, ay - startY, az - startZ) < 3
        );

        world.map[az][ay][ax] = '#';

        const size = 1.0 + Math.random() * 1.8;
        const colorHex = Math.random() > 0.3 ? 0x2e3239 : (Math.random() > 0.5 ? 0x4a3b32 : 0x1f2937);
        const rock = createAsteroidMesh(size, colorHex);

        const pos = gridToWorld(ax, ay, az);
        // Add random offset for continuous floating space field aesthetic
        pos.x += (Math.random() - 0.5) * 1.2;
        pos.y += (Math.random() - 0.5) * 1.2;
        pos.z += (Math.random() - 0.5) * 1.2;
        rock.position.copy(pos);

        scene.add(rock);
        asteroidMeshes.push(rock);
    }

    // 2. Cosmic Hazard Radiation Anomaly Fields
    for (let i = 0; i < 6; i++) {
        let hx, hy, hz;
        do {
            hx = Math.floor(Math.random() * COLS);
            hy = Math.floor(Math.random() * ROWS);
            hz = Math.floor(Math.random() * LAYERS);
        } while (world.map[hz][hy][hx] !== '.' || Math.hypot(hx - startX, hy - startY, hz - startZ) < 4);

        world.terrain[hz][hy][hx] = 3; // High radiation hazard

        const hazGeo = new THREE.IcosahedronGeometry(1.2, 2);
        const hazMat = new THREE.MeshStandardMaterial({
            color: 0xef4444,
            emissive: 0xd97706,
            emissiveIntensity: 0.8,
            wireframe: true
        });
        const hazMesh = new THREE.Mesh(hazGeo, hazMat);
        hazMesh.position.copy(gridToWorld(hx, hy, hz));
        scene.add(hazMesh);
        hazardMeshes.push(hazMesh);
    }

    // 3. Mothership Base Station
    world.map[startZ][startY][startX] = 'B';
    world.terrain[startZ][startY][startX] = 1;

    mothershipMesh = createMothershipMesh();
    mothershipMesh.position.copy(gridToWorld(startX, startY, startZ));
    scene.add(mothershipMesh);

    // 4. Scatter 3D Satellite Communication Beacons
    for (let i = 0; i < 4; i++) {
        let cx, cy, cz;
        do {
            cx = Math.floor(Math.random() * COLS);
            cy = Math.floor(Math.random() * ROWS);
            cz = Math.floor(Math.random() * LAYERS);
        } while (
            world.map[cz][cy][cx] !== '.' ||
            Math.hypot(cx - startX, cy - startY, cz - startZ) < 6
        );

        world.map[cz][cy][cx] = 'C';

        const commGroup = new THREE.Group();
        const dishGeo = new THREE.SphereGeometry(0.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3);
        const dishMat = new THREE.MeshStandardMaterial({ color: 0x10B981, metalness: 0.8, side: THREE.DoubleSide });
        const dish = new THREE.Mesh(dishGeo, dishMat);
        commGroup.add(dish);

        const solarWingGeo = new THREE.BoxGeometry(2.4, 0.05, 0.5);
        const solarWingMat = new THREE.MeshStandardMaterial({ color: 0x059669, emissive: 0x10B981, emissiveIntensity: 0.5 });
        const wings = new THREE.Mesh(solarWingGeo, solarWingMat);
        commGroup.add(wings);

        const pos = gridToWorld(cx, cy, cz);
        commGroup.position.copy(pos);
        scene.add(commGroup);
        commMeshes.push(commGroup);
    }

    // 5. Scatter Floating Space Data Crystals
    const tiers = ['LOW', 'MED', 'HIGH'];
    const colors = { LOW: 0x00F0FF, MED: 0xF59E0B, HIGH: 0xEC4899 };

    for (let i = 0; i < 20; i++) {
        let dx, dy, dz;
        do {
            dx = Math.floor(Math.random() * COLS);
            dy = Math.floor(Math.random() * ROWS);
            dz = Math.floor(Math.random() * LAYERS);
        } while (
            world.map[dz][dy][dx] !== '.' ||
            Math.hypot(dx - startX, dy - startY, dz - startZ) < 4
        );

        const tier = tiers[Math.floor(Math.random() * tiers.length)];
        world.map[dz][dy][dx] = `D_${tier}`;

        let crystalGeo;
        if (tier === 'HIGH') crystalGeo = new THREE.DodecahedronGeometry(0.6);
        else if (tier === 'MED') crystalGeo = new THREE.OctahedronGeometry(0.6);
        else crystalGeo = new THREE.TetrahedronGeometry(0.6);

        const crystalMat = new THREE.MeshStandardMaterial({
            color: colors[tier],
            emissive: colors[tier],
            emissiveIntensity: 0.9,
            roughness: 0.1,
            metalness: 0.9,
            transparent: true,
            opacity: 0.95
        });

        const crystalMesh = new THREE.Mesh(crystalGeo, crystalMat);
        crystalMesh.position.copy(gridToWorld(dx, dy, dz));
        scene.add(crystalMesh);
        dataMeshes.set(`${dx},${dy},${dz}`, crystalMesh);
    }

    // 6. Create Space Probe Mesh
    probeMesh = createSpaceProbeMesh();
    probeMesh.position.copy(gridToWorld(startX, startY, startZ));
    scene.add(probeMesh);

    // Initialize 3D Space Probe Controller
    spaceProbe = new RoverAlgorithm(startX, startY, startZ, CONFIG);
    updateCamera();
}

function updateVisuals() {
    if (!spaceProbe) return;

    // 1. Move Probe smoothly in 3D
    const targetPos = gridToWorld(spaceProbe.x, spaceProbe.y, spaceProbe.z);
    
    // Smooth Lerp Position in 3D Zero-G
    const oldPos = probeMesh.position.clone();
    probeMesh.position.lerp(targetPos, 0.25);

    // Smoothly rotate probe to face 3D flight vector
    const moveVec = targetPos.clone().sub(oldPos);
    if (moveVec.lengthSq() > 0.001) {
        const lookTarget = probeMesh.position.clone().add(moveVec);
        probeMesh.lookAt(lookTarget);
    }

    // Dynamic Thruster Flame Animation
    if (probeMesh.userData.flame) {
        probeMesh.userData.flame.scale.set(
            1 + Math.sin(Date.now() * 0.02) * 0.2,
            1 + Math.cos(Date.now() * 0.03) * 0.3,
            1 + Math.sin(Date.now() * 0.02) * 0.2
        );
    }

    // 2. Animate Mothership Solar Rings
    if (mothershipMesh) {
        mothershipMesh.userData.ring1.rotation.z += 0.01;
        mothershipMesh.userData.ring2.rotation.y += 0.015;
    }

    // 3. Tumble 3D Space Rocks & Satellites
    const time = Date.now() * 0.002;

    asteroidMeshes.forEach(rock => {
        if (rock.userData.spinSpeed) {
            rock.rotation.x += rock.userData.spinSpeed.x;
            rock.rotation.y += rock.userData.spinSpeed.y;
            rock.rotation.z += rock.userData.spinSpeed.z;
        }
    });

    hazardMeshes.forEach((mesh, idx) => {
        mesh.rotation.y = time;
        mesh.rotation.z = time * 0.7;
        const scale = 1 + Math.sin(time * 3 + idx) * 0.15;
        mesh.scale.set(scale, scale, scale);
    });

    // 4. Animate floating space crystals
    dataMeshes.forEach((mesh, key) => {
        mesh.rotation.y = time * 1.5;
        mesh.rotation.x = time * 0.8;
        mesh.position.y += Math.sin(time * 3 + mesh.position.x) * 0.01;
    });

    commMeshes.forEach(mesh => {
        mesh.rotation.y = time * 0.6;
    });

    // 5. Remove collected data crystals
    const currentCell = world.map[spaceProbe.z][spaceProbe.y][spaceProbe.x];
    if (currentCell === '.') {
        const key = `${spaceProbe.x},${spaceProbe.y},${spaceProbe.z}`;
        if (dataMeshes.has(key)) {
            scene.remove(dataMeshes.get(key));
            dataMeshes.delete(key);
        }
    }

    updateCamera();
}

function updateCamera() {
    const mode = cameraSelect.value;
    const pPos = probeMesh.position;
    
    if (mode === 'orbital') {
        // Free 3D Space Orbit
        controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
    } else if (mode === 'isometric') {
        // 3D Probe Tracking View
        const offset = new THREE.Vector3(18, 18, 22);
        camera.position.lerp(pPos.clone().add(offset), 0.1);
        controls.target.lerp(pPos, 0.1);
    } else if (mode === 'rover') {
        // Probe Thruster Cockpit POV
        const offset = new THREE.Vector3(0, 1.2, -4.5);
        offset.applyQuaternion(probeMesh.quaternion);
        camera.position.lerp(pPos.clone().add(offset), 0.25);
        
        const lookTarget = pPos.clone();
        const fwd = new THREE.Vector3(0, 0, 8).applyQuaternion(probeMesh.quaternion);
        lookTarget.add(fwd);
        controls.target.lerp(lookTarget, 0.25);
    }
    controls.update();
}

function logMessage(msg, type) {
    if (!msg) return;
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="color:#64748B">[${time}]</span> ${msg}`;
    elLogs.appendChild(div);
    elLogs.scrollTop = elLogs.scrollHeight;
}

function updateHUD() {
    if (!spaceProbe) return;

    elEnergy.innerText = `${Math.round(spaceProbe.energy)} J`;
    const epct = Math.max(0, (spaceProbe.energy / spaceProbe.maxEnergy) * 100);
    elEnergyFill.style.width = `${epct}%`;
    if (epct < 20) elEnergyFill.style.background = '#EF4444';
    else if (epct < 50) elEnergyFill.style.background = '#F59E0B';
    else elEnergyFill.style.background = '#10B981';

    elScore.innerText = `${spaceProbe.getUploadedScore()} PTS`;
    elCargo.innerText = `${spaceProbe.getPayloadCount()} UNIT(S)`;
    
    elState.innerText = spaceProbe.state;
    if (spaceProbe.state === 'RETURNING') elState.style.color = '#F59E0B';
    else if (spaceProbe.state === 'EXTRACTION') elState.style.color = '#00F0FF';
    else if (spaceProbe.state === 'UPLINK_TRANSIT') elState.style.color = '#10B981';
    else elState.style.color = '#F1F5F9';
    elState.style.borderColor = elState.style.color;

    elDecision.innerText = spaceProbe.decisionReason;
    
    const expPct = ((spaceProbe.cellsExplored / spaceProbe.totalCells) * 100).toFixed(1);
    elExplored.innerText = `${expPct}%`;
    elDist.innerText = `${spaceProbe.totalDistanceTraveled * 10} km`;
    
    const h = spaceProbe.terrainBelief[spaceProbe.z][spaceProbe.y][spaceProbe.x];
    if (h === 1) { elTerrain.innerText = 'Void Space (1.0x)'; elTerrain.style.color = '#10B981'; }
    else if (h === 2) { elTerrain.innerText = 'Cosmic Dust (2.0x)'; elTerrain.style.color = '#F59E0B'; }
    else { elTerrain.innerText = 'Radiation Storm (3.0x)'; elTerrain.style.color = '#EF4444'; }
}

function tick() {
    if (!spaceProbe) return;
    const res = spaceProbe.step(world);
    updateHUD();
    
    if (res.msg) logMessage(res.msg, res.type);

    if (res.done) {
        stopSimulation();
        overlayTitle.innerText = res.success ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
        overlayTitle.style.color = res.success ? '#10B981' : '#EF4444';
        overlayMsg.innerText = res.msg + " " + res.reason;
        overlay.classList.remove('hidden');
    }
}

function animate() {
    requestAnimationFrame(animate);

    // Rotate galaxy starfield gently
    if (starField) starField.rotation.y += 0.0003;
    nebulaParticles.forEach((n, i) => {
        n.rotation.y += (i % 2 === 0 ? 0.0002 : -0.0002);
    });

    if (isRunning) {
        updateVisuals();
    } else {
        // Idle ambient rendering
        updateVisuals();
    }
    renderer.render(scene, camera);
}

function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    overlay.classList.add('hidden');
    elLogs.innerHTML = '';
    logMessage('ARES-V Zero-G Space Probe Online. Launching deep space survey.', 'info');
    
    const runLoop = () => {
        if (!isRunning) return;
        tick();
        setTimeout(runLoop, speedMs);
    };
    runLoop();
    btnStart.innerText = 'PAUSE SIMULATION';
}

function stopSimulation() {
    isRunning = false;
    btnStart.innerText = 'RESUME SIMULATION';
}

// Event Listeners
btnStart.addEventListener('click', () => {
    if (isRunning) stopSimulation();
    else startSimulation();
});

btnRestart.addEventListener('click', () => {
    generateWorld();
    updateHUD();
    startSimulation();
});

speedSlider.addEventListener('input', (e) => {
    speedMs = Math.max(16, 1000 - (e.target.value * 16));
});

initThreeJS();
generateWorld();
updateHUD();
animate();
