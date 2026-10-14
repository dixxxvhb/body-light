// GPU particle field. Every particle is born bound to a point on the body
// (a spot on a limb capsule, the torso or the head), rides that point on a
// damped spring so the light has mass and lags with inertia, and is released
// into a curl-noise flow field as its bond decays. Fast limbs shed light
// faster; still limbs keep it. Released light is stirred by limbs that pass
// through it, so the space keeps a memory of where the body was.
import * as THREE from 'three';
import { MAXB, NJ, SEGS } from './body.js';

const NSEG = SEGS.length;
const shareSum = SEGS.reduce((a, s) => a + s[3], 0);
let cum = 0;
const CUM = SEGS.map((s) => (cum += s[3] / shareSum));

const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const SEG_GLSL = `
#define NSEG ${NSEG}
const int SEG_A[NSEG] = int[NSEG](${SEGS.map((s) => s[0]).join(',')});
const int SEG_B[NSEG] = int[NSEG](${SEGS.map((s) => s[1]).join(',')});
const float SEG_R[NSEG] = float[NSEG](${SEGS.map((s) => f(s[2])).join(',')});
const float SEG_CUM[NSEG] = float[NSEG](${CUM.map((c, i) => f(i === NSEG - 1 ? 1.0001 : +c.toFixed(5))).join(',')});
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
#define MAXB ${MAXB}
#define NJ ${NJ}
${SEG_GLSL}
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tRand;
uniform float uTime;
uniform float uDt;
uniform float uAspect;
uniform vec4 uJ[MAXB * NJ];
uniform float uScale[MAXB];
uniform float uAlpha[MAXB];
uniform float uVis[MAXB * NJ];
uniform int uCount;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec4 hash42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// Anchor: where on body b this particle lives, plus that point's velocity.
void anchor(int b, vec4 rnd, out vec2 P, out vec2 V, out float rad, out float conf) {
  int base = b * NJ;
  float S = max(uScale[b], 0.03);
  int seg = NSEG - 1;
  for (int i = 0; i < NSEG; i++) { if (rnd.x < SEG_CUM[i]) { seg = i; break; } }
  rad = SEG_R[seg] * S;
  if (seg == 0) {
    // Soft, rounded torso: denser down the center line, tapering at the
    // waist, no hard rectangle edges.
    float v = mix(-0.05, 1.05, rnd.z);
    float c = (rnd.y + fract(rnd.y * 7.31 + rnd.w)) - 1.0; // triangular, -1..1
    float taper = mix(1.0, 0.72, smoothstep(0.35, 0.8, v)) * mix(0.82, 1.0, smoothstep(-0.05, 0.18, v));
    float u = 0.5 + c * 0.62 * taper;
    vec4 top = mix(uJ[base + 2], uJ[base + 3], u);
    vec4 bot = mix(uJ[base + 10], uJ[base + 11], u);
    vec4 q = mix(top, bot, v);
    // A little depth to the edges so the torso is not a flat card.
    P = q.xy + (rnd.w - 0.5) * vec2(0.06, 0.03) * S;
    V = q.zw;
    conf = min(min(uVis[base + 2], uVis[base + 3]), min(uVis[base + 10], uVis[base + 11]));
  } else if (seg == 1) {
    vec4 c = uJ[base];
    float a = rnd.y * 6.2831853;
    float r = pow(rnd.z, 0.8) * rad; // a little denser toward the center, no hard rim
    P = c.xy + vec2(cos(a), sin(a) * 1.18) * r;
    V = c.zw;
    conf = uVis[base];
  } else {
    vec4 A = uJ[base + SEG_A[seg]];
    vec4 B = uJ[base + SEG_B[seg]];
    float t = mix(-0.08, 1.08, rnd.y);
    vec4 q = mix(A, B, t);
    vec2 d = B.xy - A.xy;
    float L = length(d);
    vec2 dir = L > 1e-5 ? d / L : vec2(0.0, 1.0);
    float o = rnd.z * 2.0 - 1.0;
    o = sign(o) * pow(abs(o), 1.35); // denser down the middle of the limb
    P = q.xy + vec2(-dir.y, dir.x) * o * rad;
    V = q.zw;
    conf = min(uVis[base + SEG_A[seg]], uVis[base + SEG_B[seg]]);
  }
}

// About 30% of particles are core light: they stay on the body whatever the
// mode, so the figure always reads. The rest are shed light and follow the
// mode's rules (flow, fall, burst, freeze).
bool isCore(vec2 uv) { return hash12(uv * 57.31 + 3.7) < 0.3; }

vec4 particleRand(vec4 r0, float seed) {
  return fract(r0 + seed * vec4(1.6180339, 2.4142136, 3.3027756, 4.2360680) * 7.0);
}
`;

const NOISE = /* glsl */ `
// Ashima simplex noise (MIT).
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// Divergence-free 2D flow from the curl of a noise potential.
vec2 curl(vec2 p, float t) {
  const float e = 0.01;
  float n1 = snoise(vec3(p.x, p.y + e, t));
  float n2 = snoise(vec3(p.x, p.y - e, t));
  float n3 = snoise(vec3(p.x + e, p.y, t));
  float n4 = snoise(vec3(p.x - e, p.y, t));
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}
`;

const SIM_UNIFORMS = /* glsl */ `
uniform int uMode;          // 0 flow, 1 gravity, 2 burst, 3 freeze
uniform float uRelease;     // base bond decay per second
uniform float uReleaseSpeed;// extra decay per torso-length/s of limb speed
uniform float uK;           // spring stiffness
uniform float uC;           // spring damping
uniform float uFlowAmp;
uniform float uFlowScale;
uniform float uFlowDrag;
uniform float uWake;
uniform float uGravity;
uniform float uFloor;
uniform float uSpawn;       // chance a dead particle is reborn this frame
uniform float uDust;        // same, for ambient dust when nobody is there
uniform vec2 uLife;         // min/max life of body light
uniform vec4 uHit[4];       // xy pos, z strength (0 = none), w radius
uniform vec4 uHitDir[4];    // xy travel direction
uniform float uHitKick;
uniform float uHitRelease;
uniform float uFreezeAge;   // aging rate of released light in freeze mode
`;

const VEL_FRAG = COMMON + NOISE + SIM_UNIFORMS + /* glsl */ `
int pickBody(float r) {
  if (uCount == 0) return -1;
  int start = int(floor(r * float(uCount)));
  for (int k = 0; k < MAXB; k++) {
    int b = (start + k) % uCount;
    if (uAlpha[b] > 0.35) return b;
  }
  return -1;
}

void main() {
  vec4 p = texture2D(tPos, vUv);
  vec4 v = texture2D(tVel, vUv);
  vec4 r0 = texture2D(tRand, vUv);

  if (p.z >= p.w) {
    // Dead: maybe reborn this frame.
    float h = hash12(vUv * 917.3 + fract(uTime * 0.731) * 113.0);
    int b = pickBody(r0.w);
    if (b >= 0 && h < uSpawn) {
      float seed = hash12(vUv * 311.7 + fract(uTime * 0.377) * 71.0) * 0.9;
      vec2 P, V; float rad, conf;
      anchor(b, particleRand(r0, seed), P, V, rad, conf);
      // Parts the tracker cannot see are not lit (no guessing limbs into existence).
      if (conf < 0.5) { gl_FragColor = vec4(0.0); return; }
      gl_FragColor = vec4(V, 1.0, float(b + 1) + seed);
    } else if (b < 0 && h < uDust) {
      vec2 d = (hash42(vUv * 51.3 + uTime).xy - 0.5) * 0.04;
      gl_FragColor = vec4(d, 0.0, 4.0);
    } else {
      gl_FragColor = vec4(0.0);
    }
    return;
  }

  float kind = floor(v.w);
  float seed = fract(v.w);
  vec2 pos = p.xy;
  vec2 vel = v.xy;
  float bond = v.z;
  vec2 acc = vec2(0.0);

  if (kind >= 1.0 && kind <= 3.0) {
    int b = int(kind) - 1;
    vec2 T, TV; float rad, conf;
    anchor(b, particleRand(r0, seed), T, TV, rad, conf);
    float S = max(uScale[b], 0.03);
    // Gesture (a limb moving against the body) sheds light; travelling
    // (the whole body moving) sheds much less, so a run does not dissolve you.
    vec2 coreV = (uJ[b * NJ + 10].zw + uJ[b * NJ + 11].zw) * 0.5;
    float limbSpeed = (length(TV - coreV) + 0.35 * length(coreV)) / S;
    bool core = isCore(vUv);
    float rel = core
      ? 0.12 + 0.04 * limbSpeed * limbSpeed
      : uRelease * (0.6 + 0.8 * r0.y) + uReleaseSpeed * limbSpeed * limbSpeed * 0.25;
    if (uAlpha[b] < 0.6) rel += 3.0;
    if (conf < 0.45) rel += 4.0;
    // If the anchor jumped (a tracking glitch, a cut in the video), let the
    // light go instead of dragging it across the screen in a straight line.
    if (length(T - pos) > S * 0.45) { rel += 25.0; vel *= exp(-12.0 * uDt); }
    bond = max(0.0, bond - rel * uDt);
    acc += bond * ((T - pos) * uK + (TV - vel) * uC);
  }
  float freeF = 1.0 - bond;

  // Flow field: two octaves of curl noise, slowly evolving.
  vec2 q = pos * uFlowScale;
  vec2 flow = curl(q, uTime * 0.11) + 0.45 * curl(q * 2.3 + 17.0, uTime * 0.23);
  acc += freeF * (flow * uFlowAmp - vel) * uFlowDrag;

  // Wake: free light near a moving limb is dragged along with it.
  if (uWake > 0.0) {
    for (int b = 0; b < MAXB; b++) {
      if (b >= uCount || uAlpha[b] < 0.3) continue;
      int base = b * NJ;
      float S = max(uScale[b], 0.03);
      for (int s = 2; s < NSEG; s++) {
        vec4 A = uJ[base + SEG_A[s]];
        vec4 B = uJ[base + SEG_B[s]];
        vec2 ab = B.xy - A.xy;
        float t = clamp(dot(pos - A.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        vec2 sv = mix(A.zw, B.zw, t);
        float d = length(pos - (A.xy + ab * t));
        float r = SEG_R[s] * S;
        float w = (1.0 - smoothstep(r, r * 5.0, d)) * smoothstep(0.4, 2.0, length(sv) / S);
        acc += freeF * (sv - vel) * w * uWake;
      }
    }
  }

  // Sharp hits: an impulse that throws nearby light outward and along the strike.
  for (int i = 0; i < 4; i++) {
    if (uHit[i].z <= 0.0) continue;
    vec2 dd = pos - uHit[i].xy;
    float rr = uHit[i].w;
    float w = exp(-dot(dd, dd) / (rr * rr)) * uHit[i].z;
    if (w < 0.002) continue;
    bond = max(0.0, bond - w * uHitRelease);
    vec2 out_ = normalize(dd + 1e-4) * (0.6 + 0.8 * r0.x) + uHitDir[i].xy * 0.9;
    vel += out_ * w * uHitKick;
    freeF = 1.0 - bond;
  }

  if (uMode == 1) {
    acc.y -= uGravity * freeF;
    if (bond < 0.5 && pos.y <= uFloor + 0.002 && vel.y < 0.0) {
      vel.y = -vel.y * (0.25 + 0.2 * r0.z);
      vel.x *= 0.7;
    }
  }
  if (uMode == 3 && freeF > 0.5 && r0.w < 0.5 && !isCore(vUv)) {
    // Freeze: released light coasts to a stop and hangs where it was left.
    vel *= exp(-5.0 * uDt * freeF);
    acc *= 1.0 - freeF;
  }

  // Air drag grows with speed, so flung light decelerates into the flow
  // instead of flying off in a straight line.
  acc -= freeF * vel * length(vel) * 1.6;
  vel += acc * uDt;
  float sp = length(vel);
  float cap = mix(3.0, 8.0, bond);
  if (sp > cap) vel *= cap / sp;
  gl_FragColor = vec4(vel, bond, v.w);
}
`;

const POS_FRAG = COMMON + SIM_UNIFORMS + /* glsl */ `
uniform sampler2D tVelNew;
void main() {
  vec4 p = texture2D(tPos, vUv);
  vec4 v = texture2D(tVelNew, vUv);
  vec4 r0 = texture2D(tRand, vUv);
  float kind = floor(v.w);
  if (p.z >= p.w) {
    if (kind >= 1.0 && kind <= 3.0) {
      vec2 P, V; float rad, conf;
      anchor(int(kind) - 1, particleRand(r0, fract(v.w)), P, V, rad, conf);
      float h = pow(hash12(vUv * 77.7 + fract(uTime) * 9.1), 1.5);
      float life = isCore(vUv) ? mix(0.7, 1.6, h) : mix(uLife.x, uLife.y, h);
      gl_FragColor = vec4(P, 0.0, life);
    } else if (kind == 4.0) {
      vec4 h = hash42(vUv * 13.1 + fract(uTime * 0.31) * 51.0);
      gl_FragColor = vec4((h.x * 2.0 - 1.0) * uAspect * 1.05, h.y * 2.1 - 1.05, 0.0, mix(4.0, 9.0, h.z));
    } else {
      gl_FragColor = vec4(p.xy, 1.0, 0.0);
    }
    return;
  }
  vec2 pos = p.xy + v.xy * uDt;
  float rate = 1.0;
  // Freeze: about half the light is allowed to hang in the air; the rest keeps
  // cycling so the body never runs out of particles.
  if (uMode == 3 && v.z < 0.3 && kind < 4.0 && r0.w < 0.5 && !isCore(vUv)) rate = uFreezeAge;
  float age = p.z + uDt * rate;
  // Free light lands on the floor when it falls through it; light already
  // below a floor that has since risen just keeps falling.
  if (uMode == 1 && v.z < 0.5 && p.y >= uFloor - 0.001 && pos.y < uFloor) pos.y = uFloor;
  if (abs(pos.x) > uAspect * 1.25 || abs(pos.y) > 1.3) age = p.w;
  gl_FragColor = vec4(pos, age, p.w);
}
`;

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DRAW_VERT = /* glsl */ `
precision highp float;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uAspect;
uniform float uPx;       // world units per pixel
uniform float uSize;     // particle width in pixels
uniform float uStreak;   // seconds of motion a streak shows
uniform float uGain;
uniform float uBodyScale[${MAXB}];
uniform float uBodyGain[${MAXB}];
attribute vec2 ref;
varying vec2 vLocal;
varying float vHalf;
varying vec3 vColor;

// One palette, cold to hot: deep indigo, violet, electric blue, ice, white.
vec3 palette(float h) {
  vec3 c0 = vec3(0.10, 0.02, 0.30);
  vec3 c1 = vec3(0.42, 0.10, 0.95);
  vec3 c2 = vec3(0.10, 0.48, 1.00);
  vec3 c3 = vec3(0.62, 0.92, 1.00);
  vec3 c4 = vec3(1.00, 0.98, 0.95);
  h = clamp(h, 0.0, 1.0) * 4.0;
  if (h < 1.0) return mix(c0, c1, h);
  if (h < 2.0) return mix(c1, c2, h - 1.0);
  if (h < 3.0) return mix(c2, c3, h - 2.0);
  return mix(c3, c4, h - 3.0);
}

void main() {
  vec4 p = texture2D(tPos, ref);
  vec4 v = texture2D(tVel, ref);
  float kind = floor(v.w);
  if (p.z >= p.w || kind < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float age = p.z, life = p.w;
  float t = age / life;
  float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.45, 1.0, t));
  vec2 vel = v.xy;
  float sp = length(vel);
  vec2 dir = sp > 1e-4 ? vel / sp : vec2(1.0, 0.0);
  // A body close to the camera spreads the same particles over more screen,
  // so it gets wider, brighter particles; a small far body gets finer ones.
  float bs = kind < 4.0 ? uBodyScale[int(kind) - 1] : 0.25;
  float near = clamp(bs / 0.25, 0.4, 3.0);
  float w = uSize * uPx * (kind == 4.0 ? 0.8 : clamp(sqrt(near), 0.8, 1.5));
  float len = clamp(sp * uStreak, w, 0.035);
  vHalf = len / w;
  vLocal = position.xy;
  vec2 side = vec2(-dir.y, dir.x);
  // The streak trails behind the particle.
  vec2 world = p.xy - dir * (len * 0.5 - w * 0.5) + dir * position.x * len * 0.5 + side * position.y * w * 0.5;
  gl_Position = vec4(world.x / uAspect, world.y, 0.0, 1.0);

  float bond = v.z;
  float heat = kind == 4.0 ? 0.42 : 0.22 + bond * 0.5 + min(sp, 2.0) * 0.1 - t * 0.35;
  // Released light dims as it ages so the space keeps a trace, not a fog.
  float freeDim = mix((1.0 - t) * (1.0 - t), 1.0, bond);
  // Core light carries the figure at a steady brightness. Shed light is faint
  // while it still sits on the body (so a still dancer does not blow out) and
  // brightens as it leaves, which is what draws the trail.
  vec3 hp = fract(vec3(ref.xyx * 57.31 + 3.7) * 0.1031);
  hp += dot(hp, hp.yzx + 33.33);
  bool core = fract((hp.x + hp.y) * hp.z) < 0.3;
  float base = core ? 0.6 : mix(0.5, 0.2, bond);
  float intensity = (kind == 4.0 ? 0.4 : base * freeDim) * fade / pow(vHalf, 0.75);
  vColor = palette(heat) * intensity * uGain * (kind < 4.0 ? uBodyGain[int(kind) - 1] : 1.0);
}
`;

const DRAW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vLocal;
varying float vHalf;
varying vec3 vColor;
void main() {
  // Capsule falloff measured in half-widths.
  float x = abs(vLocal.x) * vHalf;
  float d = length(vec2(max(x - (vHalf - 1.0), 0.0), vLocal.y));
  float a = exp(-d * d * 3.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

export const MODES = [
  { name: 'Flow', release: 1.1, releaseSpeed: 0.55, K: 150, C: 15, flowAmp: 0.24, flowScale: 1.4, flowDrag: 1.6, wake: 7, gravity: 0, life: [1.3, 3.4], hitKick: 0.45, hitRelease: 3, spawn: 1, freezeAge: 1 },
  { name: 'Gravity', release: 0.9, releaseSpeed: 0.6, K: 150, C: 15, flowAmp: 0.08, flowScale: 1.4, flowDrag: 0.5, wake: 4, gravity: 1.5, life: [1.8, 3.6], hitKick: 1.6, hitRelease: 3, spawn: 1, freezeAge: 1 },
  { name: 'Burst', release: 0.22, releaseSpeed: 0.12, K: 190, C: 17, flowAmp: 0.22, flowScale: 1.6, flowDrag: 1.2, wake: 3, gravity: 0, life: [1.2, 3.2], hitKick: 4.5, hitRelease: 9, spawn: 1, freezeAge: 1, gain: 0.7 },
  { name: 'Freeze', release: 0.8, releaseSpeed: 0.5, K: 150, C: 15, flowAmp: 0.1, flowScale: 1.4, flowDrag: 1.0, wake: 0, gravity: 0, life: [1.6, 2.4], hitKick: 0.6, hitRelease: 2, spawn: 1, freezeAge: 0.2 },
];

export class ParticleField {
  constructor(renderer, size = 512) {
    this.renderer = renderer;
    this.size = size;
    this.count = size * size;
    const rt = () => new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.pos = [rt(), rt()];
    this.vel = [rt(), rt()];
    this.cur = 0;

    const rand = new Float32Array(this.count * 4);
    for (let i = 0; i < rand.length; i++) rand[i] = Math.random();
    this.randTex = new THREE.DataTexture(rand, size, size, THREE.RGBAFormat, THREE.FloatType);
    this.randTex.needsUpdate = true;

    this.uniforms = {
      tPos: { value: null }, tVel: { value: null }, tVelNew: { value: null }, tRand: { value: this.randTex },
      uTime: { value: 0 }, uDt: { value: 1 / 60 }, uAspect: { value: 16 / 9 },
      uJ: { value: new Float32Array(MAXB * NJ * 4) }, uScale: { value: new Float32Array(MAXB) },
      uAlpha: { value: new Float32Array(MAXB) }, uVis: { value: new Float32Array(MAXB * NJ) }, uCount: { value: 0 },
      uMode: { value: 0 }, uRelease: { value: 1 }, uReleaseSpeed: { value: 0.5 }, uK: { value: 150 }, uC: { value: 15 },
      uFlowAmp: { value: 0.3 }, uFlowScale: { value: 1.4 }, uFlowDrag: { value: 1.5 }, uWake: { value: 6 },
      uGravity: { value: 0 }, uFloor: { value: -1 }, uSpawn: { value: 1 }, uDust: { value: 0.0015 },
      uLife: { value: new THREE.Vector2(1.4, 3.8) },
      uHit: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uHitDir: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uHitKick: { value: 1 }, uHitRelease: { value: 3 }, uFreezeAge: { value: 1 },
    };
    const mat = (frag) => new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SIM_VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.velMat = mat(VEL_FRAG);
    this.posMat = mat(POS_FRAG);
    this.simScene = new THREE.Scene();
    this.simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.velMat);
    this.quad.frustumCulled = false;
    this.simScene.add(this.quad);

    // Everything starts dead (age 1 >= life 0) and is born on the first frames.
    const init = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) init[i * 4 + 2] = 1;
    const initTex = new THREE.DataTexture(init, size, size, THREE.RGBAFormat, THREE.FloatType);
    initTex.needsUpdate = true;
    const copy = new THREE.ShaderMaterial({
      uniforms: { src: { value: initTex } }, vertexShader: SIM_VERT,
      fragmentShader: 'uniform sampler2D src; varying vec2 vUv; void main(){ gl_FragColor = texture2D(src, vUv); }',
    });
    this.quad.material = copy;
    for (const t of [...this.pos, ...this.vel]) { renderer.setRenderTarget(t); renderer.render(this.simScene, this.simCam); }
    renderer.setRenderTarget(null);
    copy.dispose(); initTex.dispose();

    // Draw: one stretched quad per particle.
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ref = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      ref[i * 2] = ((i % size) + 0.5) / size;
      ref[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
    }
    geo.setAttribute('ref', new THREE.InstancedBufferAttribute(ref, 2));
    geo.instanceCount = this.count;
    this.drawUniforms = {
      tPos: { value: null }, tVel: { value: null }, uAspect: this.uniforms.uAspect,
      uPx: { value: 2 / 1080 }, uSize: { value: 2.2 }, uStreak: { value: 0.03 }, uGain: { value: 1 }, uBodyScale: this.uniforms.uScale, uBodyGain: { value: new Float32Array(MAXB) },
    };
    this.points = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.drawUniforms, vertexShader: DRAW_VERT, fragmentShader: DRAW_FRAG,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    }));
    this.points.frustumCulled = false;
    this.setMode(0);
  }

  setMode(i) {
    const m = MODES[i];
    this.mode = i;
    const u = this.uniforms;
    u.uMode.value = i;
    u.uRelease.value = m.release; u.uReleaseSpeed.value = m.releaseSpeed;
    u.uK.value = m.K; u.uC.value = m.C;
    u.uFlowAmp.value = m.flowAmp; u.uFlowScale.value = m.flowScale; u.uFlowDrag.value = m.flowDrag;
    u.uWake.value = m.wake; u.uGravity.value = m.gravity;
    u.uLife.value.set(m.life[0], m.life[1]);
    u.uHitKick.value = m.hitKick; u.uHitRelease.value = m.hitRelease;
    u.uSpawn.value = m.spawn; u.uFreezeAge.value = m.freezeAge;
    this.modeGain = m.gain ?? 1;
  }

  resize(width, height, aspect) {
    this.uniforms.uAspect.value = aspect;
    this.drawUniforms.uPx.value = 2 / height;
    // Particle width scales with the screen so a TV looks like a laptop, only bigger.
    this.drawUniforms.uSize.value = Math.max(1.6, 2.3 * (height / 1080));
  }

  setBodies(bu) {
    this.uniforms.uJ.value.set(bu.joints);
    this.uniforms.uScale.value.set(bu.scale);
    this.uniforms.uAlpha.value.set(bu.alpha);
    this.uniforms.uVis.value.set(bu.vis);
    this.drawUniforms.uBodyGain.value.set(bu.gain);
    this.uniforms.uCount.value = bu.count;
    this.uniforms.uFloor.value = bu.floor;
  }

  // hits: [{x, y, dx, dy, strength, radius}] in world units, used for one step.
  setHits(hits) {
    const H = this.uniforms.uHit.value, D = this.uniforms.uHitDir.value;
    for (let i = 0; i < 4; i++) {
      const h = hits[i];
      if (h) { H[i].set(h.x, h.y, h.strength, h.radius); D[i].set(h.dx, h.dy, 0, 0); } else H[i].z = 0;
    }
  }

  step(dt, time) {
    const r = this.renderer;
    const u = this.uniforms;
    const next = 1 - this.cur;
    u.uDt.value = dt;
    u.uTime.value = time;
    u.tPos.value = this.pos[this.cur].texture;
    u.tVel.value = this.vel[this.cur].texture;
    this.quad.material = this.velMat;
    r.setRenderTarget(this.vel[next]);
    r.render(this.simScene, this.simCam);
    u.tVelNew.value = this.vel[next].texture;
    this.quad.material = this.posMat;
    r.setRenderTarget(this.pos[next]);
    r.render(this.simScene, this.simCam);
    r.setRenderTarget(null);
    this.cur = next;
    this.drawUniforms.tPos.value = this.pos[next].texture;
    this.drawUniforms.tVel.value = this.vel[next].texture;
  }
}
