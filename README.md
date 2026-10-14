# Body Light

A full-screen browser piece: the webcam tracks your whole body and a quarter
million particles of light flow off you as you move. You dance, it paints.

Live: https://dixxxvhb.github.io/body-light/

## Use it

Open the page, press **Camera** (or drop a video file anywhere, or press **Video file**).
Stand back far enough that the camera sees you head to toe.

| Key | Does |
|---|---|
| 1 | Flow: light sheds off you into a slow current and drifts where you were |
| 2 | Gravity: shed light falls and pools on the floor under you |
| 3 | Burst: the body holds its light until a sharp hit throws it outward |
| 4 | Freeze: shed light stops where it was left, a sculpture of the last few seconds |
| F | Fullscreen |
| H | Hide all UI |
| C / V | Camera / open a video file |
| B | Faint video behind the light (handy to check tracking) |
| M | Mute a video file |
| Space | Pause a video file |
| D | Debug readout: fps, tracking time, movement signal |

Up to three people are tracked at once. Works in Chrome or Edge on a machine
with a real GPU; it holds 60 fps on an RTX 4060.

URL options: `?video=<url>` autoloads a clip, `&mode=2` starts in a mode,
`&n=1024` runs a million particles, `&model=lite` uses the lighter pose model,
`&ui=0` starts hidden, `&backdrop=1` shows the video.

## How it works

- **Tracking:** MediaPipe tasks-vision `PoseLandmarker` (the tasks API; the
  legacy Pose solution is dead), GPU delegate, running in a Web Worker so
  tracking never costs a render frame (`src/pose-worker.js`). Up to three
  bodies, One Euro smoothing, stable slots matched by hip position, duplicate
  detections of one person merged, and a new body has to hold for a few
  frames before it lights up (`src/pose.js`). `?worker=0` runs it on the main thread.
- **Light:** a GPGPU particle system in Three.js (`src/particles.js`). Every
  particle is born bound to a point on the body (a spot on a limb capsule, the
  torso or the head) and rides it on a damped spring, so the light has mass
  and lags with inertia. Its bond decays faster when its limb gestures fast;
  once free it joins a curl-noise flow field, gets dragged by limbs passing
  through it, and fades. Parts the tracker cannot see are not lit, and an
  anchor that jumps (a glitch, a video cut) lets its light go instead of
  dragging it across the screen. About 30% of the particles are core light
  that stays on the body in every mode, so the figure always reads; the rest
  are shed light that follows the mode.
- **Look:** additive velocity-stretched sprites into a half-float buffer,
  bloom, ACES tone mapping. One palette, white-hot body to violet memory.
  Particles spread across each limb on a Gaussian (soft edges, no tubes), and
  exposure follows each body's on-screen size so someone close to the camera
  and someone far away read at the same brightness.

## Movement signal (for Body Band)

`src/signal.js` has no dependencies and can be copied into another project.

```js
import { MovementSignal } from './signal.js';
const sig = new MovementSignal();
sig.on('hit', (h) => playAccent(h.limb, h.strength));
const frame = sig.update(landmarks, performance.now()); // landmarks = MediaPipe's 33 points, or null
```

While Body Light runs it also broadcasts every frame on a `BroadcastChannel`
named `body-signal`, so another tab on the same origin can listen:

```js
new BroadcastChannel('body-signal').onmessage = (e) => console.log(e.data);
```

| Field | Range | Meaning |
|---|---|---|
| `present` | bool | someone is in frame |
| `energy` | 0..1 | overall movement, fast attack, slow release |
| `expansion` | 0..1 | 0 folded in, 1 limbs fully out |
| `stillness` | 0..1 | 1 = not moving; `stillFor` = seconds held |
| `level` | 0..1 | 1 standing tall, 0 crouched or on the floor |
| `center` | x, y, vx, vy | hip center, normalized image coords, per second |
| `limbs.<name>` | x, y, vx, vy, speed, speedNorm | head, leftHand, rightHand, leftFoot, rightFoot, core; speed in torso lengths per second, speedNorm 0..1 |
| `hits` | array | sharp stops this frame: `{ limb, strength 0..1, x, y, dx, dy, t }` |

Speeds are measured in torso lengths, so the numbers do not change with
distance from the camera. Left and right are the dancer's own.

## Develop

```
npm install
npm run dev          # http://localhost:5190
npm run qa -- --clip shot --mode 1 --record 6   # real Chrome, GPU, writes qa/out/
scripts/sheet.sh shot 1 mytag                   # record + contact sheet for worst-frame review
node scripts/reel.mjs 8                         # every mode, 8 s each, qa/out/reel.webm
node scripts/camtest.mjs                        # start screen + camera path on Chrome's fake camera
node scripts/signalcheck.mjs tell               # movement signal ranges and hit count
```

QA clips go in `qa/clips/` (gitignored, never committed).
