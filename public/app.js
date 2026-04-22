// Jewellery try-on — WebAR prototype
// -----------------------------------
// Two modes driven by `?mode=` URL param:
//   mode=ring     (default) — places a ring around the ring-finger segment (MCP→PIP)
//   mode=bracelet           — places a bracelet around the wrist, axis along the forearm
//
// Pipeline is identical for both:
//   1. getUserMedia -> rear camera into <video>
//   2. MediaPipe HandLandmarker -> 21 landmarks per frame
//   3. Estimate hand distance from MCP-row pixel span (palm width prior)
//   4. Project relevant landmarks into a Three.js scene overlaid on the video
//   5. Depth-only occluder hides the back half of the jewellery behind the
//      (invisible) finger/wrist proxy
//
// URL params:
//   ?mode=ring|bracelet       default ring
//   ?jewel=<path-or-URL>.glb  optional GLB to load (replaces placeholder)
//   ?palm=<cm>                hand-size calibration (default 8.5 cm)
//   ?debug=1                  render 21 hand landmarks as green dots
//
// No build step. Static files only. Needs HTTPS for camera access.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// --- DOM ---
const video        = document.getElementById('video');
const canvas       = document.getElementById('three-canvas');
const statusEl     = document.getElementById('status');
const startOverlay = document.getElementById('start');
const startBtn     = document.getElementById('startBtn');
const errorEl      = document.getElementById('error');
const titleEl      = document.getElementById('startTitle');

// --- MediaPipe landmark indices ---
const WRIST      = 0;
const INDEX_MCP  = 5;
const MIDDLE_MCP = 9;
const RING_MCP   = 13;
const RING_PIP   = 14;
const PINKY_MCP  = 17;

// --- URL params ---
const params  = new URLSearchParams(location.search);
const mode    = params.get('mode') === 'bracelet' ? 'bracelet' : 'ring';
// backward compat: ?ring=... still works
const glbURL  = params.get('jewel') || params.get('ring');
const debug   = params.get('debug') === '1';
const palmCm  = parseFloat(params.get('palm')) || 8.5;

if (titleEl) titleEl.textContent = mode === 'bracelet' ? 'Bracelet try-on' : 'Ring try-on';

// --- Three.js scene ---
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(0.5, 1.0, 0.8);
scene.add(keyLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.3));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Jewellery group + per-mode presets (all metres) ---
const PRESETS = {
  ring: {
    placeholderOuter: 0.011,   // 22 mm OD
    placeholderTube:  0.0018,
    occluderRadius:   0.008,
    occluderLength:   0.040,
    targetDiameter:   0.020,
    placementLerp:    0.45,    // ~45% from MCP toward PIP — sits on proximal phalanx, not knuckle
  },
  bracelet: {
    placeholderOuter: 0.038,   // 76 mm OD — fits an average wrist without passing through
    placeholderTube:  0.004,
    occluderRadius:   0.032,   // wrist half-width ≈ 32 mm
    occluderLength:   0.100,
    targetDiameter:   0.065,
    placementOffset:  0.015,   // shift from wrist into the forearm
  },
};
const preset = PRESETS[mode];

const jewelGroup = new THREE.Group();
jewelGroup.visible = false;
scene.add(jewelGroup);

function buildPlaceholder() {
  const geo = new THREE.TorusGeometry(preset.placeholderOuter, preset.placeholderTube, 20, 96);
  geo.rotateX(Math.PI / 2);   // axis -> +Y
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd27a, metalness: 1.0, roughness: 0.22
  });
  return new THREE.Mesh(geo, mat);
}

async function loadGLB(url) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  root.position.sub(center);

  // Heuristic: longest axis is the jewellery's ring axis -> rotate to +Y.
  const axes = ['x', 'y', 'z'].sort((a, b) => size[a] - size[b]);
  const longest = axes[2];
  if (longest === 'x') root.rotation.z = Math.PI / 2;
  else if (longest === 'z') root.rotation.x = Math.PI / 2;

  const maxDim = Math.max(size.x, size.y, size.z);
  root.scale.setScalar(preset.targetDiameter / maxDim);
  return root;
}

function buildOccluder() {
  const geo = new THREE.CylinderGeometry(
    preset.occluderRadius, preset.occluderRadius, preset.occluderLength, 32
  );
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}
jewelGroup.add(buildOccluder());

// --- Debug dots ---
let debugDots = null;
if (debug) {
  debugDots = [];
  for (let i = 0; i < 21; i++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.003, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, depthTest: false })
    );
    m.renderOrder = 999;
    scene.add(m);
    debugDots.push(m);
  }
}

// --- One-Euro filter ---
class OneEuroVec3 {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.xPrev = null; this.dxPrev = new THREE.Vector3(); this.tPrev = null;
  }
  reset() { this.xPrev = null; this.dxPrev.set(0, 0, 0); this.tPrev = null; }
  #alpha(cutoff, dt) { return 1 / (1 + (1 / (2 * Math.PI * cutoff)) / dt); }
  filter(x, tMs) {
    if (!this.xPrev) { this.xPrev = x.clone(); this.tPrev = tMs; return x.clone(); }
    const dt = Math.max((tMs - this.tPrev) / 1000, 0.001);
    const dx = x.clone().sub(this.xPrev).divideScalar(dt);
    this.dxPrev.lerp(dx, this.#alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * this.dxPrev.length();
    const xHat = this.xPrev.clone().lerp(x, this.#alpha(cutoff, dt));
    this.xPrev = xHat; this.tPrev = tMs;
    return xHat;
  }
}
const posFilter  = new OneEuroVec3();
const axisFilter = new OneEuroVec3();

// --- Projection + depth estimate ---
function projectToWorld(nx, ny, depth) {
  const vfov = (camera.fov * Math.PI) / 180;
  const halfH = depth * Math.tan(vfov / 2);
  const halfW = halfH * camera.aspect;
  return new THREE.Vector3((nx * 2 - 1) * halfW, -(ny * 2 - 1) * halfH, -depth);
}

const PALM_WIDTH_METERS = palmCm / 100;
function estimateHandDepth(landmarks) {
  const a = landmarks[INDEX_MCP];
  const b = landmarks[PINKY_MCP];
  const videoAspect = video.videoWidth / video.videoHeight;
  const spanNorm = Math.hypot(a.x - b.x, (a.y - b.y) / videoAspect);
  const vfov = (camera.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  return PALM_WIDTH_METERS / (2 * Math.tan(hfov / 2) * Math.max(spanNorm, 1e-3));
}

// --- MediaPipe ---
let handLandmarker = null;
async function initHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    numHands: 1,
    runningMode: 'VIDEO',
  });
}

// --- Camera ---
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => { video.onloadedmetadata = res; });
  await video.play();
}

// --- Main loop ---
let lastVideoTime = -1;
function tick() {
  if (handLandmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const tMs = performance.now();
    const result = handLandmarker.detectForVideo(video, tMs);
    updateJewel(result, tMs);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// --- Per-mode placement ---
// Each returns { anchor, axis }:
//   anchor — centre of the jewellery in world space
//   axis   — direction the ring/bracelet's axis should point
function computeRingTransform(lm, depth) {
  const mcpW = projectToWorld(lm[RING_MCP].x, lm[RING_MCP].y, depth);
  const pipW = projectToWorld(lm[RING_PIP].x, lm[RING_PIP].y, depth);
  const anchor = mcpW.clone().lerp(pipW, preset.placementLerp);
  const axis = pipW.clone().sub(mcpW).normalize();
  return { anchor, axis };
}

function computeBraceletTransform(lm, depth) {
  const wristW  = projectToWorld(lm[WRIST].x,      lm[WRIST].y,      depth);
  const middleW = projectToWorld(lm[MIDDLE_MCP].x, lm[MIDDLE_MCP].y, depth);
  // Forearm direction ≈ opposite of wrist→middle-knuckle (fingers point forward;
  // the arm extends the other way). Good enough when the hand is reasonably
  // aligned with the forearm — which is the case for a try-on pose.
  const forearmDir = wristW.clone().sub(middleW).normalize();
  const anchor = wristW.clone().add(forearmDir.clone().multiplyScalar(preset.placementOffset));
  return { anchor, axis: forearmDir };
}

function updateJewel(result, tMs) {
  const hands = result?.landmarks;
  if (!hands || hands.length === 0) {
    jewelGroup.visible = false;
    if (debugDots) debugDots.forEach(d => d.visible = false);
    posFilter.reset(); axisFilter.reset();
    statusEl.textContent = mode === 'bracelet' ? 'No hand/wrist detected' : 'No hand detected';
    return;
  }

  const lm = hands[0];
  const depth = estimateHandDepth(lm);

  if (debugDots) {
    lm.forEach((p, i) => {
      debugDots[i].position.copy(projectToWorld(p.x, p.y, depth));
      debugDots[i].visible = true;
    });
  }

  const { anchor, axis } = mode === 'bracelet'
    ? computeBraceletTransform(lm, depth)
    : computeRingTransform(lm, depth);

  const smoothPos  = posFilter.filter(anchor, tMs);
  const smoothAxis = axisFilter.filter(axis, tMs).normalize();

  jewelGroup.position.copy(smoothPos);
  jewelGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), smoothAxis);
  jewelGroup.visible = true;
  statusEl.textContent = `${mode} · ≈ ${depth.toFixed(2)} m`;
}

// --- Boot ---
async function loadJewelModel() {
  if (glbURL) {
    try {
      jewelGroup.add(await loadGLB(glbURL));
      return `Loaded: ${glbURL}`;
    } catch (e) {
      console.warn('GLB load failed, using placeholder:', e);
      jewelGroup.add(buildPlaceholder());
      return `Couldn't load ${glbURL} — using placeholder`;
    }
  } else {
    jewelGroup.add(buildPlaceholder());
    return null;
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  errorEl.textContent = '';
  statusEl.textContent = 'Starting camera…';
  try {
    await startCamera();
    statusEl.textContent = 'Loading hand model…';
    await initHandLandmarker();
    statusEl.textContent = 'Loading jewellery…';
    const note = await loadJewelModel();
    startOverlay.style.display = 'none';
    statusEl.textContent = note || (mode === 'bracelet' ? 'Show your wrist' : 'Show your hand');
    tick();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    errorEl.textContent = err.message || String(err);
    statusEl.textContent = 'Tap Start to try again';
  }
});
