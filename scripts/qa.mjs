// QA in real Chrome (GPU on): loads a clip in video mode, measures frame
// timing, grabs a strip of frames across the clip (judge the worst one, not
// the best) and optionally records a webm straight off the canvas.
//
//   node scripts/qa.mjs --clip shot --mode 1 --frames 12 --record 8
//   (needs `npm run dev` running; clips live in qa/clips, never committed)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const clip = arg('clip', 'shot');
const mode = arg('mode', '1');
const frames = Number(arg('frames', 12));
const record = Number(arg('record', 0));
const width = Number(arg('w', 1920)), height = Number(arg('h', 1080));
const extra = arg('q', '');
const headless = arg('headless', '1') === '1';
const tag = arg('tag', `${clip}-m${mode}`);
const url = `http://localhost:5190/?qa&ui=0&mute=1&debug&mode=${mode}&video=/qa/clips/${clip}.mp4${extra ? '&' + extra : ''}`;
const out = 'qa/out';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`],
});
const page = await browser.newPage({ viewport: { width, height } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
await page.waitForFunction(() => window.bodyLight?.stats.detections > 20, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

const dur = await page.evaluate(() => window.bodyLight.video?.duration || 6);
let recPromise = null;
if (record) {
  recPromise = page.evaluate(async (secs) => {
    const c = document.querySelector('canvas');
    const rec = new MediaRecorder(c.captureStream(60), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 24e6 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, secs * 1000));
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const buf = await new Blob(chunks).arrayBuffer();
    let s = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, record);
}

const samples = [];
const gap = Math.max(150, (dur * 1000) / frames);
for (let i = 0; i < frames; i++) {
  const path = `${out}/${tag}-${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path });
  const s = await page.evaluate(() => {
    const { stats, signal } = window.bodyLight;
    return { fps: +stats.fps.toFixed(1), worstMs: +stats.worstMs.toFixed(1), detectMs: +stats.detectMs.toFixed(1), energy: +signal.last.energy.toFixed(2), hits: signal.last.hits.length, t: +window.bodyLight.video.currentTime.toFixed(2) };
  });
  samples.push({ path, ...s });
  await page.waitForTimeout(gap);
}
if (recPromise) {
  const b64 = await recPromise;
  writeFileSync(`${out}/${tag}.webm`, Buffer.from(b64, 'base64'));
}
console.log(JSON.stringify({ url, gpu, dur, samples, logs: logs.slice(0, 30) }, null, 1));
await browser.close();
