import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'public', 'release-assets');
const framesDir = join(outDir, 'frames');
const outGif = join(outDir, 'launch-report-preview.gif');

mkdirSync(framesDir, { recursive: true });

const demoUrl = 'file://' + join(root, 'public', 'release-assets', 'preview-demo.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(demoUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// Frame 1: collapsed state (preview toggle visible but not expanded)
await page.screenshot({ path: join(framesDir, 'f01.png') });
console.log('F1: collapsed');

// Frame 2: click toggle to expand
await page.click('#toggleBtn');
await page.waitForTimeout(800);
await page.screenshot({ path: join(framesDir, 'f02.png') });
console.log('F2: expanded');

// Frame 3: scroll to show report content
await page.evaluate(() => {
  document.getElementById('reportIframe')?.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(framesDir, 'f03.png') });
console.log('F3: scrolled to content');

// Frame 4: hover copy button
await page.hover('#copyAddrsBtn');
await page.waitForTimeout(200);
await page.screenshot({ path: join(framesDir, 'f04.png') });
console.log('F4: copy hover');

// Frame 5: "copied" state
await page.evaluate(() => {
  const btn = document.getElementById('copyAddrsBtn');
  if (btn) { btn.classList.add('copied'); btn.innerHTML = '✓ Copied 7 addresses'; }
});
await page.waitForTimeout(300);
await page.screenshot({ path: join(framesDir, 'f05.png') });
console.log('F5: copied feedback');

// Frame 6: collapse back
await page.click('#toggleBtn');
await page.waitForTimeout(600);
await page.screenshot({ path: join(framesDir, 'f06.png') });
console.log('F6: collapsed again');

await browser.close();

// Build GIF
console.log('Building GIF...');
execSync(
  `ffmpeg -y -framerate 1.0 -i "${join(framesDir, 'f%02d.png')}" ` +
  `-vf "fps=4,scale=1100:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" ` +
  `-loop 0 "${outGif}"`,
  { stdio: 'inherit' }
);
console.log('GIF saved: ' + outGif);
