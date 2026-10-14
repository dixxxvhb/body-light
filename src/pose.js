// Pose tracking: MediaPipe tasks-vision PoseLandmarker (the tasks API; the
// legacy Pose solution is dead) plus per-body smoothing and stable slots so a
// second dancer walking in does not steal the first one's light.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;

export async function createLandmarker({ model = 'full', maxBodies = 3 } = {}) {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`);
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate },
    runningMode: 'VIDEO',
    numPoses: maxBodies,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await make('GPU');
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    return make('CPU');
  }
}

// Detector: runs the landmarker in a worker (default) or on the main thread.
// submit() is ignored while a frame is in flight, so detection never queues up.
export function createDetector({ model = 'full', maxBodies = 3, useWorker = true, onResult }) {
  const abs = (p) => new URL(`${BASE}${p}`, location.href).href;
  const stats = { ms: 0, delegate: '', mode: useWorker ? 'worker' : 'main' };
  let busy = false;
  let isReady = false;
  let lastTs = 0;
  const nextTs = (now) => (lastTs = Math.max(lastTs + 1, Math.round(now)));

  if (useWorker && typeof OffscreenCanvas !== 'undefined') {
    const worker = new Worker(new URL('./pose-worker.js', import.meta.url), { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { stats.delegate = m.delegate; isReady = true; resolve(); }
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'warn') console.warn(m.message);
        else if (m.type === 'result') {
          busy = false;
          stats.ms += (m.ms - stats.ms) * 0.1;
          onResult(m.landmarks, m.t);
        }
      };
    });
    worker.postMessage({ type: 'init', wasm: abs('wasm'), model: abs(`models/pose_landmarker_${model}.task`), maxBodies });
    return {
      stats, ready,
      get busy() { return busy; },
      submit(video, now) {
        if (busy || !isReady) return;
        busy = true;
        createImageBitmap(video).then(
          (bitmap) => worker.postMessage({ type: 'frame', bitmap, ts: nextTs(now), t: now / 1000 }, [bitmap]),
          () => { busy = false; },
        );
      },
    };
  }

  let lm = null;
  const ready = createLandmarker({ model, maxBodies }).then((l) => { lm = l; stats.delegate = 'main'; });
  return {
    stats, ready,
    get busy() { return busy; },
    submit(video, now) {
      if (!lm) return;
      const t0 = performance.now();
      const res = lm.detectForVideo(video, nextTs(now));
      stats.ms += (performance.now() - t0 - stats.ms) * 0.1;
      onResult(res.landmarks, now / 1000);
    },
  };
}

// One Euro filter: smooth when slow, responsive when fast. Tuned for 30 fps
// landmark input in normalized image coords.
class OneEuro {
  constructor(minCutoff = 2.6, beta = 20, dCutoff = 1.2) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0;
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, dt) {
    if (this.x == null) { this.x = x; return x; }
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

const N = 33;

class BodySlot {
  constructor() {
    this.fx = Array.from({ length: N }, () => new OneEuro());
    this.fy = Array.from({ length: N }, () => new OneEuro());
    this.lm = Array.from({ length: N }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    this.vel = Array.from({ length: N }, () => ({ x: 0, y: 0 }));
    this.active = false;
    this.seen = 0; // detections since this body appeared; flickering ghosts never confirm
    this.alpha = 0; // presence fade, 0..1
    this.lastSeen = -1e9;
    this.lastT = 0;
  }
  center() { return { x: (this.lm[23].x + this.lm[24].x) / 2, y: (this.lm[23].y + this.lm[24].y) / 2 }; }
  ingest(raw, t) {
    const dt = this.active ? Math.min(0.2, Math.max(1e-3, t - this.lastT)) : 1 / 30;
    if (!this.active) {
      for (let i = 0; i < N; i++) { this.fx[i].x = null; this.fy[i].x = null; }
      this.seen = 0;
    }
    this.seen++;
    for (let i = 0; i < N; i++) {
      const r = raw[i];
      const x = this.fx[i].filter(r.x, dt);
      const y = this.fy[i].filter(r.y, dt);
      const p = this.lm[i];
      if (this.active) {
        // Velocity eased so a single noisy detection cannot fling particles.
        const k = 1 - Math.exp(-dt / 0.04);
        this.vel[i].x += ((x - p.x) / dt - this.vel[i].x) * k;
        this.vel[i].y += ((y - p.y) / dt - this.vel[i].y) * k;
      } else {
        this.vel[i].x = 0; this.vel[i].y = 0;
      }
      p.x = x; p.y = y;
      p.visibility = r.visibility ?? 1;
    }
    this.active = true;
    this.lastSeen = t;
    this.lastT = t;
  }
}

// PoseLandmarker sometimes returns the same person twice (slightly offset, or
// with left and right swapped). Two poses whose key joints sit within half a
// torso of each other are one person; keep the first.
const KEY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const SWAP = [12, 11, 14, 13, 16, 15, 24, 23, 26, 25, 28, 27];
export function bodyDistance(a, b) {
  const torso = Math.max(0.02, Math.hypot((a[11].x + a[12].x - a[23].x - a[24].x) / 2, (a[11].y + a[12].y - a[23].y - a[24].y) / 2));
  let d1 = 0, d2 = 0;
  for (let i = 0; i < KEY.length; i++) {
    d1 += Math.hypot(a[KEY[i]].x - b[KEY[i]].x, a[KEY[i]].y - b[KEY[i]].y);
    d2 += Math.hypot(a[KEY[i]].x - b[SWAP[i]].x, a[KEY[i]].y - b[SWAP[i]].y);
  }
  return Math.min(d1, d2) / KEY.length / torso;
}
const torsoOf = (a) => Math.hypot((a[11].x + a[12].x - a[23].x - a[24].x) / 2, (a[11].y + a[12].y - a[23].y - a[24].y) / 2);
function sameBody(a, b) {
  const torso = Math.max(0.02, torsoOf(a), torsoOf(b));
  let d1 = 0, d2 = 0;
  for (let i = 0; i < KEY.length; i++) {
    d1 += Math.hypot(a[KEY[i]].x - b[KEY[i]].x, a[KEY[i]].y - b[KEY[i]].y);
    d2 += Math.hypot(a[KEY[i]].x - b[SWAP[i]].x, a[KEY[i]].y - b[SWAP[i]].y);
  }
  if (Math.min(d1, d2) / KEY.length < torso * 0.5) return true;
  // Hips nearly on top of each other: one person, whatever the limbs say.
  const ha = { x: (a[23].x + a[24].x) / 2, y: (a[23].y + a[24].y) / 2 };
  const hb = { x: (b[23].x + b[24].x) / 2, y: (b[23].y + b[24].y) / 2 };
  return Math.hypot(ha.x - hb.x, ha.y - hb.y) < torso * 0.8;
}
function dedupe(poses) {
  const out = [];
  for (const p of poses) if (!out.some((q) => sameBody(p, q))) out.push(p);
  return out;
}

// Keeps up to `max` bodies in stable slots, matched by hip position.
export class BodyTracker {
  constructor(max = 3) {
    this.slots = Array.from({ length: max }, () => new BodySlot());
  }
  update(poses, t) {
    this.rawCount = poses ? poses.length : 0;
    if (poses && poses.length > 1) this.lastPair = bodyDistance(poses[0], poses[1]);
    poses = dedupe(poses || []);
    const free = new Set(this.slots.map((_, i) => i));
    const assigned = [];
    // Greedy nearest match on hip center.
    const cands = (poses || []).map((raw) => ({ raw, c: { x: (raw[23].x + raw[24].x) / 2, y: (raw[23].y + raw[24].y) / 2 } }));
    for (const cand of cands) {
      let best = -1, bestD = 0.35;
      for (const i of free) {
        const s = this.slots[i];
        if (!s.active) continue;
        const c = s.center();
        const d = Math.hypot(c.x - cand.c.x, c.y - cand.c.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) for (const i of free) { if (!this.slots[i].active) { best = i; break; } }
      if (best < 0) continue;
      free.delete(best);
      assigned.push([best, cand.raw]);
    }
    for (const [i, raw] of assigned) this.slots[i].ingest(raw, t);
    // Two live slots sitting on the same person (a glitch opened a second
    // one): keep the established slot, drop the newcomer.
    for (let i = 0; i < this.slots.length; i++) {
      for (let j = i + 1; j < this.slots.length; j++) {
        const a = this.slots[i], b = this.slots[j];
        if (!a.active || !b.active || !sameBody(a.lm, b.lm)) continue;
        const loser = a.seen + a.alpha * 100 >= b.seen + b.alpha * 100 ? b : a;
        loser.active = false;
      }
    }
    // Hold a lost body briefly (a missed detection is common), then release it.
    for (const i of free) {
      const s = this.slots[i];
      if (s.active && t - s.lastSeen > 0.35) s.active = false;
    }
  }
  // Called every render frame: presence fade.
  tick(dt) {
    // A new body has to hold for a few detections before it lights up. The
    // first body on screen confirms quickly; extra ones must prove themselves.
    const anyShown = this.slots.some((s) => s.alpha > 0.5);
    for (const s of this.slots) {
      const target = s.active && s.seen >= (anyShown && s.alpha < 0.5 ? 10 : 3) ? 1 : 0;
      s.alpha += (target - s.alpha) * (1 - Math.exp(-dt / (target ? 0.25 : 0.4)));
      if (!s.active && s.alpha < 0.01) s.alpha = 0;
    }
  }
  primary() {
    let best = null;
    for (const s of this.slots) if (s.active && s.alpha > 0.5 && (!best || s.lastSeen > best.lastSeen)) best = s;
    return best;
  }
}
