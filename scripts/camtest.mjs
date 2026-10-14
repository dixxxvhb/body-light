// Start screen + camera path with Chrome's fake camera (no body in frame).
import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = []; p.on('console', m => logs.push(`[${m.type()}] ${m.text()}`)); p.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await p.goto(process.argv[2] || 'http://localhost:5190/');
await p.waitForTimeout(1500);
await p.screenshot({ path: 'qa/out/start.png' });
await p.click('#btn-cam');
await p.waitForFunction(() => document.getElementById('start').classList.contains('gone'), null, { timeout: 30000 });
await p.waitForTimeout(6000);
await p.mouse.move(500, 500);
await p.waitForTimeout(300);
await p.screenshot({ path: 'qa/out/cam-empty.png' });
console.log(await p.evaluate(() => JSON.stringify({ det: bodyLight.stats.detections, fps: bodyLight.stats.fps.toFixed(1), worst: bodyLight.stats.worstMs, w: bodyLight.video.videoWidth, h: bodyLight.video.videoHeight })));
for (const k of ['2','3','4','1']) { await p.keyboard.press(k); await p.waitForTimeout(200); }
console.log(await p.evaluate(() => document.getElementById('mode-name').textContent));
await p.keyboard.press('h'); await p.waitForTimeout(900);
console.log('hidden', await p.evaluate(() => getComputedStyle(document.getElementById('bar')).opacity));
console.log(logs.filter(l => !/gl_context|vite/.test(l)).join('\n'));
await b.close();
