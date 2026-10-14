import { chromium } from 'playwright';
const [clip = 'cavalier', q = ''] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(`http://localhost:5190/?qa&ui=0&mute=1&video=/qa/clips/${clip}.mp4&${q}`);
await p.waitForFunction(() => window.bodyLight?.stats.detections > 5, null, { timeout: 60000 });
for (let i = 0; i < 24; i++) {
  console.log(await p.evaluate(() => {
    const { tracker, video, bodyU, field } = window.bodyLight;
    const s = tracker.slots[0];
    const vis = Array.from(bodyU.vis.slice(0, 18)).map(v => v.toFixed(1)).join(' ');
    return `${video.currentTime.toFixed(2)} a=${bodyU.alpha[0].toFixed(2)} n=${bodyU.count} S=${bodyU.scale[0].toFixed(2)} floor=${bodyU.floor.toFixed(2)} area=${bodyU.area[0].toFixed(3)} gain=${bodyU.gain[0].toFixed(2)} hipY=${bodyU.joints[10*4+1].toFixed(2)} vis=[${vis}]`;
  }));
  await p.waitForTimeout(250);
}
await b.close();
