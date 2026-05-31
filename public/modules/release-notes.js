// ===========================================================================
// Update-check result handler
// ===========================================================================
//
// Called from the main process (main.js → checkForUpdates) via
// webContents.executeJavaScript when the user picks Help → Check for
// Updates and the GitHub API call finishes. Lives on `window` so it's
// reachable from outside this module's scope — that's how main can
// invoke it without an IPC channel.
//
// The `info` object always has a `status` field. Other fields depend
// on the status:
//   status: 'current'   — { current }
//   status: 'available' — { current, latest, downloadUrl,
//                           downloadFilename, releaseUrl, notes }
//   status: 'no-asset'  — { current, latest, releaseUrl }
//   status: 'error'     — { message, releasesUrl }
//
// "Download" buttons use window.open(), which Electron's
// setWindowOpenHandler intercepts and routes to the system's default
// browser via shell.openExternal. So clicking Download starts the
// download in Chrome/Firefox/Safari/etc., not inside the Electron
// renderer.

window.__showUpdateResult = async function (info) {
  // Defensive: if main pushes a result before app.js finishes parsing
  // (extremely unlikely — the menu can't even be clicked before the
  // window has shown — but the cost of a guard is zero), bail rather
  // than throwing.
  if (typeof confirmDialog !== 'function') return;
  if (!info || typeof info !== 'object') return;

  // The "Don't check automatically" toggle. We include it on every
  // result modal so the user can change their mind from any path:
  //   - "Update available"  → opt out before downloading
  //   - "You're up to date" → review/change the setting after a
  //                            manual check
  //   - "Update check failed" → ditto
  //   - "No asset for OS"    → ditto
  //
  // info.checkOnStartup is the current persisted value (passed in by
  // main.js — it loaded the pref before sending the result). We render
  // the checkbox so that:
  //   - checked  = auto-check is OFF (user has opted out)
  //   - unchecked = auto-check is ON (the default)
  // i.e. checkbox semantics match its label: "Don't check automatically".
  //
  // The checkbox uses a stable id so we can wire up its onChange after
  // confirmDialog injects the body HTML. Bound below via setTimeout(0)
  // to guarantee the element exists in the DOM before we attach.
  const dontCheckCheckedNow = info.checkOnStartup === false;
  const checkboxHtml =
    `<div style="margin-top: 0.75rem; padding-top: 0.6rem; border-top: 1px solid rgba(0,0,0,0.08);">` +
      `<label class="checkbox is-size-7" style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer; user-select: none;">` +
        `<input type="checkbox" id="updatePrefCheckbox"${dontCheckCheckedNow ? ' checked' : ''}>` +
        `<span>Don't check for updates automatically</span>` +
      `</label>` +
    `</div>`;

  // Schedule the checkbox wire-up. Runs on the next tick, by which
  // time confirmDialog has set bodyEl.innerHTML and the new checkbox
  // is in the DOM. Posting to /api/user-prefs fire-and-forget — if it
  // fails (e.g. server transiently slow), the checkbox toggle visually
  // succeeded but the pref didn't persist; the user can toggle again
  // next time. That's preferable to blocking the modal on a server
  // round-trip.
  setTimeout(() => {
    const cb = document.getElementById('updatePrefCheckbox');
    if (!cb) return;
    cb.addEventListener('change', () => {
      // Checkbox checked = don't auto-check = pref is false.
      const newValue = !cb.checked;
      fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkForUpdatesOnStartup: newValue }),
      }).catch((err) => {
        console.warn('Failed to persist update-check preference:', err);
      });
    });
  }, 0);

  if (info.status === 'current') {
    await confirmDialog({
      title: "You're up to date",
      body:
        `<p>You're running the latest version (<strong>v${escapeHtml(info.current)}</strong>).</p>` +
        checkboxHtml,
      confirmLabel: 'OK',
      hideCancel: true,
    });
    return;
  }

  if (info.status === 'error') {
    // The check failed — typically a network blip, GitHub rate limit,
    // or the user is offline. Give them a path forward (link to the
    // releases page) so they can check manually if they want to.
    const releasesUrl = info.releasesUrl || 'https://github.com/AnOversizedMooseWithSocks/trebuchet/releases';
    await confirmDialog({
      title: 'Update check failed',
      body:
        `<p>${escapeHtml(info.message || 'Unknown error.')}</p>` +
        `<p class="is-size-7" style="color: var(--ink-soft); margin-top: 0.75rem;">` +
        `You can check manually at <a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noopener">the releases page</a>.</p>` +
        checkboxHtml,
      confirmLabel: 'OK',
      hideCancel: true,
    });
    return;
  }

  if (info.status === 'no-asset') {
    // An update exists but main couldn't find a binary for this OS in
    // the release. Send the user to the release page where they can
    // pick something themselves.
    const wantOpen = await confirmDialog({
      title: 'Update available',
      body:
        `<p>Version <strong>v${escapeHtml(info.latest)}</strong> is available ` +
        `(you have v${escapeHtml(info.current)}).</p>` +
        `<p>I couldn't find a download for your operating system in this ` +
        `release. Open the release page to choose one?</p>` +
        checkboxHtml,
      confirmLabel: 'Open release page',
    });
    if (wantOpen) window.open(info.releaseUrl, '_blank');
    return;
  }

  if (info.status === 'available') {
    // Truncate release notes so the modal stays a reasonable size.
    // For long changelogs we keep the first ~600 chars and link out
    // to the full release page.
    const rawNotes = (info.notes || '').trim();
    let notesForDisplay = rawNotes;
    let truncated = false;
    if (notesForDisplay.length > 600) {
      // Trim at the last whitespace before the limit so we don't cut
      // a word in half.
      notesForDisplay = notesForDisplay.slice(0, 600).replace(/\s+\S*$/, '');
      truncated = true;
    }
    const notesHtml = notesForDisplay
      ? renderReleaseNotes(notesForDisplay)
      : '<p style="color: var(--ink-soft); font-style: italic; margin: 0;">No release notes provided.</p>';

    const wantDownload = await confirmDialog({
      title: 'Update available',
      body:
        `<p>Version <strong>v${escapeHtml(info.latest)}</strong> is available ` +
        `(you have v${escapeHtml(info.current)}).</p>` +
        `<div style="margin: 0.75rem 0; padding: 0.75rem; background: rgba(0,0,0,0.04); border-radius: 4px;">` +
          notesHtml +
          (truncated
            ? `<p style="margin-top: 0.5rem; margin-bottom: 0;"><a href="${escapeHtml(info.releaseUrl)}" target="_blank" rel="noopener">See full release notes →</a></p>`
            : '') +
        `</div>` +
        `<p class="is-size-7" style="color: var(--ink-soft);">` +
        `Clicking Download will open <code>${escapeHtml(info.downloadFilename)}</code> ` +
        `in your default browser.</p>` +
        checkboxHtml,
      confirmLabel: 'Download',
    });
    if (wantDownload) window.open(info.downloadUrl, '_blank');
    return;
  }

  // Unrecognised status — shouldn't happen, but don't silently swallow.
  // Show a generic failure rather than throwing.
  await confirmDialog({
    title: 'Update check failed',
    body:
      `<p>Unexpected response from the update check.</p>` +
      checkboxHtml,
    confirmLabel: 'OK',
    hideCancel: true,
  });
};

// Tiny release-notes renderer for the update modal. Handles just the
// patterns we actually use in our release bodies:
//   - lines starting with "- " or "* " become <li> in a <ul>
//   - blank lines separate paragraphs
//   - everything else is wrapped in <p>
// Anything richer (links, bold, headings) is left as plain escaped
// text. Keeping this dumb is deliberate — release notes are author-
// controlled but pulled from a network response, so the smaller the
// rendering surface area, the smaller the attack surface.
function renderReleaseNotes(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push('<ul style="margin: 0; padding-left: 1.2rem;">');
        inList = true;
      }
      out.push(`<li>${escapeHtml(bullet[1])}</li>`);
    } else if (line === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p style="margin: 0 0 0.4rem;">${escapeHtml(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ===========================================================================
// Step state machine
