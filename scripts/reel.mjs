// Records a short showreel off the canvas: each mode on a different clip.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const plan = [['cavalier', 0], ['tell', 1], ['shot', 2], ['tell', 3], ['cavalier', 0]];
const secs = Number(process.argv[2] || 8);
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(`http://localhost:5190/?qa&ui=0&mute=1&video=/qa/clips/${plan[0][0]}.mp4`);
await p.waitForFunction(() => window.bodyLight?.stats.detections > 20, null, { timeout: 60000 });
const b64 = await p.evaluate(async ({ plan, secs }) => {
  const { useVideo, setMode, stats } = window.bodyLight;
  const c = document.querySelector('canvas');
  const rec = new MediaRecorder(c.captureStream(60), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 30e6 });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  const worst = [];
  rec.start();
  for (const [clip, mode] of plan) {
    if (window.bodyLight.video.src.indexOf(clip) < 0) await useVideo(`/qa/clips/${clip}.mp4`, 'file', false);
    setMode(mode);
    for (let i = 0; i < secs; i++) { await new Promise((r) => setTimeout(r, 1000)); worst.push(stats.worstMs); }
  }
  rec.stop(); await new Promise((r) => (rec.onstop = r));
  console.log('worst per second: ' + worst.map((w) => w.toFixed(0)).join(' '));
  const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}, { plan, secs });
p.on('console', (m) => console.log(m.text()));
writeFileSync('qa/out/reel.webm', Buffer.from(b64, 'base64'));
await b.close();
