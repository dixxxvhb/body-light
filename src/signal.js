// Movement signal: turns one body's pose landmarks into a small, clean stream
// of musical-ish control values. No dependencies; Body Band can import this
// file on its own.
//
//   import { MovementSignal } from './signal.js'
//   const sig = new MovementSignal()
//   sig.on('hit', (h) => ...)
//   const frame = sig.update(landmarks, performance.now())
//
// `landmarks` is MediaPipe Pose's 33-point list in normalized image coords
// ({ x, y, visibility }), x right, y down. Pass null when nobody is in frame.
// Distances are measured in torso lengths so the numbers do not change with
// how far the dancer stands from the camera. Left/right are the dancer's own.
//
// Frame shape (see README for ranges):
// {
//   t, present,
//   energy,        0..1  overall movement, smoothed
//   expansion,     0..1  0 = folded in, 1 = limbs fully out
//   stillness,     0..1  1 = not moving at all
//   stillFor,      seconds held still (0 while moving)
//   level,         0..1  1 = standing tall, 0 = crouched / on the floor
//   center: { x, y, vx, vy }        hip center, image coords, per second
//   limbs: { head, leftHand, rightHand, leftFoot, rightFoot, core }
//          each { x, y, vx, vy, speed, speedNorm }  speed in torso lengths/s
//   hits: [{ limb, strength, x, y, dx, dy, t }]     sharp stops this frame
// }

const IDX = {
  nose: 0, lEar: 7, rEar: 8,
  lSh: 11, rSh: 12, lWr: 15, rWr: 16, lIdx: 19, rIdx: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lFoot: 31, rFoot: 32,
};

export const LIMBS = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'core'];

// Torso lengths per second that count as "fast" for each limb.
const FAST = { head: 2.2, leftHand: 6, rightHand: 6, leftFoot: 4.5, rightFoot: 4.5, core: 2.2 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Frame-rate independent exponential smoothing toward `target`.
const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

function limbPoint(lm, name) {
  switch (name) {
    case 'head': return lm[IDX.nose];
    case 'leftHand': return mid(lm[IDX.lWr], lm[IDX.lIdx]);
    case 'rightHand': return mid(lm[IDX.rWr], lm[IDX.rIdx]);
    case 'leftFoot': return mid(lm[IDX.lAnk], lm[IDX.lFoot]);
    case 'rightFoot': return mid(lm[IDX.rAnk], lm[IDX.rFoot]);
    case 'core': return mid(lm[IDX.lHip], lm[IDX.rHip]);
  }
}

export class MovementSignal {
  constructor({ hitThreshold = 1, hitCooldown = 0.18, mirror = false } = {}) {
    this.hitThreshold = hitThreshold; // scales every limb's "fast" speed for hit detection
    this.hitCooldown = hitCooldown;
    this.mirror = mirror; // flip x in the output (useful when the screen is mirrored)
    this.listeners = { hit: new Set(), frame: new Set() };
    this.reset();
  }

  reset() {
    this.prevT = null;
    this.torso = 0;
    this.energy = 0;
    this.expansion = 0;
    this.level = 1;
    this.stillFor = 0;
    this.slowEnergy = 0;
    this.limbs = {};
    for (const n of LIMBS) {
      this.limbs[n] = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, speedNorm: 0, px: null, py: null, peak: 0, peakT: -1, lastHit: -1 };
    }
    this.last = this.emptyFrame(0);
  }

  on(type, fn) { this.listeners[type].add(fn); return () => this.listeners[type].delete(fn); }

  emptyFrame(t) {
    const limbs = {};
    for (const n of LIMBS) limbs[n] = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, speedNorm: 0 };
    return { t, present: false, energy: 0, expansion: 0, stillness: 1, stillFor: 0, level: 1, center: { x: 0.5, y: 0.5, vx: 0, vy: 0 }, limbs, hits: [] };
  }

  update(lm, tMs) {
    const t = tMs / 1000;
    if (!lm || lm.length < 33) {
      this.prevT = null;
      for (const n of LIMBS) this.limbs[n].px = null;
      this.energy = 0;
      const f = this.emptyFrame(t);
      this.last = f;
      for (const fn of this.listeners.frame) fn(f);
      return f;
    }
    const dt = this.prevT == null ? 1 / 30 : Math.min(0.25, Math.max(1e-3, t - this.prevT));
    const first = this.prevT == null;
    this.prevT = t;

    const shC = mid(lm[IDX.lSh], lm[IDX.rSh]);
    const hipC = mid(lm[IDX.lHip], lm[IDX.rHip]);
    // Body size in torso units, robust to folding over or lying down (the
    // torso alone shrinks when it points at the camera).
    const torsoNow = Math.max(1e-3,
      dist(shC, hipC),
      dist(lm[IDX.lSh], lm[IDX.rSh]) * 1.35,
      (dist(lm[IDX.lHip], lm[IDX.lKnee]) + dist(lm[IDX.rHip], lm[IDX.rKnee])) * 0.55,
      (dist(lm[IDX.lKnee], lm[IDX.lAnk]) + dist(lm[IDX.rKnee], lm[IDX.rAnk])) * 0.575);
    this.torso = this.torso ? ease(this.torso, torsoNow, dt, torsoNow > this.torso ? 0.25 : 2.5) : torsoNow;
    const T = this.torso;

    const hits = [];
    let energySum = 0;
    let energyW = 0;
    for (const n of LIMBS) {
      const L = this.limbs[n];
      const p = limbPoint(lm, n);
      const x = this.mirror ? 1 - p.x : p.x;
      const y = p.y;
      if (L.px == null || first) { L.px = x; L.py = y; }
      const vx = (x - L.px) / dt;
      const vy = (y - L.py) / dt;
      L.px = x; L.py = y;
      L.x = x; L.y = y;
      L.vx = ease(L.vx, vx, dt, 0.05);
      L.vy = ease(L.vy, vy, dt, 0.05);
      const speed = Math.hypot(L.vx, L.vy) / T;
      L.speed = ease(L.speed, speed, dt, 0.04);
      L.speedNorm = clamp01(L.speed / FAST[n]);
      const w = n === 'core' || n === 'head' ? 1.5 : 1;
      energySum += L.speedNorm * w;
      energyW += w;

      // A hit is a sharp stop: the limb was moving fast and then lost most of
      // its speed within ~150 ms. That is the accent a dancer would call a hit.
      const fast = FAST[n] * this.hitThreshold * 0.6;
      if (L.speed > L.peak || t - L.peakT > 0.15) { L.peak = L.speed; L.peakT = t; }
      if (L.peak > fast && L.speed < L.peak * 0.4 && t - L.lastHit > this.hitCooldown) {
        const mag = Math.hypot(L.vx, L.vy) || 1;
        hits.push({
          limb: n,
          strength: clamp01((L.peak - fast) / (fast * 1.5) + 0.25),
          x, y, dx: L.vx / mag, dy: L.vy / mag, t,
        });
        L.lastHit = t;
        L.peak = 0;
      }
    }

    // Shaped so a walk is ~0.2 and full-out travelling is ~0.8+.
    const rawEnergy = clamp01(Math.pow(energySum / energyW, 0.8) * 1.4);
    this.energy = ease(this.energy, rawEnergy, dt, rawEnergy > this.energy ? 0.08 : 0.35);
    this.slowEnergy = ease(this.slowEnergy, rawEnergy, dt, 0.8);

    // Expansion: average reach of hands, feet and head from the hip center,
    // measured in torso lengths. ~1.0 is folded, ~2.4 is a full star.
    const reach = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']
      .map((n) => Math.hypot(this.limbs[n].x - (this.mirror ? 1 - hipC.x : hipC.x), this.limbs[n].y - hipC.y) / T)
      .reduce((a, b) => a + b, 0) / 5;
    this.expansion = ease(this.expansion, clamp01((reach - 1.0) / 1.4), dt, 0.15);

    // Level: how far the hips sit above the ankles, against a standing leg.
    const ankC = mid(lm[IDX.lAnk], lm[IDX.rAnk]);
    const leg = (dist(lm[IDX.lHip], lm[IDX.lKnee]) + dist(lm[IDX.lKnee], lm[IDX.lAnk]) +
      dist(lm[IDX.rHip], lm[IDX.rKnee]) + dist(lm[IDX.rKnee], lm[IDX.rAnk])) / 2;
    const standingLeg = Math.max(leg, T * 1.6);
    this.level = ease(this.level, clamp01((ankC.y - hipC.y) / standingLeg / 0.95), dt, 0.2);

    const stillness = clamp01(1 - this.slowEnergy / 0.08);
    this.stillFor = stillness > 0.7 ? this.stillFor + dt : 0;

    const core = this.limbs.core;
    const limbsOut = {};
    for (const n of LIMBS) {
      const L = this.limbs[n];
      limbsOut[n] = { x: L.x, y: L.y, vx: L.vx, vy: L.vy, speed: L.speed, speedNorm: L.speedNorm };
    }
    const f = {
      t, present: true,
      energy: this.energy,
      expansion: this.expansion,
      stillness,
      stillFor: this.stillFor,
      level: this.level,
      center: { x: core.x, y: core.y, vx: core.vx, vy: core.vy },
      limbs: limbsOut,
      hits,
    };
    this.last = f;
    for (const h of hits) for (const fn of this.listeners.hit) fn(h);
    for (const fn of this.listeners.frame) fn(f);
    return f;
  }
}

// Optional: mirror every frame onto a BroadcastChannel so another tab or app on
// the same origin (Body Band) can listen without importing anything.
//   new BroadcastChannel('body-signal').onmessage = (e) => e.data  // a frame
export function broadcastSignal(signal, name = 'body-signal') {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(name);
  const off = signal.on('frame', (f) => ch.postMessage(f));
  return () => { off(); ch.close(); };
}
