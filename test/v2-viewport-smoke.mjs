#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { V2_VIEWPORT_SMOKE_REQUIRED_CHECKS } from '../viewportSmokeContract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v2Dir = path.join(root, 'public', 'v2');
const v2Url = pathToFileURL(path.join(v2Dir, 'index.html')).href;
const proofPath = path.join(v2Dir, 'viewport-smoke-proof.json');
const assetFiles = ['index.html', 'styles.css', 'api-client.js', 'app.js'];
const requiredChecks = V2_VIEWPORT_SMOKE_REQUIRED_CHECKS;

// Three desktop widths per the review matrix: wide, normal, and the cramped
// window that hides most real layout defects — plus mobile. A cramped-window
// fix is not complete until the wider tiers have been checked too.
const viewports = [
  { name: 'desktop', tier: 'wide', width: 1440, height: 900 },
  { name: 'normal', tier: 'normal', width: 1100, height: 720 },
  { name: 'cramped', tier: 'cramped', width: 900, height: 650 },
  { name: 'mobile', tier: 'mobile', width: 390, height: 844 },
];

const isDesktopClass = (viewport) => viewport.tier !== 'mobile';

function assertRectVisible(rect, selector, viewport) {
  assert.ok(rect, `${viewport.name}: ${selector} missing`);
  assert.ok(rect.width > 0, `${viewport.name}: ${selector} has zero width`);
  assert.ok(rect.height > 0, `${viewport.name}: ${selector} has zero height`);
  assert.ok(rect.left >= -1, `${viewport.name}: ${selector} starts outside the viewport`);
  assert.ok(rect.right <= viewport.width + 1, `${viewport.name}: ${selector} overflows horizontally`);
}

function assertRectSized(rect, selector, viewport) {
  assert.ok(rect, `${viewport.name}: ${selector} missing`);
  assert.ok(rect.width > 0, `${viewport.name}: ${selector} has zero width`);
  assert.ok(rect.height > 0, `${viewport.name}: ${selector} has zero height`);
}

async function v2AssetHashes() {
  const entries = await Promise.all(assetFiles.map(async (file) => {
    const bytes = await fs.readFile(path.join(v2Dir, file));
    return [file, crypto.createHash('sha256').update(bytes).digest('hex')];
  }));
  return Object.fromEntries(entries);
}

async function smokeViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await page.goto(v2Url, { waitUntil: 'load' });
    await page.waitForSelector('#view-launch.is-active', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector('#tokenomicsChart svg')
        && (document.querySelector('#parityPanel article')
          || document.querySelector('#parityPanel .parity-summary')),
      null,
      { timeout: 10_000 },
    );

    // One launch flow: it opens on Token & pools with the app chrome visible.
    const firstOpen = await page.evaluate(() => ({
      experienceMode: document.body.dataset.experienceMode || null,
      workspace: document.body.dataset.launchWorkspace,
      setupHelp: document.querySelector('#setupHelp')?.textContent || '',
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      tabsVisible: Boolean(document.querySelector('#launchWorkspaceTabs')?.getClientRects().length),
      tokenNameVisible: Boolean(document.querySelector('#tokenName')?.getClientRects().length),
    }));
    assert.equal(firstOpen.experienceMode, null, `${viewport.name}: a separate experience mode is back`);
    assert.equal(firstOpen.workspace, 'configure', `${viewport.name}: launch does not open on Token & pools`);
    assert.match(firstOpen.setupHelp, /no transaction · 0 SOL/i);
    assert.equal(firstOpen.tabsVisible, true, `${viewport.name}: launch phases are hidden`);
    assert.equal(firstOpen.tokenNameVisible, true, `${viewport.name}: token name field is hidden`);
    assert.ok(
      firstOpen.scrollWidth <= firstOpen.clientWidth + 1,
      `${viewport.name}: launch overflows horizontally`,
    );

    await page.click('.launch-workspace-tab[data-launch-workspace="configure"]');

    const collapsedMetrics = await page.evaluate(() => {
      const cockpit = document.querySelector('.launch-summary-drawer');
      const workspace = document.querySelector('#launchWorkspaceViewport');
      const shell = document.querySelector('#view-launch .surface-main');
      const rect = (element) => {
        const value = element?.getBoundingClientRect();
        return value ? { top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        open: cockpit?.open === true,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        cockpit: rect(cockpit),
        workspace: rect(workspace),
        shell: rect(shell),
        workspaceOverflowY: workspace ? getComputedStyle(workspace).overflowY : null,
        docScrollHeight: document.documentElement.scrollHeight,
      };
    });
    assert.equal(collapsedMetrics.open, false, `${viewport.name}: launch summary should start collapsed`);
    assert.ok(collapsedMetrics.cockpit?.height > 0 && collapsedMetrics.cockpit.height < 80, `${viewport.name}: collapsed summary is not compact`);
    await page.click('.launch-summary-drawer > summary');

    const metrics = await page.evaluate(() => {
      const rectFor = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        };
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        title: document.title,
        launchVisible: document.querySelector('#view-launch')?.classList.contains('is-active') === true,
        chartSvgCount: document.querySelectorAll('#chartDeck svg').length,
        depthNodeCount: document.querySelectorAll('#liquidityChart *').length,
        fundingRowCount: document.querySelectorAll('#fundingMeter .funding-row').length,
        parityRowCount: document.querySelectorAll('#parityPanel article').length,
        parityDeferred: Boolean(document.querySelector('#parityPanel .launch-audit-deferred')),
        chartDeckClientWidth: document.querySelector('#chartDeck')?.clientWidth ?? 0,
        chartDeckScrollWidth: document.querySelector('#chartDeck')?.scrollWidth ?? 0,
        rects: {
          launchShell: rectFor('#view-launch .surface-main'),
          cockpit: rectFor('.cockpit-board'),
          chartDeck: rectFor('#chartDeck'),
          tokenomicsChart: rectFor('#tokenomicsChart'),
          liquidityChart: rectFor('#liquidityChart'),
          fundingMeter: rectFor('#fundingMeter'),
          workspaceTabs: rectFor('#launchWorkspaceTabs'),
          workspaceViewport: rectFor('#launchWorkspaceViewport'),
          actionPanel: rectFor('.cockpit-board .action-panel'),
          setupDock: rectFor('.setup-dock'),
        },
      };
    });

    const workspaceStates = {};
    for (const workspace of ['wallet', 'configure', 'fund', 'mint', 'liquidity', 'finish']) {
      await page.click(`.launch-workspace-tab[data-launch-workspace="${workspace}"]`);
      workspaceStates[workspace] = await page.evaluate((selectedWorkspace) => {
        const selectedTab = document.querySelector(`.launch-workspace-tab[data-launch-workspace="${selectedWorkspace}"]`);
        const visiblePaneCount = Array.from(document.querySelectorAll('[data-launch-pane]'))
          .filter((panel) => !panel.hidden && panel.getClientRects().length > 0).length;
        const classicSection = document.querySelector(`[data-classic-workspace="${selectedWorkspace}"]`);
        return {
          bodyWorkspace: document.body.dataset.launchWorkspace,
          selected: selectedTab?.getAttribute('aria-selected') === 'true',
          visiblePaneCount,
          classicSectionVisible: classicSection
            ? !classicSection.hidden && classicSection.getClientRects().length > 0
            : selectedWorkspace === 'configure',
        };
      }, workspace);
    }
    await page.click('.launch-workspace-tab[data-launch-workspace="configure"]');

    assert.deepEqual(pageErrors, [], `${viewport.name}: page errors`);
    assert.deepEqual(consoleErrors, [], `${viewport.name}: console errors`);
    assert.equal(metrics.title, 'TREBUCHET · makesometokens');
    assert.equal(metrics.launchVisible, true, `${viewport.name}: launch view is not active`);
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `${viewport.name}: horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );
    assert.ok(metrics.chartSvgCount >= 1, `${viewport.name}: tokenomics chart did not render`);
    assert.ok(metrics.depthNodeCount > 0, `${viewport.name}: liquidity chart did not render`);
    assert.ok(metrics.fundingRowCount >= 3, `${viewport.name}: funding meter did not render`);
    // Before a launch exists the panel correctly renders its deferred summary;
    // afterwards it renders parity rows. Either is a render, neither is empty.
    const parityPanel = metrics.parityRowCount >= 3 || metrics.parityDeferred;
    assert.ok(parityPanel, `${viewport.name}: parity panel rendered neither rows nor its deferred summary`);
    for (const [workspace, workspaceState] of Object.entries(workspaceStates)) {
      assert.equal(workspaceState.bodyWorkspace, workspace, `${viewport.name}: ${workspace} did not become active`);
      assert.equal(workspaceState.selected, true, `${viewport.name}: ${workspace} tab is not selected`);
      assert.ok(workspaceState.visiblePaneCount > 0, `${viewport.name}: ${workspace} has no visible workspace pane`);
      assert.equal(workspaceState.classicSectionVisible, true, `${viewport.name}: ${workspace} content is hidden`);
    }
    // Which element owns vertical scrolling is a deliberate, width-dependent
    // decision: above the 900px breakpoint the workspace panel scrolls
    // internally so the shell stays put; at or below it the page scrolls.
    // Pin both, so neither can flip silently.
    const expectedScrollOwner = viewport.tier === 'wide' || viewport.tier === 'normal'
      ? 'panel'
      : 'page';
    const actualScrollOwner = collapsedMetrics.workspaceOverflowY === 'auto' ? 'panel' : 'page';
    assert.equal(
      actualScrollOwner,
      expectedScrollOwner,
      `${viewport.name}: expected the ${expectedScrollOwner} to own vertical scrolling, got the ${actualScrollOwner}`,
    );

    const workspaceStartsInFirstViewport = collapsedMetrics.workspace.top < collapsedMetrics.clientHeight;
    const firstViewportFit = isDesktopClass(viewport)
      ? workspaceStartsInFirstViewport
        // When the page owns scrolling the panel may exceed the window, but the
        // document must actually be able to reveal all of it — not clip it.
        && (actualScrollOwner === 'panel'
          || collapsedMetrics.docScrollHeight + 1 >= collapsedMetrics.workspace.bottom)
      : collapsedMetrics.cockpit.bottom <= viewport.height + 1;
    assert.ok(
      firstViewportFit,
      `${viewport.name}: launch workspace does not fit its intended viewport ${JSON.stringify({
        workspaceTop: collapsedMetrics.workspace.top,
        workspaceBottom: collapsedMetrics.workspace.bottom,
        clientHeight: collapsedMetrics.clientHeight,
        docScrollHeight: collapsedMetrics.docScrollHeight,
        actualScrollOwner,
      })}`,
    );

    for (const selector of ['launchShell', 'cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs', 'workspaceViewport', 'setupDock']) {
      assertRectSized(metrics.rects[selector], selector, viewport);
    }

    const initiallyVisibleSelectors = viewport.tier === 'mobile'
      ? ['cockpit', 'chartDeck', 'tokenomicsChart', 'workspaceTabs', 'setupDock']
      : ['cockpit', 'chartDeck', 'tokenomicsChart', 'liquidityChart', 'fundingMeter', 'workspaceTabs'];
    for (const selector of initiallyVisibleSelectors) {
      assertRectVisible(metrics.rects[selector], selector, viewport);
    }
    if (viewport.name === 'desktop') {
      assert.ok(metrics.rects.workspaceViewport.top < viewport.height, 'desktop: active phase panel starts below the viewport');
      assert.ok(metrics.rects.setupDock.top < viewport.height, 'desktop: configure panel starts below the viewport');
    }
    if (viewport.tier === 'mobile') {
      assert.ok(
        metrics.chartDeckScrollWidth <= metrics.chartDeckClientWidth + 1,
        'mobile: expanded launch summary should not require horizontal scrolling',
      );
    }
    let terminalPanelFit = true;
    if (viewport.name === 'desktop') {
      await page.click('.launch-workspace-tab[data-launch-workspace="finish"]');
      const terminalMetrics = await page.evaluate(() => {
        // Measure the workspace itself, not a layout squeezed by the Plan drawer.
        document.querySelector('.launch-summary-drawer')?.removeAttribute('open');
        // The desktop hides the static host's one-step card once the API connects.
        const quickCard = document.querySelector('.quick-launch-card');
        if (quickCard) quickCard.hidden = true;
        const bridge = document.querySelector('#classicBridge');
        bridge.classList.add('has-recovery-notice', 'is-terminal-launch');
        bridge.innerHTML = `
          <aside class="recovered-plan-notice" role="status">
            <i></i><span><strong>Recovery loaded</strong><small>Only unfinished work remains.</small></span><button class="text-button">View record</button>
          </aside>
          <section class="classic-workspace-section classic-workspace-verify" data-classic-workspace="finish">
            <section class="launch-step-guide is-complete"><span class="launch-step-kicker">Launch complete</span><div><h2>Assets swept and proof recorded</h2><p>Launch wallet empty.</p></div><aside><span><strong>Final sweep verified.</strong></span></aside></section>
            <div class="finalize-panel is-terminal"><div class="finalize-head"><span><h3>Launch complete</h3></span></div><div class="finalize-grid"><span><small>Sweep</small><strong>Recorded</strong></span></div><div class="verify-panel-stage"><div class="proof-review-panel"><div class="proof-link-grid"><span><small>Mint</small><strong>Mint111</strong></span></div></div></div><div class="operator-toolbar compact"><button class="pill-button">Download proof</button></div></div>
          </section>`;
        const rect = (selector) => {
          const value = document.querySelector(selector)?.getBoundingClientRect();
          return value ? { top: value.top, bottom: value.bottom, height: value.height } : null;
        };
        return {
          viewport: rect('#launchWorkspaceViewport'),
          bridge: rect('#classicBridge'),
          notice: rect('.recovered-plan-notice'),
          phase: rect('.classic-workspace-verify'),
          guide: rect('.launch-step-guide.is-complete'),
          finalize: rect('.finalize-panel.is-terminal'),
        };
      });
      terminalPanelFit = Boolean(
        terminalMetrics.viewport
        && terminalMetrics.bridge
        && terminalMetrics.notice
        && terminalMetrics.phase
        && terminalMetrics.guide
        && terminalMetrics.finalize
        && terminalMetrics.notice.height <= 46
        && terminalMetrics.phase.top - terminalMetrics.notice.bottom <= 12
        && terminalMetrics.guide.top < viewport.height
        && terminalMetrics.finalize.top < viewport.height
        && terminalMetrics.phase.bottom <= terminalMetrics.viewport.bottom + 1
      );
      assert.ok(terminalPanelFit, `desktop: terminal recovery workspace is not tightly panelized: ${JSON.stringify(terminalMetrics)}`);
    }
    await page.click('.nav-item[data-view="discovery"]');
    await page.waitForFunction(() => document.body.dataset.activeView === 'discovery');
    const discoveryMetrics = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        tabs: rect('.discovery-pane-tabs'),
        firstTab: rect('.discovery-pane-tab'),
        tokenPanel: rect('.token-discovery-panel'),
        tokenFeed: rect('#personalTokenNetwork'),
        personalizeBannerCount: document.querySelectorAll('.discovery-personalize-banner, #discoveryPersonalizeBanner').length,
        duplicateWalletActions: document.querySelectorAll('#view-discovery .surface-main [data-discovery-pane-panel="tokens"] [data-action="open-wallet-tracking"]').length,
      };
    });
    const discoveryTokenViewport = Boolean(
      discoveryMetrics.tabs
      && discoveryMetrics.firstTab
      && discoveryMetrics.tokenPanel
      && discoveryMetrics.tokenFeed
      && discoveryMetrics.tabs.height <= 36
      && discoveryMetrics.firstTab.height <= 36
      && discoveryMetrics.tokenPanel.top - discoveryMetrics.tabs.bottom <= 10
      && discoveryMetrics.tokenPanel.top < viewport.height
      && discoveryMetrics.personalizeBannerCount === 0
      && discoveryMetrics.duplicateWalletActions === 0
    );
    assert.ok(discoveryTokenViewport, `${viewport.name}: Discovery navigation still crowds the token feed: ${JSON.stringify(discoveryMetrics)}`);

    // Keyboard walkthrough. This is release evidence, not a smoke nicety: the
    // proof artifact below fails closed when any of these is false or absent,
    // so an inaccessible build cannot ship with a passing manifest.
    await page.click('.nav-item[data-view="launch"]');
    await page.waitForFunction(() => document.body.dataset.activeView === 'launch');
    await page.evaluate(() => document.body.focus());

    const focusables = [];
    for (let step = 0; step < 24; step += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const focusStyle = getComputedStyle(el, null);
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0,
          insideViewport: rect.right <= window.innerWidth + 1 && rect.left >= -1,
          hasAccessibleName: Boolean(
            (el.getAttribute('aria-label') || '').trim()
            || (el.textContent || '').trim()
            || (el.getAttribute('title') || '').trim()
            || (el.labels && el.labels.length > 0),
          ),
          focusIndicator: focusStyle.outlineStyle !== 'none'
            || Number.parseFloat(focusStyle.outlineWidth || '0') > 0
            || style.boxShadow !== 'none',
        };
      });
      if (focused) focusables.push(focused);
    }

    const reachable = focusables.filter((entry) => entry.visible);
    const keyboardChecks = {
      // Tab reaches a real set of controls rather than dead-ending immediately.
      tabReachesControls: reachable.length >= 3,
      // Nothing focusable sits outside the viewport at this width.
      focusStaysInViewport: reachable.every((entry) => entry.insideViewport),
      // Every focused control shows where focus is.
      focusIsVisible: reachable.every((entry) => entry.focusIndicator),
      // Icon-only controls still announce themselves.
      focusablesAreLabelled: reachable.every((entry) => entry.hasAccessibleName),
    };
    const keyboardWalkthrough = Object.values(keyboardChecks).every(Boolean);
    assert.ok(
      keyboardWalkthrough,
      `${viewport.name}: keyboard walkthrough failed ${JSON.stringify({ keyboardChecks, sample: reachable.slice(0, 6) })}`,
    );

    return {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      passed: true,
      checks: {
        launchVisible: metrics.launchVisible,
        horizontalOverflow: metrics.scrollWidth <= metrics.clientWidth + 1,
        tokenomicsChart: metrics.chartSvgCount >= 1,
        liquidityChart: metrics.depthNodeCount > 0,
        fundingMeter: metrics.fundingRowCount >= 3,
        parityPanel,
        firstViewportFit,
        terminalPanelFit,
        discoveryTokenViewport,
        keyboardWalkthrough,
      },
      keyboardChecks,
      scrollOwner: actualScrollOwner,
    };
  } finally {
    await page.close();
  }
}

await fs.rm(proofPath, { force: true });
const startedAt = Date.now();
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const viewport of viewports) {
    results.push(await smokeViewport(browser, viewport));
  }
  const proof = {
    artifactVersion: 1,
    kind: 'trebuchet-v2-viewport-smoke',
    passed: true,
    command: 'npm run test:v2:viewport',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: v2Url,
    requiredChecks,
    assetHashes: await v2AssetHashes(),
    viewports: results,
  };
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`v2 viewport smoke passed for ${viewports.map((viewport) => viewport.name).join(', ')}`);
} finally {
  await browser.close();
}
