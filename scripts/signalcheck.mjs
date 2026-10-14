// Samples the movement signal over a clip, including hit events from the BroadcastChannel.
import { chromium } from 'playwright';
const clip = process.argv[2] || 'tell';
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(`http://localhost:5190/?qa&ui=0&mute=1&video=/qa/clips/${clip}.mp4`);
await p.waitForFunction(() => window.bodyLight?.stats.detections > 10, null, { timeout: 60000 });
const out = await p.evaluate(async () => {
  const ch = new BroadcastChannel('body-signal');
  const frames = []; const hits = [];
  // A second channel object in the same page receives the app's broadcasts.
  ch.onmessage = (e) => { frames.push(e.data); hits.push(...e.data.hits); };
  await new Promise((r) => setTimeout(r, 6000));
  const pick = (k) => frames.map((f) => f[k]);
  const stat = (a) => ({ min: Math.min(...a).toFixed(2), max: Math.max(...a).toFixed(2), mean: (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) });
  return { n: frames.length, present: frames.filter((f) => f.present).length, energy: stat(pick('energy')), expansion: stat(pick('expansion')), stillness: stat(pick('stillness')), level: stat(pick('level')), hits: hits.length, hitLimbs: hits.map((h) => h.limb[0] + h.limb.slice(-4) + ':' + h.strength.toFixed(1)).join(' ') };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
