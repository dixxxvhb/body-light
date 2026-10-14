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

// One Euro filter: smooth when slow, responsive when fast. Tuned for 30 fps
// landmark input in normalized image coords.
class OneEuro {
  constructor(minCutoff = 1.6, beta = 12, dCutoff = 1.2) {
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
    this.alpha = 0; // presence fade, 0..1
    this.lastSeen = -1e9;
    this.lastT = 0;
  }
  center() { return { x: (this.lm[23].x + this.lm[24].x) / 2, y: (this.lm[23].y + this.lm[24].y) / 2 }; }
  ingest(raw, t) {
    const dt = this.active ? Math.min(0.2, Math.max(1e-3, t - this.lastT)) : 1 / 30;
    if (!this.active) {
      for (let i = 0; i < N; i++) { this.fx[i].x = null; this.fy[i].x = null; }
    }
    for (let i = 0; i < N; i++) {
      const r = raw[i];
      const x = this.fx[i].filter(r.x, dt);
      const y = this.fy[i].filter(r.y, dt);
      const p = this.lm[i];
      if (this.active) {
        // Velocity eased so a single noisy detection cannot fling particles.
        const k = 1 - Math.exp(-dt / 0.06);
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

// Keeps up to `max` bodies in stable slots, matched by hip position.
export class BodyTracker {
  constructor(max = 3) {
    this.slots = Array.from({ length: max }, () => new BodySlot());
  }
  update(poses, t) {
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
    // Hold a lost body briefly (a missed detection is common), then release it.
    for (const i of free) {
      const s = this.slots[i];
      if (s.active && t - s.lastSeen > 0.35) s.active = false;
    }
  }
  // Called every render frame: presence fade.
  tick(dt) {
    for (const s of this.slots) {
      const target = s.active ? 1 : 0;
      s.alpha += (target - s.alpha) * (1 - Math.exp(-dt / (target ? 0.25 : 0.4)));
      if (!s.active && s.alpha < 0.01) s.alpha = 0;
    }
  }
  primary() {
    let best = null;
    for (const s of this.slots) if (s.active && (!best || s.lastSeen > best.lastSeen)) best = s;
    return best;
  }
}
