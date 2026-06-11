// ===========================================================================
// capture-screenshots.mjs — README screenshot generation
// ===========================================================================
//
// Replaces the old capture-preview-gif.mjs approach (which screenshotted a
// hand-built static mock page, so it never actually demonstrated the app).
// This script drives the REAL application through a complete launch in demo
// mode — the same walkthrough a user sees, minus real transactions — and
// captures a curated set of PNGs into docs/screenshots/ for the README.
//
// How it works:
//   1. Boots server.js standalone under plain Node (no Electron — the
//      server only needs PORT and TREBUCHET_CONFIG_DIR, both env vars).
//      A fresh temp config dir is seeded with demoMode: true and the
//      intro/audio prefs off, so every run starts from an identical
//      first-launch state. Deterministic input → stable screenshots.
//   2. Playwright (chromium, headless) walks the launch flow end to end:
//      generate wallet → configure token (with logo) → demo funding →
//      create token → create pools → report preview → transfer → success
//      modal. Each step is captured as a tight element screenshot of its
//      step card, which reads far better in a README than full-window
//      shots.
//   3. Output filenames are STABLE — regenerating overwrites in place, so
//      the README never needs rewriting and git diffs show exactly which
//      screens changed.
//
// Usage:
//   npm run shots             (or: node scripts/capture-screenshots.mjs)
//
// Requirements: playwright installed (npm i -D playwright) and a chromium
// browser (npx playwright install --with-deps chromium). ffmpeg is NOT
// needed — this produces PNGs, not GIFs.
// ===========================================================================

import { spawn, execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import net from 'net';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'docs', 'screenshots');

// Pick a free ephemeral port (same trick test/e2e/ui-flows.mjs uses) so a
// running dev instance — or anything else — can never collide with the
// capture server. SHOTS_PORT still overrides for debugging.
const PORT = process.env.SHOTS_PORT || await new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;

// Demo-mode pacing: at the default DEMO_TIME_SCALE of 1.0 the demo sleeps
// like a REAL launch — a two-pool run's create/open/lock pacing totals
// several minutes, which is the point in the app and a waste in a capture.
// The demo service has a purpose-built knob for exactly this ("0.3 = fast
// capture sessions that still show progress"), so the spawned server gets
// it below. Timeouts stay generous on top of that; a hung step still
// fails the run.
const DEMO_TIME_SCALE = process.env.DEMO_TIME_SCALE || '0.3';
const STEP_TIMEOUT = 30_000;
const LP_TIMEOUT = 300_000;
const TRANSFER_TIMEOUT = 180_000;

mkdirSync(outDir, { recursive: true });

// Milestone frames for the happy-path GIF. Full-viewport shots (uniform
// dimensions — ffmpeg needs every frame the same size, so these are
// separate from the tightly-cropped per-card PNGs above). Stitched at the
// end into docs/screenshots/launch-flow.gif; skipped gracefully when
// ffmpeg isn't installed.
const framesDir = mkdtempSync(join(tmpdir(), 'treb-gif-frames-'));
let _frameNo = 0;

// ---- 1. Boot the server standalone ----------------------------------------
// Fresh config dir per run: demo mode on, intro video and audio off (the
// splash would cover the first screenshot; audio is pointless headless).
const cfgDir = mkdtempSync(join(tmpdir(), 'treb-shots-'));
writeFileSync(join(cfgDir, 'userPrefs.json'), JSON.stringify({
  demoMode: true,
  playIntroVideo: false,
  playSoundEffects: false,
  playBackgroundMusic: false,
}, null, 2));

console.log(`Booting server on :${PORT} (config: ${cfgDir})`);
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    TREBUCHET_CONFIG_DIR: cfgDir,
    // Fast-capture pacing (see the constant above). Override by setting
    // DEMO_TIME_SCALE yourself — e.g. 1.0 to time a realistic run.
    DEMO_TIME_SCALE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Keep the server's output. SHOTS_VERBOSE streams it live; otherwise it's
// buffered and printed only when startup fails — a silent timeout with the
// actual crash hidden is undebuggable (ask me how I know).
let serverOutput = '';
let serverExited = null;
const onServerData = (d) => {
  serverOutput += d.toString();
  if (serverOutput.length > 20_000) serverOutput = serverOutput.slice(-20_000);
  if (process.env.SHOTS_VERBOSE) process.stdout.write(`[server] ${d}`);
};
server.stdout.on('data', onServerData);
server.stderr.on('data', onServerData);
server.on('exit', (code, signal) => {
  serverExited = { code, signal };
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Fail fast if the child already died (port conflict, missing module,
    // syntax error) — no point waiting out the timeout.
    if (serverExited) {
      throw new Error(
        `server exited during startup (code ${serverExited.code}, signal ${serverExited.signal}).\n`
        + `--- server output ---\n${serverOutput}\n---------------------`,
      );
    }
    try {
      // Liveness probe, not an API call: /api/* requires the
      // x-trebuchet-session token (apiSessionMiddleware) and 403s a bare
      // fetch, which is NOT "server down". Any HTTP response at all —
      // including a 403 — means the server is listening; the browser
      // bootstraps its own session like the real frontend always does.
      await fetch(`${BASE}/`);
      return;
    } catch (_) { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(
    'server did not come up within 60s.\n'
    + `--- server output ---\n${serverOutput || '(no output)'}\n---------------------`,
  );
}

function cleanup() {
  try { server.kill(); } catch (_) {}
  try { rmSync(cfgDir, { recursive: true, force: true }); } catch (_) {}
  try { rmSync(framesDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---- 2. Walk the demo launch ----------------------------------------------
let failed = false;
try {
  await waitForServer();
  console.log('Server up. Launching browser…');

  const browser = await chromium.launch({
    // SwiftShader keeps the 3D coin rendering in headless CI. If WebGL
    // still isn't available the app degrades to its flat-logo fallback on
    // its own — the capture keeps working either way.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  // deviceScaleFactor 2 → retina-crisp PNGs at README display sizes.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
  });

  // Element screenshot of one step card, with stable naming. Scrolls the
  // card into view first so lazy layout (the travelling preview card)
  // settles before capture.
  // Fixed-position chrome (activity log, sticky cost bar, demo banner)
  // gets composited INTO element screenshots of cards taller than the
  // viewport — a black bar baked across the middle of the image. Hide
  // it during element captures only; gif frames keep the real chrome.
  await page.addStyleTag({ content: `
    body.shots-clean #activityLogContainer,
    body.shots-clean #stickyBar,
    body.shots-clean #demoBanner { display: none !important; }
  ` });
  const setClean = (on) => page.evaluate((v) => document.body.classList.toggle('shots-clean', v), on);

  // Element capture without locator stability waits AND without
  // fullPage. Both bit us on CI:
  //   - locator.screenshot() waits for a stable bounding box, which
  //     never happens while the live cost estimate re-renders the
  //     config body on a slow runner;
  //   - fullPage screenshots use Chromium's captureBeyondViewport,
  //     which is flaky under SwiftShader with a continuously-animating
  //     WebGL canvas (the coin) on the page — viewport-sized shots kept
  //     working in the same runs that hung every fullPage capture, and
  //     a wedged capture poisons coordinate-based clicks afterwards.
  // So: temporarily grow the viewport to fit the element, scroll it to
  // the top, take a PLAIN viewport screenshot clipped to its rect, and
  // restore the standard viewport before any further interaction.
  const STD_VIEWPORT = { width: 1440, height: 1000 };
  async function shootClipped(selector, name) {
    const measure = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }, selector);
    if (!measure) throw new Error(`shootClipped: ${selector} not found`);
    // Cap the viewport: at deviceScaleFactor 2 a 6000px-tall buffer is
    // already ~140MB of pixels; anything taller than the cap gets its
    // top 6000px, which no app card exceeds in practice.
    const vpHeight = Math.min(Math.max(Math.ceil(measure.height) + 40, STD_VIEWPORT.height), 6000);
    try {
      await page.setViewportSize({ width: STD_VIEWPORT.width, height: vpHeight });
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'start' });
        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          width: Math.max(1, Math.min(r.width, window.innerWidth - Math.max(0, r.left))),
          height: Math.max(1, Math.min(r.height, window.innerHeight - Math.max(0, r.top))),
        };
      }, selector);
      if (!box) throw new Error(`shootClipped: ${selector} vanished during capture`);
      await page.waitForTimeout(600); // let scroll/coin/relayout settle (best effort)
      await setClean(true);
      await page.screenshot({ path: join(outDir, name), clip: box, timeout: 20_000 });
      await setClean(false);
      console.log(`captured ${name}`);
    } finally {
      await setClean(false);
      await page.setViewportSize(STD_VIEWPORT);
      await page.waitForTimeout(300);
    }
  }

  async function shootCard(stepNum, name) {
    await shootClipped(`#step${stepNum}-card`, name);
  }

  // Element screenshot of an arbitrary selector — used for focused panel
  // captures (a <details> section, a modal card) where the whole step
  // card would bury the feature being shown.
  const shootEl = shootClipped;

  // One GIF milestone frame (full viewport, uniform size).
  async function gifFrame(label) {
    _frameNo += 1;
    const n = String(_frameNo).padStart(2, '0');
    await page.screenshot({ path: join(framesDir, `f${n}.png`) });
    console.log(`gif frame ${n}: ${label}`);
  }

  // A control is "actionable" when visible and not disabled. Bulma keeps
  // disabled buttons in the DOM, so waitFor visible alone isn't enough.
  async function waitEnabled(selector, timeout = STEP_TIMEOUT) {
    await page.waitForSelector(`${selector}:not([disabled])`, { state: 'visible', timeout });
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // The demo banner confirms demo mode is live and the page finished
  // booting — the same readiness signal test/e2e/ui-flows.mjs keys on.
  // (The intro splash never appears: playIntroVideo:false in the seeded
  // prefs dismisses it before playback.)
  await page.waitForSelector('#demoBanner', { state: 'visible', timeout: 20_000 }).catch(() => {});

  // First-run disclaimer modal — agree and dismiss, same as the e2e
  // harness does. Fresh config dir means it always appears.
  try {
    await page.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 8_000 });
    await page.click('#disclaimerAgreeCheck');
    await page.click('#disclaimerAgreeBtn');
    await page.waitForTimeout(400);
  } catch (_) { /* not shown (pref persisted) — fine */ }

  // Canonical step-advance wait, borrowed from the e2e harness: the
  // orchestrator marks the active card with .is-active.
  const stepIs = (n) => page.waitForSelector(`#step${n}-card.is-active`, { timeout: STEP_TIMEOUT });

  // ---- Step 1: generate the launch wallet ----
  await waitEnabled('#generateWalletBtn');
  await page.waitForTimeout(400);
  await shootCard(1, '01-generate-wallet.png');
  await gifFrame('fresh start');
  await page.click('#generateWalletBtn');
  await stepIs(2);
  await page.waitForTimeout(800);
  await gifFrame('wallet generated');

  // ---- Step 2: configure the token ----
  await page.fill('#tokenName', 'Trebuchet Demo');
  await page.fill('#tokenSymbol', 'FLING');
  // Upload a logo so the 3D coin and the preview card look like a real
  // launch instead of letter fallbacks. The repo icon is always present.
  try {
    await page.setInputFiles('#tokenLogo', join(root, 'build', 'icon.png'));
  } catch (e) {
    console.warn('logo upload skipped:', e.message);
  }
  // Let the coin texture + cost estimate settle before the shot.
  await page.waitForTimeout(2500);
  await shootCard(2, '02-token-config.png');
  await gifFrame('token configured');

  // ---- Step 2 detours: capture every configuration surface ----
  // IMPORTANT nesting fact (learned the hard way): the airdrop section
  // AND the "Customize pools manually" button both live INSIDE
  // #simpleAdvancedDetails. The advanced panel must stay OPEN through
  // all three captures — closing it after its own shot hides the other
  // two and every subsequent capture times out on "element not visible".
  try {
    await page.evaluate(() => { const d = document.getElementById('simpleAdvancedDetails'); if (d) d.open = true; });
    await page.waitForTimeout(500);
    await shootEl('#simpleAdvancedDetails', '03-advanced-options.png');
  } catch (e) { console.warn('advanced-options capture skipped:', e.message); }

  // Airdrop section (nested in the advanced panel). It renders dimmed
  // with its toggle disabled until preallocation is enabled, so flip
  // prealloc + airdrop on for the capture — the live section with the
  // CSV editor active — then restore both. Each toggle re-renders the
  // simple body, hence the fresh getElementById per step.
  const setCheckedById = (id, checked) => page.evaluate(({ elId, want }) => {
    const el = document.getElementById(elId);
    if (el && el.checked !== want) el.click();
    return !!el;
  }, { elId: id, want: checked });
  try {
    await setCheckedById('simplePreallocToggle', true);
    await page.waitForTimeout(600);
    await setCheckedById('simpleAirdropToggle', true);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const adv = document.getElementById('simpleAdvancedDetails');
      if (adv) adv.open = true; // re-render may reset it
      const d = document.getElementById('simpleAirdropDetails');
      if (d) d.open = true;
    });
    await page.waitForTimeout(500);
    await shootEl('#simpleAirdropDetails', '04-airdrop-config.png');
  } catch (e) {
    console.warn('airdrop capture skipped:', e.message);
  } finally {
    // Restore defaults whether or not the capture succeeded (airdrop
    // off first — it depends on prealloc). State-checked: only clicks
    // when the toggle is actually on.
    await setCheckedById('simpleAirdropToggle', false);
    await page.waitForTimeout(400);
    await setCheckedById('simplePreallocToggle', false);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const adv = document.getElementById('simpleAdvancedDetails');
      if (adv) adv.open = true;
    });
  }

  // Customize mode: the manual pool editor. Enable the first pool's
  // ladder so the screenshot shows the band table, not just the toggle.
  try {
    await page.click('#simpleCustomizeBtn');
    await page.waitForSelector('#customizeConfigContainer:not(.hidden)', { timeout: STEP_TIMEOUT });
    await page.waitForTimeout(800);
    // Expand the editor's full depth in one DOM pass — no locator
    // actions (their stability waits are what timed out on CI):
    //   1. every pool's editor (cards render collapsed behind their
    //      "▸ configure" header; a folded row demonstrates nothing),
    //   2. the first pool's ladder toggle (reveals band controls),
    //   3. then, after the re-render settles: every <details>, the
    //      per-band positions table disclosure, and the custom
    //      support inputs. All defensive — a missing piece stays
    //      collapsed rather than failing the run.
    await page.evaluate(() => {
      document.querySelectorAll('#poolList .pool-row-header').forEach((h) => h.click());
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const ladder = document.querySelector('[data-ladder-toggle]');
      if (ladder && !ladder.checked) ladder.click();
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const root = document.getElementById('customizeConfigContainer');
      if (!root) return;
      root.querySelectorAll('details').forEach((d) => { d.open = true; });
      const disclosure = root.querySelector('[data-ladder-disclosure]');
      if (disclosure) disclosure.click();
      const support = root.querySelector('[data-support-toggle]');
      if (support && !support.checked) support.click();
    });
    await page.waitForTimeout(800);
    await shootEl('#customizeConfigContainer', '05-custom-pools.png');
  } catch (e) {
    console.warn('customize capture skipped:', e.message);
  } finally {
    // ALWAYS return to simple mode — a failed capture must cost one
    // image, not leave the editor in customize mode for the rest of
    // the run (which is how the CI run lost step 3). The discard-
    // confirmation may or may not appear depending on how far the
    // state diverged; accept it when it does.
    const inCustomize = await page.$eval('#customizeConfigContainer', (el) => !el.classList.contains('hidden')).catch(() => false);
    if (inCustomize) {
      await page.evaluate(() => document.getElementById('returnToSimpleBtn')?.click());
      try {
        await page.waitForSelector('#genericConfirmModal.is-active', { timeout: 5_000 });
        await page.evaluate(() => document.getElementById('genericConfirmOk')?.click());
      } catch (_) { /* nothing customized enough to warrant the confirm */ }
      await page.waitForSelector('#simpleConfigContainer:not(.hidden)', { timeout: STEP_TIMEOUT });
      await page.waitForTimeout(600);
    }
  }

  // Leave the advanced panel collapsed — the default state — so later
  // captures and gif frames show the step as a user first sees it.
  // (return-to-simple rebuilds the body, so re-resolve the element.)
  await page.evaluate(() => { const d = document.getElementById('simpleAdvancedDetails'); if (d) d.open = false; });
  await page.waitForTimeout(300);

  // The continue button gates on the cost estimate resolving (live price
  // APIs) — wait for the real enabled state so the funding screenshot
  // shows resolved numbers, with a long allowance for slow CI networks.
  await waitEnabled('#continueToFundingBtn', 60_000);
  await page.click('#continueToFundingBtn');
  await stepIs(3);

  // ---- Step 3: funding (demo inject + acquire) ----
  // Funding is TWO actions when the launch pairs against a non-SOL quote
  // (the default config always does — the flywheel pool): the demo inject
  // covers SOL and manual prefunds only, deliberately leaving auto-swap
  // quote tokens to the Acquire button so that flow stays demonstrable.
  // continueToTokenBtn requires ALL rows met, so the script must click
  // Acquire too — funding SOL alone leaves continue disabled forever
  // (which is exactly how the first version of this script got stuck).
  await waitEnabled('#demoFundBtn');
  // Give the funding panel a moment to compute its requirement rows — the
  // inject button posts the EXACT amounts the panel currently shows, so
  // clicking before they resolve injects an incomplete set.
  await page.waitForTimeout(3000);

  const isEnabled = (sel) => page.$eval(sel, (el) => {
    const style = window.getComputedStyle(el);
    const visible = style.display !== 'none' && el.offsetParent !== null;
    return visible && !el.disabled;
  }).catch(() => false);

  // Inject SOL (re-clicking is idempotent: the demo inject SETS balances
  // to the current requirement), then wait for whichever unlocks first —
  // continue (no auto-swaps configured) or the Acquire button (auto-swaps
  // pending). When Acquire unlocks, click it once and wait for the demo
  // swaps to land.
  let funded = false;
  let acquireClicked = false;
  outer: for (let attempt = 1; attempt <= 3 && !funded; attempt++) {
    await page.click('#demoFundBtn');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await isEnabled('#continueToTokenBtn')) { funded = true; break outer; }
      if (!acquireClicked && await isEnabled('#acquireQuoteTokensBtn')) {
        acquireClicked = true;
        console.log('SOL funded — acquiring quote tokens…');
        await page.click('#acquireQuoteTokensBtn');
        // Demo swaps simulate per-pool latency; wait generously, then
        // fall through to the outer funded check.
        funded = await page.waitForSelector('#continueToTokenBtn:not([disabled])', { state: 'visible', timeout: 90_000 })
          .then(() => true)
          .catch(() => false);
        if (funded) break outer;
      }
      await page.waitForTimeout(1000);
    }
    if (!funded) console.warn(`funding not confirmed after attempt ${attempt} — retrying inject`);
  }
  if (!funded) throw new Error('funding never confirmed — #continueToTokenBtn stayed disabled');
  await page.waitForTimeout(600);
  await shootCard(3, '06-funding.png');
  await gifFrame('funding arrived');
  await page.click('#continueToTokenBtn');
  await stepIs(4);

  // ---- Step 4: create the token ----
  await waitEnabled('#createTokenBtn');
  await page.click('#createTokenBtn');
  await waitEnabled('#continueToLpBtn', STEP_TIMEOUT);
  await page.waitForTimeout(600);
  await shootCard(4, '07-create-token.png');
  await gifFrame('token minted');
  await page.click('#continueToLpBtn');
  await stepIs(5);

  // ---- Step 5: create pools + positions ----
  await waitEnabled('#createLpBtn');
  await page.click('#createLpBtn');

  // Pre-flight price confirmation (Milestone C): Create Pools doesn't
  // launch anything — it probes live prices and opens a confirmation
  // modal the user must accept. Nothing on-chain (or in demo) happens
  // until #createLpConfirmProceedBtn is clicked, so without this the
  // capture waits forever on a completion that never starts. The modal
  // is also a safety feature worth a frame of its own.
  await page.waitForSelector('#createLpConfirmModal.is-active', { timeout: 60_000 });
  await page.waitForTimeout(800); // resolved-price rows render
  await shootEl('#createLpConfirmModal .modal-card', '08-preflight-confirm.png');
  await waitEnabled('#createLpConfirmProceedBtn');
  await page.click('#createLpConfirmProceedBtn');

  // One mid-flight frame so the GIF shows the live progress tree — the
  // most distinctive moment of the whole launch. At the 0.3× demo time
  // scale, 8s lands mid-run with phase rows visibly in motion.
  await page.waitForTimeout(8_000);
  await gifFrame('pools building');
  // lpDoneActions appears when every pool/position/lock completes. Demo
  // mode animates the full progress tree, hence the long timeout.
  await page.waitForSelector('#lpDoneActions:not(.hidden)', { state: 'visible', timeout: LP_TIMEOUT });
  await page.waitForTimeout(600);
  await shootCard(5, '09-create-pools.png');
  await gifFrame('pools complete');

  // The launch report. Expand the inline preview for the GIF frame, then
  // capture the FULL report document in a dedicated page — the in-card
  // crop cut the dossier off after its first screenful, which undersold
  // the single most differentiating artifact of a launch.
  try {
    await page.click('#step5ReportToggle');
    // The report renders into an iframe; give it a beat to paint.
    await page.waitForTimeout(1500);
    await gifFrame('report preview');

    const reportHtml = await page.$eval('#step5ReportIframe', (f) => f.srcdoc).catch(() => null);
    if (reportHtml) {
      const reportPage = await browser.newPage({
        viewport: { width: 1100, height: 1400 },
        deviceScaleFactor: 1,
      });
      // networkidle so the remote logo (Arweave imageUri) loads when
      // present; the data-URL fallback renders instantly either way.
      await reportPage.setContent(reportHtml, { waitUntil: 'networkidle' });
      await reportPage.waitForTimeout(800);
      // Same tall-viewport technique as shootClipped — grow the viewport
      // to the document height and take a plain screenshot, avoiding
      // Chromium's captureBeyondViewport (fullPage) entirely. dsf is 1
      // here so even a very tall buffer stays cheap.
      const docHeight = await reportPage.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
      await reportPage.setViewportSize({ width: 1100, height: Math.min(docHeight + 20, 20000) });
      await reportPage.waitForTimeout(400);
      await reportPage.screenshot({ path: join(outDir, '10-launch-report.png'), timeout: 20_000 });
      await reportPage.close();
      console.log('captured 10-launch-report.png (full document)');
    }

    await page.click('#step5ReportToggle'); // collapse again for the next shot
    await page.waitForTimeout(400);
  } catch (e) {
    console.warn('report capture skipped:', e.message);
  }

  await waitEnabled('#continueToTransferBtn');
  await page.click('#continueToTransferBtn');
  await stepIs(6);

  // ---- Step 6: final transfer ----
  // Demo mode pre-fills #destinationWallet with a recognisable DemoDest…
  // address, so no typing needed.
  await waitEnabled('#transferAssetsBtn');
  await page.click('#transferAssetsBtn');
  // Confirmation modal: tick the verified-address checkbox, confirm.
  await page.waitForSelector('#transferConfirmModal.is-active', { timeout: STEP_TIMEOUT });
  await shootEl('#transferConfirmModal .modal-card', '11-transfer-confirm.png');
  await page.check('#transferConfirmCheckbox');
  await waitEnabled('#transferConfirmBtn');
  await page.click('#transferConfirmBtn');

  // The success modal opens itself when the sweep completes.
  await page.waitForSelector('#launchSuccessModal.is-active', { timeout: TRANSFER_TIMEOUT });
  await page.waitForTimeout(2000); // coin spin-up + publish-state card
  await gifFrame('launch complete');
  await shootClipped('#launchSuccessModal .modal-card, #launchSuccessModal .modal-content', '12-launch-success.png');

  // Close the modal and grab the completed step-6 card (transfer summary +
  // report buttons + the coin handed back to the preview card).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await shootCard(6, '13-transfer.png');

  await browser.close();

  // ---- 3. Stitch the happy-path GIF ----------------------------------
  // Same palette technique the old mock-page script used, but the frames
  // are milestones of a REAL launch. ~1.2s per frame reads as a guided
  // tour; scale to 880px wide keeps the file README-friendly.
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    execSync(
      `ffmpeg -y -framerate 0.8 -i "${join(framesDir, 'f%02d.png')}" `
      + `-vf "fps=8,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" `
      + `-loop 0 "${join(outDir, 'launch-flow.gif')}"`,
      { stdio: 'inherit' },
    );
    console.log('captured launch-flow.gif');
  } catch (e) {
    console.warn('GIF skipped (ffmpeg unavailable or failed):', e.message);
  }

  console.log(`\nDone. Screenshots written to ${outDir}`);
} catch (e) {
  failed = true;
  console.error('\nScreenshot capture FAILED:', e.message);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
