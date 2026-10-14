import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { TrailPass } from './trail.js';
import { createDetector, BodyTracker } from './pose.js';
import { BodyUniforms, MAXB } from './body.js';
import { ParticleField, MODES } from './particles.js';
import { MovementSignal, broadcastSignal } from './signal.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('qa') });
renderer.setClearColor(0x000000, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const field = new ParticleField(renderer, Number(params.get('n')) || 512);
scene.add(field.shedLayer);
// The body is drawn after the trail pass so it stays crisp.
const bodyScene = new THREE.Scene();
bodyScene.add(field.bodyLayer);
const baseGain = num('gain', 0.3);

// Optional faint video behind the light (B). Off by default.
const video = document.createElement('video');
video.playsInline = true;
video.crossOrigin = 'anonymous';
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { tVideo: { value: videoTex }, uRect: { value: new THREE.Vector3(2, 2, 1) }, uAspect: field.uniforms.uAspect, uOpacity: { value: 0.22 } },
  vertexShader: `uniform vec3 uRect; uniform float uAspect; varying vec2 vUv;
    void main(){ vUv = vec2(uRect.z < 0.0 ? 1.0 - uv.x : uv.x, uv.y); gl_Position = vec4(position.x * uRect.x * 0.5 / uAspect, position.y * uRect.y * 0.5, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D tVideo; uniform float uOpacity; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tVideo, vUv).rgb; float l = dot(c, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(vec3(l) * uOpacity, 1.0); }`,
  depthTest: false, depthWrite: false,
}));
backdrop.frustumCulled = false;
backdrop.renderOrder = -1;
backdrop.visible = params.get('backdrop') === '1';
scene.add(backdrop);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const trail = new TrailPass(num('trail', 0.8));
composer.addPass(trail);
const cutScene = new THREE.Scene();
cutScene.add(field.cutLayer);
const cutPass = new RenderPass(cutScene, camera);
cutPass.clear = false;
composer.addPass(cutPass);
field.drawUniforms.uCut.value = num('cut', 0.03);
const bodyPass = new RenderPass(bodyScene, camera);
bodyPass.clear = false;
composer.addPass(bodyPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), num('bloom', 0.45), num('radius', 0.35), num('thresh', 0.55));
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  // Cap the internal height at 1440 px: a 4K TV upscales glow without losing anything.
  const pr = Math.min(devicePixelRatio || 1, 1440 / h);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  bloom.resolution.set(w * pr * 0.5, h * pr * 0.5);
  field.resize(w * pr, h * pr, w / h);
  if (source) bodyU.setView(source.w, source.h, w / h, source.mirror);
  updateBackdropRect();
}
addEventListener('resize', resize);

// ---------- tracking ----------
const tracker = new BodyTracker(MAXB);
const bodyU = new BodyUniforms();
const signals = Array.from({ length: MAXB }, () => new MovementSignal());
// The exported signal follows whichever body was seen most recently.
const signal = new MovementSignal();
broadcastSignal(signal);
const pendingHits = [];
let lastBodyAt = performance.now();
let detector = null;
const loadDetector = () => {
  if (detector) return detector.ready;
  detector = createDetector({
    model: params.get('model') || 'full',
    maxBodies: Number(params.get('bodies')) || MAXB,
    useWorker: params.get('worker') !== '0',
    onResult: onPoses,
  });
  return detector.ready;
};

function toWorld(x, y) {
  const { w, h, mirror } = bodyU.view;
  return [(x - 0.5) * (mirror ? -w : w), (0.5 - y) * h];
}

function onPoses(landmarks, t) {
  stats.detections++;
  tracker.update(landmarks, t);
  const now = t * 1000;
  tracker.slots.forEach((s, i) => {
    const f = signals[i].update(s.active ? s.lm : null, now);
    if (s.alpha < 0.3) return;
    for (const h of f.hits) {
      const [x, y] = toWorld(h.x, h.y);
      const scale = bodyU.scale[i] || 0.4;
      pendingHits.push({ x, y, dx: h.dx * (bodyU.view.mirror ? -1 : 1), dy: -h.dy, strength: h.strength, radius: scale * 0.55 });
    }
  });
  signal.update(tracker.primary()?.lm || null, now);
}

let source = null; // { kind, w, h, mirror }
let newFrame = false;
let stream = null;

function watchFrames() {
  if ('requestVideoFrameCallback' in video) {
    const cb = () => { newFrame = true; video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  }
}
watchFrames();

function updateBackdropRect() {
  const u = backdrop.material.uniforms.uRect.value;
  u.set(bodyU.view.w, bodyU.view.h, bodyU.view.mirror ? -1 : 1);
}

async function useVideo(src, kind, mirror) {
  flash(kind === 'camera' ? 'Starting camera' : 'Loading video');
  const detectorReady = loadDetector();
  if (stream && kind !== 'camera') { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.pause();
  if (kind === 'camera') { video.srcObject = src; video.removeAttribute('src'); } else { video.srcObject = null; video.src = src; }
  video.loop = kind !== 'camera';
  video.muted = kind === 'camera' || params.get('mute') === '1';
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Could not load that video')); });
  await video.play().catch(() => { video.muted = true; return video.play(); });
  source = { kind, w: video.videoWidth, h: video.videoHeight, mirror };
  resize();
  await detectorReady;
  $('start').classList.add('gone');
  document.body.classList.remove('waiting');
  flash('');
}

async function startCamera() {
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
    await useVideo(stream, 'camera', true);
  } catch (e) {
    flash(e.name === 'NotAllowedError' ? 'Camera blocked. Allow it in the address bar.' : `Camera failed: ${e.message}`, 6000);
  }
}
function openFile(file) {
  if (!file || !file.type.startsWith('video')) return flash('That is not a video file', 3000);
  useVideo(URL.createObjectURL(file), 'file', false).catch((e) => flash(e.message, 5000));
}

// ---------- UI ----------
let msgTimer = 0;
function flash(text, ms = 0) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('on', !!text);
  clearTimeout(msgTimer);
  if (text && ms) msgTimer = setTimeout(() => el.classList.remove('on'), ms);
}
$('btn-cam').onclick = startCamera;
$('btn-file').onclick = () => $('file').click();
$('file').onchange = (e) => openFile(e.target.files[0]);
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging'); openFile(e.dataTransfer.files[0]); });

let idleTimer = 0;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (source) document.body.classList.add('idle'); }, 3500);
}
addEventListener('pointermove', wake);

function setMode(i) {
  field.setMode(i);
  $('mode-name').textContent = MODES[i].name;
  wake();
}

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= String(MODES.length)) setMode(Number(k) - 1);
  else if (k === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
  else if (k === 'h') document.body.classList.toggle('hidden');
  else if (k === 'c') startCamera();
  else if (k === 'v') $('file').click();
  else if (k === 'b') backdrop.visible = !backdrop.visible;
  else if (k === 'm') video.muted = !video.muted;
  else if (k === 'd') document.body.classList.toggle('debug');
  else if (k === ' ' && source?.kind !== 'camera') { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
  else return;
  if (k !== 'h') wake();
});
if (params.get('ui') === '0') document.body.classList.add('hidden');
if (params.has('debug')) document.body.classList.add('debug');

// ---------- loop ----------
const stats = { fps: 60, frameMs: 16.7, worstMs: 0, detectMs: 0, detections: 0, frames: 0 };
let last = performance.now();
let worstWindow = 0, worstAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = Math.min(Math.max(rawDt, 1 / 240), 1 / 20);
  const t = now / 1000;

  stats.frames++;
  stats.frameMs += (rawDt * 1000 - stats.frameMs) * 0.05;
  stats.fps = 1000 / stats.frameMs;
  worstWindow = Math.max(worstWindow, rawDt * 1000);
  if (now - worstAt > 2000) { stats.worstMs = worstWindow; worstWindow = 0; worstAt = now; }

  if (detector && source && video.readyState >= 2 && !detector.busy && (newFrame || !('requestVideoFrameCallback' in video))) {
    newFrame = false;
    detector.submit(video, now);
  }
  stats.detectMs = detector?.stats.ms || 0;

  tracker.tick(dt);
  // Nobody in frame for a few seconds: a quiet nudge (camera only).
  if (tracker.primary()) lastBodyAt = now;
  document.body.classList.toggle('nobody', source?.kind === 'camera' && now - lastBodyAt > 4000);
  bodyU.update(tracker.slots, t, dt);
  field.setBodies(bodyU);
  pendingHits.sort((a, b) => b.strength - a.strength);
  field.setHits(pendingHits.splice(0, 4));
  pendingHits.length = 0;
  field.step(dt, t);
  field.drawUniforms.uGain.value += (baseGain * field.modeGain - field.drawUniforms.uGain.value) * (1 - Math.exp(-dt / 0.5));
  trail.dt = dt;
  composer.render(dt);

  if (document.body.classList.contains('debug') && stats.frames % 6 === 0) {
    const s = signal.last;
    const L = s.limbs;
    $('debug').textContent =
      `${stats.fps.toFixed(0)} fps  worst ${stats.worstMs.toFixed(1)} ms  detect ${stats.detectMs.toFixed(1)} ms  ${field.count.toLocaleString()} particles\n` +
      `energy ${s.energy.toFixed(2)}  expansion ${s.expansion.toFixed(2)}  stillness ${s.stillness.toFixed(2)}  level ${s.level.toFixed(2)}\n` +
      `hands ${L.leftHand.speed.toFixed(1)} ${L.rightHand.speed.toFixed(1)}  feet ${L.leftFoot.speed.toFixed(1)} ${L.rightFoot.speed.toFixed(1)}  head ${L.head.speed.toFixed(1)}`;
  }
}

resize();
requestAnimationFrame(frame);

// Handle for QA and for anything else on the page that wants the signal.
window.bodyLight = { stats, signal, field, setMode, tracker, bodyU, startCamera, video, useVideo };

// ?video=url autoloads a clip (QA, or a saved link for a performance file).
if (params.get('video')) useVideo(params.get('video'), 'file', false).catch((e) => flash(e.message, 5000));
if (params.get('mode')) setMode(Math.min(MODES.length - 1, Math.max(0, Number(params.get('mode')) - 1)));
