// Turns tracked bodies into the joint uniforms the particle shaders read.
// World space: screen height is 2 units (y up), width is 2 * aspect.

export const MAXB = 3;
export const NJ = 18;

// Body segments: [jointA, jointB, radius (x torso length), share of particles].
// Segment 0 is the torso quad and segment 1 is the head disc (handled apart).
// Shares roughly follow each part's area so the body glows evenly; hands and
// feet get a little extra because the eye follows them.
export const SEGS = [
  [-1, -1, 0.14, 0.27], // torso
  [-1, -1, 0.19, 0.055], // head
  [1, 0, 0.08, 0.012], // neck
  [2, 4, 0.10, 0.05], [3, 5, 0.10, 0.05], // upper arms
  [4, 6, 0.085, 0.042], [5, 7, 0.085, 0.042], // forearms
  [6, 8, 0.075, 0.028], [7, 9, 0.075, 0.028], // hands
  [10, 12, 0.15, 0.10], [11, 13, 0.15, 0.10], // thighs
  [12, 14, 0.105, 0.075], [13, 15, 0.105, 0.075], // shins
  [14, 16, 0.07, 0.028], [15, 17, 0.07, 0.028], // feet
];

// Key joints, in the order the shaders index them.
// 0 head center, 1 neck, 2/3 shoulders, 4/5 elbows, 6/7 wrists, 8/9 hand tips,
// 10/11 hips, 12/13 knees, 14/15 ankles, 16/17 toes.
const PICK = [null, null, 11, 12, 13, 14, 15, 16, 19, 20, 23, 24, 25, 26, 27, 28, 31, 32];

// Convex hull area and perimeter (monotone chain).
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0, per = 0;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    a += p[0] * q[1] - q[0] * p[1];
    per += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return [Math.abs(a) / 2, per];
}

// Body area (world units) that looks right at gain 1.
const AREA_REF = 0.14;

export class BodyUniforms {
  constructor() {
    this.joints = new Float32Array(MAXB * NJ * 4); // xy pos, xy vel
    this.vis = new Float32Array(MAXB * NJ); // landmark confidence, eased
    this.scale = new Float32Array(MAXB); // torso length in world units
    this.alpha = new Float32Array(MAXB);
    this.area = new Float32Array(MAXB); // on-screen body area, world units
    this.gain = new Float32Array(MAXB).fill(1); // exposure per body
    this.count = 0;
    this.floor = -1; // lowest ankle, world y, eased
    this.view = { w: 2, h: 2, mirror: false };
  }

  // Fit the video inside the screen (contain).
  setView(videoW, videoH, aspect, mirror) {
    const s = Math.min((2 * aspect) / videoW, 2 / videoH);
    this.view = { w: videoW * s, h: videoH * s, mirror };
  }

  update(slots, now, dt) {
    const { w, h, mirror } = this.view;
    const sx = mirror ? -w : w;
    let lowest = Infinity;
    this.count = 0;
    for (let b = 0; b < MAXB; b++) {
      const s = slots[b];
      this.alpha[b] = s.alpha;
      if (s.alpha <= 0) { this.scale[b] = 0; continue; }
      if (!s.active && this.scale[b] === 0) continue;
      this.count = b + 1;
      // Predict forward to this render frame (detections arrive at ~30 Hz).
      const lead = s.active ? Math.min(0.05, Math.max(0, now - s.lastT)) : 0;
      const P = (i) => {
        const p = s.lm[i], v = s.vel[i];
        return [(p.x + v.x * lead - 0.5) * sx, (0.5 - (p.y + v.y * lead)) * h, v.x * sx, -v.y * h];
      };
      const avg = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, (a[3] + b[3]) / 2];
      const lsh = P(11), rsh = P(12), lhip = P(23), rhip = P(24);
      const neck = avg(lsh, rsh);
      const hipC = avg(lhip, rhip);
      // Body size. The torso alone collapses when someone folds over or lies
      // down (it points at the camera), so take the largest of several bones,
      // each scaled to torso units, and let it shrink only slowly.
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const sizeNow = Math.max(
        d(neck, hipC),
        d(lsh, rsh) * 1.35,
        (d(lhip, P(25)) + d(rhip, P(26))) * 0.5 * 1.1,
        (d(P(25), P(27)) + d(P(26), P(28))) * 0.5 * 1.15,
        (d(lsh, P(13)) + d(rsh, P(14))) * 0.5 * 1.65,
      );
      const prevS = this.scale[b] || sizeNow;
      const torso = Math.max(0.05, prevS + (sizeNow - prevS) * (1 - Math.exp(-dt / (sizeNow > prevS ? 0.25 : 2.5))));
      // Head center: midway between the ears, pulled toward the nose.
      const ears = avg(P(7), P(8));
      const nose = P(0);
      const head = [ears[0] * 0.6 + nose[0] * 0.4, ears[1] * 0.6 + nose[1] * 0.4, ears[2] * 0.6 + nose[2] * 0.4, ears[3] * 0.6 + nose[3] * 0.4];
      const base = b * NJ * 4;
      for (let j = 0; j < NJ; j++) {
        const v = j === 0 ? head : j === 1 ? neck : P(PICK[j]);
        // Clamp absurd velocities from tracking glitches.
        const sp = Math.hypot(v[2], v[3]);
        const k = sp > 6 ? 6 / sp : 1;
        this.joints[base + j * 4] = v[0];
        this.joints[base + j * 4 + 1] = v[1];
        this.joints[base + j * 4 + 2] = v[2] * k;
        this.joints[base + j * 4 + 3] = v[3] * k;
        const raw = j === 0 ? Math.max(s.lm[0].visibility, (s.lm[7].visibility + s.lm[8].visibility) / 2)
          : j === 1 ? Math.min(s.lm[11].visibility, s.lm[12].visibility) : s.lm[PICK[j]].visibility;
        const vi = b * NJ + j;
        this.vis[vi] += (raw - this.vis[vi]) * (1 - Math.exp(-dt / 0.12));
      }
      this.scale[b] = torso;
      // Exposure: the same light spread over a bigger silhouette looks dimmer,
      // packed into a curled-up one it blows out. Brightness follows area.
      const J = (j) => [this.joints[base + j * 4], this.joints[base + j * 4 + 1]];
      let area = 0;
      for (let k = 2; k < SEGS.length; k++) area += d(J(SEGS[k][0]), J(SEGS[k][1])) * 2 * SEGS[k][2] * torso;
      area += d(lsh, rsh) * d(neck, hipC) * 0.85 + Math.PI * (SEGS[1][2] * torso) ** 2;
      // Limbs folded over the torso overlap, so the sum of parts overcounts a
      // curled-up body. The padded convex hull of the joints catches that.
      const pts = [];
      for (let j = 0; j < NJ; j++) pts.push(J(j));
      const [hullA, hullP] = hull(pts);
      const pad = 0.1 * torso;
      area = Math.min(area, hullA + hullP * pad + Math.PI * pad * pad);
      this.area[b] += (area - this.area[b]) * (1 - Math.exp(-dt / 0.3));
      // Particles already widen with body size (see the draw shader). Bloom
      // sums all the light, so a big bright body also throws a bigger halo:
      // follow area only by its square root and divide the widening back out.
      const widen = Math.min(1.5, Math.max(0.8, Math.sqrt(torso / 0.25)));
      this.gain[b] = Math.min(2, Math.max(0.35, Math.sqrt(this.area[b] / AREA_REF) / (widen * widen)));
      if (s.active) {
        // Floor sits under the lowest visible part of the body, not just the
        // feet: on the ground the hands, hips or head can be lowest.
        for (let j = 0; j < NJ; j++) if (this.vis[b * NJ + j] > 0.5) lowest = Math.min(lowest, this.joints[base + j * 4 + 1]);
      }
    }
    // Floor for gravity mode: just under the lowest foot, slow to rise.
    const target = Number.isFinite(lowest) ? Math.max(-0.98, lowest - 0.04) : -0.92;
    const tau = target < this.floor ? 0.15 : 6;
    this.floor += (target - this.floor) * (1 - Math.exp(-dt / tau));
  }
}
