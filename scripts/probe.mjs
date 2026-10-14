import { chromium } from 'playwright';
const clip = process.argv[2] || 'cavalier';
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(`http://localhost:5190/?qa&ui=0&mute=1&video=/qa/clips/${clip}.mp4&${process.argv[3]||''}`);
await p.waitForFunction(() => window.bodyLight?.stats.detections > 5, null, { timeout: 60000 });
const rows = [];
for (let i = 0; i < 40; i++) {
  rows.push(await p.evaluate(() => { const { tracker, video, stats } = window.bodyLight; return [video.currentTime.toFixed(2), stats.detections, 'raw'+tracker.rawCount, 'pair'+(tracker.lastPair||0).toFixed(2), tracker.slots.map(s => s.active ? 'A' : (s.alpha > 0 ? 'f' : '.')).join(''), tracker.slots.map(s=>s.alpha.toFixed(1)+'@'+s.center().x.toFixed(2)+','+s.center().y.toFixed(2)+' v'+((s.lm[11].visibility+s.lm[12].visibility+s.lm[23].visibility+s.lm[24].visibility)/4).toFixed(2)).join(' | ')].join('  '); }));
  await p.waitForTimeout(200);
}
console.log(rows.join('\n'));
await b.close();
