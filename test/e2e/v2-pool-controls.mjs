#!/usr/bin/env node
// Per-pool advanced controls check.
//
// Boots its own isolated local server (temp config folder, free port, demo
// mode), adds a pair pool in the v2 launch view, opens its settings panel and
// checks each control: the fee tier slider (value, keyboard, tab order,
// readout), the numeric fields (inline message, value on leaving the field),
// Position slices (plain-words summary, Round button) and the Custom ladder
// (skipped lines, Ladder bands switched off). Set POOL_CONTROLS_SHOTS=<dir>
// to save screenshots.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-pool-controls-'));
const shots = process.env.POOL_CONTROLS_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port: free } = socket.address();
    socket.close(() => resolve(free));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
  demoMode: true,
  playIntroVideo: false,
  playSoundEffects: false,
  playBackgroundMusic: false,
  coinPreview: false,
}, null, 2));

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TREBUCHET_CONFIG_DIR: configDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
let serverExited = null;
const collect = (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-20_000); };
server.stdout.on('data', collect);
server.stderr.on('data', collect);
server.on('exit', (code, signal) => { serverExited = { code, signal }; });

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error(`server exited early\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok && (await response.json())?.token) return;
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start\n${serverOutput}`);
}

async function stopServer() {
  if (serverExited) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!serverExited) server.kill('SIGKILL');
}

let browser = null;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => document.body.dataset.apiStatus === 'connected', null, { timeout: 30_000 });
  await page.evaluate(() => {
    setView('launch');
    state.phaseSlide = { ...(state.phaseSlide || {}), liquidity: 'pairs' };
    setLaunchWorkspace('liquidity');
    addCustomPool({ symbol: 'SEIGE', mint: 'HipYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyb5r' });
    state.supplyOpenRow = `custom:${state.customPools.at(-1).id}`;
    renderSupplyEditor();
  });
  const panel = page.locator('.supply-settings').first();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  // The settings open as an accordion; wait until the panel has finished opening.
  await page.waitForFunction(() => { const wrap = document.querySelector('.supply-settings-wrap.is-open'); return wrap && wrap.getBoundingClientRect().height > 100 && document.querySelectorAll('.supply-settings-wrap:not(.is-open)').length === 0; });
  const shot = async (name) => { if (shots) await panel.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const field = (suffix) => page.locator(`.supply-settings [data-supply-key$="${suffix}"]`).first();
  const note = (name) => page.locator(`.supply-settings [data-feedback="${name}"]`).first();
  const plan = () => page.evaluate(() => {
    const pool = state.customPools.at(-1);
    const model = currentClassicModel().pools.find((item) => item.id === pool.id);
    return { pool, model };
  });
  const leave = async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(150);
  };

  // Fee tier slider: the highlighted label, thumb, readout and the value sent
  // in the plan all agree; arrow keys work; labels are not extra tab stops.
  const range = panel.locator('input[type="range"]');
  const readout = panel.locator('.choice-readout');
  const readState = () => page.evaluate(() => {
    const select = document.querySelector('.supply-settings select[data-choice="slider"]');
    const ticks = [...document.querySelectorAll('.supply-settings .choice-ticks button')];
    const selected = ticks.filter((button) => button.classList.contains('is-selected'));
    const pool = state.customPools.at(-1);
    const model = currentClassicModel().pools.find((item) => item.id === pool.id);
    return {
      selectIndex: select.selectedIndex,
      range: Number(document.querySelector('.supply-settings input[type="range"]').value),
      selectedTicks: selected.map((button) => Number(button.dataset.choiceIndex)),
      optionValue: Number(select.value),
      planned: model.ammConfigIndex,
      valueText: document.querySelector('.supply-settings input[type="range"]').getAttribute('aria-valuetext'),
    };
  });
  const agree = (info, label) => {
    assert.equal(info.range, info.selectIndex, `${label}: thumb matches the select`);
    assert.deepEqual(info.selectedTicks, [info.selectIndex], `${label}: one highlighted label, the thumb's`);
    assert.equal(info.planned, info.optionValue, `${label}: the plan gets the selected tier`);
  };
  agree(await readState(), 'initial');
  assert.match(await readout.textContent(), /\d+(\.\d+)?% \/ spacing \d+/, 'readout names the tier');
  assert.equal(await range.getAttribute('aria-label'), 'Fee tier');
  await shot('01-slider');
  await range.focus();
  await page.keyboard.press('Home');
  let info = await readState();
  agree(info, 'Home');
  assert.equal(info.range, 0);
  assert.match(await readout.textContent(), /^0\.01% \/ spacing 1/);
  await page.keyboard.press('ArrowRight');
  info = await readState();
  agree(info, 'ArrowRight');
  assert.equal(info.range, 1);
  assert.equal(await readout.textContent(), info.valueText, 'readout equals the spoken value');
  await page.keyboard.press('End');
  info = await readState();
  agree(info, 'End');
  assert.equal(info.planned, 19);
  assert.equal(await page.evaluate(() => document.activeElement.type), 'range', 'focus stays on the slider');
  await page.locator('.supply-settings .choice-ticks button[data-choice-index="5"]').click();
  info = await readState();
  agree(info, 'label click');
  assert.equal(info.range, 5);
  const tabStops = await page.evaluate(() => (
    [...document.querySelectorAll('.supply-settings .choice-ticks button')].filter((button) => button.tabIndex >= 0).length
  ));
  assert.equal(tabStops, 0, 'tier labels are not tab stops');
  assert.equal(await page.evaluate(() => document.querySelector('.supply-settings .choice-ticks').getAttribute('aria-hidden')), 'true');

  // Numeric fields: a message while typing, the value the plan uses when the
  // field is left.
  await field(':premium').fill('99999');
  assert.match(await note('premium').textContent(), /most allowed is 500/i);
  assert.equal(await field(':premium').getAttribute('aria-invalid'), 'true');
  await shot('02-premium-too-big');
  await leave();
  assert.equal(await field(':premium').inputValue(), '500', 'field shows the clamped value');
  assert.equal((await plan()).model.startPricePremiumPct, 500);
  assert.equal(await note('premium').textContent(), '', 'message clears once the value is valid');

  await field(':premium').fill('abc');
  assert.match(await note('premium').textContent(), /not a number/i);
  await leave();
  assert.equal(await field(':premium').inputValue(), '25');
  assert.equal((await plan()).model.startPricePremiumPct, 25);

  await field(':premium').fill('');
  assert.match(await note('premium').textContent(), /enter a number/i);
  await leave();
  assert.equal(await field(':premium').inputValue(), '25', 'blank premium returns to the default, not silent 0');

  await field(':premium').fill('-5');
  await leave();
  assert.equal(await field(':premium').inputValue(), '0');
  await field(':premium').fill('12.5');
  assert.equal(await note('premium').textContent(), '');
  await leave();
  assert.equal(await field(':premium').inputValue(), '12.5', 'valid decimals are kept');

  await field(':ladder').fill('99');
  assert.match(await note('ladder').textContent(), /most allowed is 20/i);
  await leave();
  assert.equal(await field(':ladder').inputValue(), '20');
  assert.equal((await plan()).model.ladder.bandCount, 20);
  await field(':ladder').fill('2.7');
  assert.match(await note('ladder').textContent(), /whole numbers/i);
  await leave();
  assert.equal(await field(':ladder').inputValue(), '2');
  await field(':ladder').fill('');
  await leave();
  assert.equal(await field(':ladder').inputValue(), '0', 'blank ladder bands is 0');
  assert.equal((await plan()).model.ladder.mode, 'off');

  await field(':support').fill('-1');
  assert.match(await note('support').textContent(), /cannot be below 0/i);
  await leave();
  assert.equal(await field(':support').inputValue(), '0');
  await field(':support').fill('abc');
  assert.match(await note('support').textContent(), /not a number/i);
  await leave();
  assert.equal(await field(':support').inputValue(), '0');
  await field(':support').fill('0.5');
  assert.equal(await note('support').textContent(), '');
  await leave();
  assert.equal((await plan()).model.support.solValue, 0.5);
  await field(':support').fill('0');
  await leave();

  // Position slices: plain words, and the Round button.
  assert.match(await note('slices').textContent(), /^1 position, all of this pool/);
  await field(':slices').fill('50,50');
  assert.match(await note('slices').textContent(), /2 positions: 50% \+ 50%\./);
  assert.doesNotMatch(await note('slices').textContent(), /scaled/);
  await field(':slices').fill('30,30');
  assert.match(await note('slices').textContent(), /total 60, so they are scaled to 100%/);
  assert.equal(await note('slices').evaluate((el) => el.classList.contains('is-warn')), true);
  await field(':slices').fill('1');
  assert.match(await note('slices').textContent(), /total 1, so they are scaled/);
  await field(':slices').fill('50,abc');
  assert.match(await note('slices').textContent(), /Ignored: abc/);
  assert.equal(await field(':slices').getAttribute('aria-invalid'), 'true');
  await field(':slices').fill('33.3,33.3,33.3');
  assert.match(await note('slices').textContent(), /3 positions: 33\.33% \+ 33\.33% \+ 33\.34%\./);
  await shot('03-slices-three');
  await leave();
  await page.locator('.supply-settings [data-action="round-slices-100"]').click();
  await page.waitForTimeout(200);
  assert.equal(await field(':slices').inputValue(), '33.33,33.33,33.34');
  assert.match(await page.locator('#toastStack .toast').last().textContent(), /rounded to 100%/);
  await field(':slices').fill('30,30');
  await leave();
  await page.locator('.supply-settings [data-action="round-slices-100"]').click();
  await page.waitForTimeout(200);
  assert.equal(await field(':slices').inputValue(), '50,50');
  assert.deepEqual((await plan()).model.distribution.map((slice) => slice.sharePercent), [50, 50]);
  await page.locator('.supply-settings [data-action="round-slices-100"]').click();
  await page.waitForTimeout(200);
  assert.match(await page.locator('#toastStack .toast').last().textContent(), /already add up to 100%/);

  // Custom ladder: skipped lines are named, and a usable ladder switches
  // Ladder bands off.
  await field(':ladder').fill('3');
  await leave();
  assert.equal(await field(':ladder').isDisabled(), false);
  await field(':manual').fill('10, 1.5, 3\nnot a band');
  assert.match(await note('manual').textContent(), /1 band used, 10% of supply/);
  assert.match(await note('manual').textContent(), /Skipped line 2 "not a band"/);
  assert.equal(await field(':manual').getAttribute('aria-invalid'), 'true');
  assert.equal(await field(':ladder').isDisabled(), true, 'Ladder bands is off while the custom ladder has bands');
  assert.match(await note('ladder').textContent(), /Custom ladder below replaces it/);
  assert.equal((await plan()).model.ladder.mode, 'manual');
  await shot('04-custom-ladder');
  await field(':manual').fill('garbage');
  assert.equal(await field(':ladder').isDisabled(), false, 'no usable band: Ladder bands is used again');
  assert.equal((await plan()).model.ladder.bandCount, 3);
  await field(':manual').fill('');
  assert.equal(await note('manual').textContent(), '');

  // Names: every control is named by its label (helper text was removed).
  const names = await page.evaluate(() => [...document.querySelectorAll('.supply-settings input[type="text"], .supply-settings input:not([type]), .supply-settings textarea')].map((control) => {
    const label = document.getElementById(control.getAttribute('aria-labelledby'));
    const described = (control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent || '');
    return { name: label?.textContent, described: described.join(' ') };
  }));
  assert.ok(names.length >= 5);
  names.forEach((item) => {
    assert.ok(item.name, 'every field has a name');
  });

  // Narrow screen: no sideways scroll, and the tier labels stay inside.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => {
    const body = document.documentElement;
    const settings = document.querySelector('.supply-settings').getBoundingClientRect();
    const ticks = [...document.querySelectorAll('.supply-settings .choice-ticks button')].map((button) => button.getBoundingClientRect()).filter((box) => box.width > 0);
    return {
      page: body.scrollWidth - body.clientWidth,
      ticksOutside: ticks.filter((box) => box.right > settings.right + 1 || box.left < settings.left - 1).length,
    };
  });
  assert.ok(overflow.page <= 1, 'no sideways page scroll at 390px');
  assert.equal(overflow.ticksOutside, 0, 'tier labels stay inside the panel');
  await shot('05-narrow');

  // The screen and the server's readiness check must agree on whether an estimate is current, for
  // every preset (layered support once made each preset launch read as "estimate stale").
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('.coin-fact[data-coin-fact="liquidity"]');
  await page.click('[data-plan-tab="run"]');
  for (const preset of ['spark', 'anchor', 'constellation', 'vortex']) {
    await page.click(`[data-preset="${preset}"]`);
    await page.waitForTimeout(300);
    const agree = await page.evaluate(() => classicFundingEstimateFingerprint(currentLaunchConfig()) === TrebuchetCore.v2FundingEstimateFingerprint(currentLaunchConfig()));
    assert.ok(agree, `${preset}: the screen's estimate fingerprint matches the server's`);
  }

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('v2 pool controls: ok');
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
