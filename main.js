import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoverAlgorithm } from './rover.js';

// ---- Config & State ----
const MAP_COLS = 30;
const MAP_ROWS = 30;
const TILE_SIZE = 1;
const CONFIG = { rows: MAP_ROWS, cols: MAP_COLS, maxEnergy: 1800 };

let scene, camera, renderer, controls;
let roverMesh, baseMesh;
let terrainMeshes = []; // 2D array of meshes
let dataMeshes = new Map();
let commMeshes = [];

let world = { map: [], terrain: [] };
let roverAlgo;
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

function initThreeJS() {
    const container = document.getElementById('canvas-container');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);
    scene.fog = new THREE.FogExp2(0x0a0a14, 0.02);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(20, 50, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);
    
    const pointLight = new THREE.PointLight(0x00F0FF, 2, 20);
    pointLight.position.set(0, 5, 0);
    scene.add(pointLight);

    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function generateWorld() {
    // Clear old objects
    terrainMeshes.forEach(row => row.forEach(m => scene.remove(m)));
    dataMeshes.forEach(m => scene.remove(m));
    commMeshes.forEach(m => scene.remove(m));
    if (roverMesh) scene.remove(roverMesh);
    if (baseMesh) scene.remove(baseMesh);
    
    terrainMeshes = [];
    dataMeshes.clear();
    commMeshes = [];
    world.map = [];
    world.terrain = [];

    const startX = Math.floor(MAP_COLS / 2);
    const startY = Math.floor(MAP_ROWS / 2);

    // Basic map generation
    for (let y = 0; y < MAP_ROWS; y++) {
        let rowMap = [];
        let rowTerrain = [];
        let rowMeshes = [];
        for (let x = 0; x < MAP_COLS; x++) {
            let type = '.';
            let friction = 1;
            let height = 0;
            let color = 0x222233; // base dark gray

            // Distance from center
            const d = Math.hypot(x - startX, y - startY);
            
            // Random obstacles
            if (Math.random() < 0.15 && d > 2) {
                type = '#';
                height = 1.5 + Math.random() * 2;
                color = 0x111115;
            } else if (Math.random() < 0.2) {
                friction = 2; // Rough
                height = 0.5 + Math.random();
                color = 0x333344;
            } else if (Math.random() < 0.1) {
                friction = 3; // Steep
                height = 1.0 + Math.random();
                color = 0x444455;
            } else {
                height = Math.random() * 0.2;
            }

            rowMap.push(type);
            rowTerrain.push(friction);

            // Create Terrain Mesh
            const geo = new THREE.BoxGeometry(TILE_SIZE, height || 0.1, TILE_SIZE);
            geo.translate(0, (height || 0.1)/2, 0); // anchor to bottom
            const mat = new THREE.MeshStandardMaterial({ 
                color: color, 
                roughness: 0.8, 
                metalness: 0.1 
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x - MAP_COLS/2, 0, y - MAP_ROWS/2);
            mesh.receiveShadow = true;
            mesh.castShadow = true;
            
            // Fog of war effect (darken initially)
            mesh.material.emissive = new THREE.Color(0x000000);
            mesh.material.color.multiplyScalar(0.1);

            scene.add(mesh);
            rowMeshes.push(mesh);
        }
        world.map.push(rowMap);
        world.terrain.push(rowTerrain);
        terrainMeshes.push(rowMeshes);
    }

    world.map[startY][startX] = 'B';
    world.terrain[startY][startX] = 1;

    // Base Station
    const baseGeo = new THREE.CylinderGeometry(1.5, 2, 2, 6);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x4444ff, emissive: 0x1111aa });
    baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(startX - MAP_COLS/2, 1, startY - MAP_ROWS/2);
    baseMesh.castShadow = true;
    scene.add(baseMesh);

    // Scatter Comm Relays
    for (let i = 0; i < 3; i++) {
        let cx, cy;
        do {
            cx = Math.floor(Math.random() * MAP_COLS);
            cy = Math.floor(Math.random() * MAP_ROWS);
        } while (world.map[cy][cx] !== '.' || Math.hypot(cx - startX, cy - startY) < 8);
        world.map[cy][cx] = 'C';
        
        const commGeo = new THREE.SphereGeometry(0.8, 16, 16);
        const commMat = new THREE.MeshStandardMaterial({ color: 0x10B981, emissive: 0x0a5c40, wireframe: true });
        const commMesh = new THREE.Mesh(commGeo, commMat);
        commMesh.position.set(cx - MAP_COLS/2, 1, cy - MAP_ROWS/2);
        commMesh.castShadow = true;
        scene.add(commMesh);
        commMeshes.push(commMesh);
    }

    // Scatter Data Crystals
    const tiers = ['LOW', 'MED', 'HIGH'];
    const colors = { 'LOW': 0x00ffcc, 'MED': 0xffaa00, 'HIGH': 0xff00ff };
    
    for (let i = 0; i < 15; i++) {
        let dx, dy;
        do {
            dx = Math.floor(Math.random() * MAP_COLS);
            dy = Math.floor(Math.random() * MAP_ROWS);
        } while (world.map[dy][dx] !== '.' || Math.hypot(dx - startX, dy - startY) < 5);
        
        const tier = tiers[Math.floor(Math.random() * tiers.length)];
        world.map[dy][dx] = `D_${tier}`;
        
        const dataGeo = new THREE.OctahedronGeometry(0.4);
        const dataMat = new THREE.MeshStandardMaterial({ 
            color: colors[tier], 
            emissive: colors[tier], 
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.9
        });
        const dataMesh = new THREE.Mesh(dataGeo, dataMat);
        dataMesh.position.set(dx - MAP_COLS/2, 0.8, dy - MAP_ROWS/2);
        dataMesh.castShadow = true;
        scene.add(dataMesh);
        dataMeshes.set(`${dx},${dy}`, dataMesh);
    }

    // Rover Mesh
    const roverGeo = new THREE.BoxGeometry(0.8, 0.6, 1.2);
    const roverMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.8, roughness: 0.2 });
    roverMesh = new THREE.Mesh(roverGeo, roverMat);
    // Head/sensor
    const headGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00f0ff, emissiveIntensity: 0.5 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(0, 0.5, 0.2);
    roverMesh.add(head);
    
    roverMesh.position.set(startX - MAP_COLS/2, 0.6, startY - MAP_ROWS/2);
    roverMesh.castShadow = true;
    scene.add(roverMesh);

    roverAlgo = new RoverAlgorithm(startX, startY, CONFIG);
    updateCamera();
}

function getGridPos(x, y) {
    return new THREE.Vector3(x - MAP_COLS/2, 0, y - MAP_ROWS/2);
}

function updateVisuals() {
    // 1. Move Rover smoothly
    const targetPos = getGridPos(roverAlgo.x, roverAlgo.y);
    targetPos.y = 0.6 + (terrainMeshes[roverAlgo.y][roverAlgo.x].geometry.parameters.height || 0);
    
    // Simple interpolation for smooth movement
    roverMesh.position.lerp(targetPos, 0.2);
    
    // Look in direction of movement
    if (roverAlgo.currentPath.length > 0) {
        const next = roverAlgo.currentPath[0];
        const nextPos = getGridPos(next[0], next[1]);
        roverMesh.lookAt(nextPos.x, roverMesh.position.y, nextPos.z);
    }

    // 2. Update Fog of War
    const r = 3;
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const ny = roverAlgo.y + dy;
            const nx = roverAlgo.x + dx;
            if (ny >= 0 && ny < MAP_ROWS && nx >= 0 && nx < MAP_COLS) {
                if (roverAlgo.beliefMap[ny][nx] !== null) {
                    // Reveal
                    const mesh = terrainMeshes[ny][nx];
                    mesh.material.color.setHex(mesh.userData.origColor || 0x222233);
                    if (!mesh.userData.revealed) {
                        mesh.userData.revealed = true;
                        // Restore original color
                        if (roverAlgo.terrainBelief[ny][nx] === 2) mesh.material.color.setHex(0x333344);
                        if (roverAlgo.terrainBelief[ny][nx] === 3) mesh.material.color.setHex(0x444455);
                        if (world.map[ny][nx] === '#') mesh.material.color.setHex(0x111115);
                    }
                }
            }
        }
    }

    // 3. Remove collected data crystals
    const currentCell = world.map[roverAlgo.y][roverAlgo.x];
    if (currentCell === '.') {
        const key = `${roverAlgo.x},${roverAlgo.y}`;
        if (dataMeshes.has(key)) {
            scene.remove(dataMeshes.get(key));
            dataMeshes.delete(key);
        }
    }

    // 4. Animate remaining crystals
    const time = Date.now() * 0.003;
    dataMeshes.forEach(mesh => {
        mesh.rotation.y = time;
        mesh.position.y = 0.8 + Math.sin(time * 2 + mesh.position.x) * 0.2;
    });
    
    commMeshes.forEach(mesh => {
        mesh.rotation.y = time * 0.5;
    });

    updateCamera();
}

function updateCamera() {
    const mode = cameraSelect.value;
    const rPos = roverMesh.position;
    
    if (mode === 'orbital') {
        camera.position.lerp(new THREE.Vector3(0, 35, 0), 0.05);
        controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
    } else if (mode === 'isometric') {
        camera.position.lerp(new THREE.Vector3(rPos.x + 10, rPos.y + 15, rPos.z + 10), 0.1);
        controls.target.lerp(rPos, 0.1);
    } else if (mode === 'rover') {
        // Over shoulder
        const offset = new THREE.Vector3(0, 2, -4);
        offset.applyQuaternion(roverMesh.quaternion);
        camera.position.lerp(rPos.clone().add(offset), 0.2);
        
        const lookTarget = rPos.clone();
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(roverMesh.quaternion);
        lookTarget.add(fwd.multiplyScalar(5));
        controls.target.lerp(lookTarget, 0.2);
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
    elEnergy.innerText = `${Math.round(roverAlgo.energy)} J`;
    const epct = Math.max(0, (roverAlgo.energy / roverAlgo.maxEnergy) * 100);
    elEnergyFill.style.width = `${epct}%`;
    if (epct < 20) elEnergyFill.style.background = '#EF4444';
    else if (epct < 50) elEnergyFill.style.background = '#F59E0B';
    else elEnergyFill.style.background = '#10B981';

    elScore.innerText = `${roverAlgo.getUploadedScore()} PTS`;
    elCargo.innerText = `${roverAlgo.getPayloadCount()} UNIT(S)`;
    
    elState.innerText = roverAlgo.state;
    if (roverAlgo.state === 'RETURNING') elState.style.color = '#F59E0B';
    else if (roverAlgo.state === 'EXTRACTION') elState.style.color = '#00F0FF';
    else if (roverAlgo.state === 'UPLINK_TRANSIT') elState.style.color = '#10B981';
    else elState.style.color = '#F1F5F9';
    elState.style.borderColor = elState.style.color;

    elDecision.innerText = roverAlgo.decisionReason;
    
    const expPct = ((roverAlgo.cellsExplored / roverAlgo.totalCells) * 100).toFixed(1);
    elExplored.innerText = `${expPct}%`;
    elDist.innerText = `${roverAlgo.totalDistanceTraveled * 10} m`;
    
    const f = roverAlgo.terrainBelief[roverAlgo.y][roverAlgo.x];
    if (f === 1) { elTerrain.innerText = 'Nominal (1.0x)'; elTerrain.style.color = '#10B981'; }
    else if (f === 2) { elTerrain.innerText = 'Rough (2.0x)'; elTerrain.style.color = '#F59E0B'; }
    else { elTerrain.innerText = 'Steep (3.0x)'; elTerrain.style.color = '#EF4444'; }
}

function tick() {
    const res = roverAlgo.step(world);
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
    if (isRunning) {
        updateVisuals();
    }
    renderer.render(scene, camera);
}

function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    overlay.classList.add('hidden');
    elLogs.innerHTML = '';
    logMessage('ARES-V System Online. Initiating surface drop.', 'info');
    
    // Dynamic interval based on speed slider
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
    // slider 1 to 60 -> inverse for interval ms (1000ms to 16ms)
    speedMs = Math.max(16, 1000 - (e.target.value * 16));
});

initThreeJS();
generateWorld();
updateHUD();
animate();
