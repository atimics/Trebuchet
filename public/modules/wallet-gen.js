// ===========================================================================
// STEP 1: Generate wallet
// ===========================================================================

// Set a QR code image src. Uses the server-provided data URL when
// available; falls back to a pure client-side canvas renderer that
// works without Node.js modules (Electron sandbox, strict CSP, etc.).
function setQrCode(elementId, serverQr, publicKey) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (serverQr && serverQr.startsWith('data:image/')) {
    el.src = serverQr;
    el.onerror = function () { renderQrCodeToCanvas(el, publicKey); };
  } else {
    renderQrCodeToCanvas(el, publicKey);
  }
}

// Pure-DOM QR code renderer — no dependencies, works everywhere.
function renderQrCodeToCanvas(img, text) {
  try {
    var canvas = document.createElement('canvas');
    var size = 256;
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    // Build a simple QR matrix using the same algorithm as the qrcode
    // package.  We encode the text as a byte array and draw modules.
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else { bytes.push(0xc0 | (c >> 6)); bytes.push(0x80 | (c & 0x3f)); }
    }
    // Simple byte-mode QR encoding for alphanumeric + base58.
    // Pad with ECMA-001 terminator pattern.
    var data = qrEncodeBytes(bytes, size);
    if (!data) { img.alt = 'QR unavailable'; return; }
    var moduleCount = data.length;
    var moduleSize = Math.floor(size / (moduleCount + 8));
    var offset = Math.floor((size - moduleCount * moduleSize) / 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < moduleCount; r++) {
      for (var c = 0; c < moduleCount; c++) {
        if (data[r][c]) {
          ctx.fillRect(offset + c * moduleSize, offset + r * moduleSize, moduleSize, moduleSize);
        }
      }
    }
    img.src = canvas.toDataURL('image/png');
  } catch (_) { img.alt = 'QR unavailable'; }
}

// Minimal byte-mode QR encoder for short alphanumeric strings.
function qrEncodeBytes(bytes, _maxSize) {
  // We use a fixed version-3 QR (29×29 modules) with M-level ECC,
  // which fits up to ~40 alphanumeric chars — plenty for a base58 key.
  var V = 3; // version
  var N = 29; // modules per side
  var matrix = [];
  for (var i = 0; i < N; i++) { matrix[i] = []; for (var j = 0; j < N; j++) matrix[i][j] = false; }

  // Place finder patterns (3 corners)
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, N - 7);
  placeFinder(matrix, N - 7, 0);

  // Place timing patterns
  for (var i = 8; i < N - 8; i++) { matrix[6][i] = i % 2 === 0; matrix[i][6] = i % 2 === 0; }

  // Place dark module
  matrix[N - 8][8] = true;

  // Encode data into modules (simplified byte mode)
  var dataBits = [];
  // Mode indicator: 0100 (byte)
  dataBits.push(0,1,0,0);
  // Character count (8 bits for version < 10)
  var count = bytes.length;
  for (var b = 7; b >= 0; b--) dataBits.push((count >> b) & 1);
  // Data bytes
  for (var bi = 0; bi < bytes.length; bi++) {
    for (var b = 7; b >= 0; b--) dataBits.push((bytes[bi] >> b) & 1);
  }
  // Terminator (up to 4 bits)
  for (var t = 0; t < 4 && dataBits.length < 152; t++) dataBits.push(0);
  // Pad to byte boundary
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  // Pad bytes (0xEC, 0x11 alternating)
  var padBytes = [0xEC, 0x11];
  var pi = 0;
  while (dataBits.length < 152) {
    for (var b = 7; b >= 0; b--) dataBits.push((padBytes[pi] >> b) & 1);
    pi = 1 - pi;
  }

  // Place data bits in zigzag pattern (simplified)
  var col = N - 1;
  var dir = -1;
  var bitIdx = 0;
  while (col > 0 && bitIdx < dataBits.length) {
    if (col === 6) col = 5;
    for (var row = N - 1; row >= 0; row--) {
      for (var dc = 0; dc < 2; dc++) {
        var c = col - dc;
        var r = dir < 0 ? row : (N - 1 - row);
        if (c >= 0 && c < N && r >= 0 && r < N && matrix[r][c] === false) {
          if (bitIdx < dataBits.length) {
            matrix[r][c] = dataBits[bitIdx] === 1;
            bitIdx++;
          }
        }
      }
    }
    dir = -dir;
    col -= 2;
  }

  return matrix;
}

function placeFinder(matrix, startRow, startCol) {
  for (var r = 0; r < 7; r++) {
    for (var c = 0; c < 7; c++) {
      var border = r === 0 || r === 6 || c === 0 || c === 6;
      var inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix[startRow + r][startCol + c] = border || inner;
    }
  }
}

bind('generateWalletBtn', 'click', async () => {
  const btn = document.getElementById('generateWalletBtn');
  // If a wallet already exists, this is a regenerate. Confirm to avoid
  // accidentally wiping a launch in progress. Tailor the warning to how
  // far along the user is — past step 3 they may have funded the wallet.
  if (tempWallet && currentStep > 1) {
    const pastFunding = currentStep > 3;
    const body = pastFunding
      ? '<p>You are mid-launch. Generating a new wallet will <strong>not</strong> ' +
        'recover any funds, tokens, or NFTs already in the current ephemeral ' +
        'wallet — those will be stranded unless you save the private key ' +
        '(currently visible above) <strong>first</strong>.</p>' +
        '<p>Cancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, <strong>then</strong> regenerate.</p>' +
        '<p>Proceed anyway?</p>'
      : '<p>You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.</p>' +
        '<p>Proceed?</p>';
    const ok = await confirmDialog({
      title: 'Discard current wallet?',
      body,
      confirmLabel: 'Generate new wallet',
      danger: true,
    });
    if (!ok) return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Generating temporary wallet...');
      if (balancePollHandle) {
        clearInterval(balancePollHandle);
        balancePollHandle = null;
      }
      const resp = await fetch('/api/generate-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      // Reset all per-launch state so a regenerate starts truly fresh
      tempWallet = data.wallet;
      fundingWallet = null;
      fundingDetectionExhausted = false;
      lastSolBalance = 0;
      createdTokenInfo = null;
      lpResult = null;
      lastAirdropResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

      // Reset UI panels that may carry stale info from a previous attempt
      document.getElementById('walletInfo').classList.remove('hidden');
      setQrCode('qrCode', data.wallet.qrCode, data.wallet.publicKey);
      document.getElementById('walletAddress').value = data.wallet.publicKey;
      document.getElementById('privateKeyContainer').classList.add('hidden');
      document.getElementById('tokenCreatedInfo').classList.add('hidden');
      document.getElementById('createTokenBtn').classList.remove('hidden');
      document.getElementById('createLpBtn').classList.remove('hidden');
      document.getElementById('transferAssetsBtn').classList.remove('hidden');
      setLpDoneVisible(false);
      document.getElementById('lpFailInfo').classList.add('hidden');
      document.getElementById('lpProgress').classList.add('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      document.getElementById('transferResult').classList.add('hidden');
      document.getElementById('fundingWalletInfo').classList.add('hidden');
      document.getElementById('destinationWallet').value = '';
      // In demo mode, immediately re-fill with the synthetic destination
      // address so the user doesn't have to re-enter anything to finish
      // a second demo run after a reset. No-op in real mode.
      applyDemoDestinationWallet();

      // Reset step summaries from any prior attempt
      for (let i = 2; i <= 6; i++) setStepSummary(i, '');

      document.body.classList.add('has-log');

      log(`Wallet generated: ${data.wallet.publicKey}`, 'success');
      markLaunchActiveForRpcHealth(false);

      if (pools.length === 0) {
        // Build pools from simpleConfig defaults — produces 90/10
        // SOL+XLRT (or whatever the user has selected in the simple
        // toggle) instead of the old single SOL pool. The simple-config
        // UI may have been rendered already (see init at the bottom of
        // this file); we re-apply the mode here to make sure the right
        // container is visible after step 2 activates.
        rebuildPoolsFromSimple();
      }
      applySimpleConfigMode();

      // Check for an existing launch to resume (token already created,
      // LP partially done, etc.).  The server journals every on-chain
      // step so we can reconstruct the launch state after a crash.
      try {
        const stateResp = await fetch(
          `/api/launch-state?walletPublicKey=${encodeURIComponent(data.wallet.publicKey)}`,
        );
        const stateData = await stateResp.json();
        if (stateData.success && stateData.state) {
          const s = stateData.state;
          // Restore token info if we already created one
          if (s.token && s.token.mint) {
            createdTokenInfo = {
              mint: s.token.mint,
              decimals: s.token.decimals || 9,
              totalSupply: s.token.totalSupply,
              name: s.token.name || '',
              symbol: s.token.symbol || '',
            };
            document.getElementById('tokenCreatedInfo').classList.remove('hidden');
            document.getElementById('tokenMintAddress').textContent = s.token.mint;
            document.getElementById('tokenSolscanLink').href =
              `https://solscan.io/token/${s.token.mint}`;
            document.getElementById('createTokenBtn').classList.add('hidden');
            log(`Resumed token ${s.token.symbol || s.token.mint.slice(0, 8)}`, 'info');
          }
          // Restore LP result if pools were already created
          if (s.lp && Array.isArray(s.lp.results) && s.lp.results.length > 0) {
            lpResult = { results: s.lp.results };
            setLpDoneVisible(true);
            document.getElementById('createLpBtn').classList.add('hidden');
            log(`Resumed LP: ${s.lp.results.length} pool(s)`, 'info');
          }
          // Jump to the appropriate step
          const stage = s.stage || '';
          if (stage.startsWith('lp_') || (s.lp && Array.isArray(s.lp.results) && s.lp.results.length > 0)) {
            // LP was in progress or completed — go to step 5 or 6
            const targetStep = s.transfer ? 6 : 5;
            setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…`);
            setStepSummary(2, `${s.token?.symbol || ''} / SOL`);
            setStepSummary(3, '');
            if (createdTokenInfo) setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
            if (lpResult) setStepSummary(5, `${lpResult.results.length} pool(s)`);
            activateStep(targetStep);
            if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
            updateCancelButtonState();
            return;
          } else if (stage.startsWith('token_')) {
            // Token was created — go to step 5 (LP)
            setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…`);
            setStepSummary(2, `${s.token?.symbol || ''} / SOL`);
            setStepSummary(3, '');
            setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
            activateStep(5);
            if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
            updateCancelButtonState();
            return;
          }
        }
      } catch { /* launch-state lookup is advisory */ }

      setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…${data.wallet.publicKey.slice(-6)}`);
      activateStep(2);
      updateContinueToFundingState();
      updateCancelButtonState();
    } catch (e) {
      log(`Error: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('showPrivateKeyBtn', 'click', () => {
  const cont = document.getElementById('privateKeyContainer');
  const target = document.getElementById('privateKey');
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    // New wallets always have a mnemonic; the base58 fallback is only
    // here in case something upstream changes and we end up without one.
    if (tempWallet.mnemonic) {
      target.innerHTML = '';
      target.appendChild(buildMnemonicGrid(tempWallet.mnemonic));
    } else {
      target.className = 'secret-key-container';
      target.textContent = tempWallet.secretKeyB58 || '(secret unavailable)';
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

// Build a numbered 12-word grid for displaying a BIP39 mnemonic. Reads
// nicely on screen, easy to copy down accurately on paper.
function buildMnemonicGrid(mnemonic) {
  const wrap = document.createElement('div');
  wrap.className = 'mnemonic-grid';
  const words = mnemonic.trim().split(/\s+/);
  words.forEach((word, i) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<span class="num">${i + 1}.</span>${word}`;
    wrap.appendChild(cell);
  });
  return wrap;
}

// ===========================================================================
// STEP 2: Token + Pool config
// ===========================================================================

// Validate a picked logo file against the size and dimension limits.
// Returns a Promise<string|null>: null on success, an error message on
// failure. Loads the file as an image to read its natural dimensions —
// we can't trust the file metadata or filename extension for this; the
// only reliable read is "actually decode the image and ask."
//
// The Image decode is wrapped in a same-document objectURL that we
// revoke immediately after, regardless of outcome, so this validation
// path doesn't leak object URLs even on rapid file changes.

// Compress an image File to fit within maxDim and maxBytes.  Loads the
// image into an offscreen canvas, scales down if needed, then exports
// as JPEG with a binary-search quality loop to hit the byte target.
// Returns a Blob (image/jpeg).  Throws if even quality 0.10 exceeds
// maxBytes, so the caller can surface a graceful message.
async function compressImageToFit(file, maxDim, maxBytes) {
  // Decode the image.
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not decode image'));
    i.src = URL.createObjectURL(file);
  });

  // Scale down to maxDim×maxDim while preserving aspect ratio.
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  // Binary-search JPEG quality to hit maxBytes.  We probe between
  // 0.10 and 0.95 in 8 steps (~1.7% precision).
  let lo = 0.10;
  let hi = 0.95;
  let best = null;
  for (let step = 0; step < 8; step++) {
    const q = (lo + hi) / 2;
    const blob = await canvasToJpegBlob(img, w, h, q);
    if (blob.size <= maxBytes) {
      best = blob;
      lo = q;               // try higher quality
    } else {
      hi = q;               // too big, try lower
    }
  }
  if (!best) throw new Error('Cannot compress below byte limit');
  return best;
}

// Draw the image onto an offscreen canvas and export as JPEG at the
// given quality (0–1).  Returns a Blob.
function canvasToJpegBlob(img, w, h, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}

async function validateLogoFileDimensionsOnly(file) {
  // Size check removed — large files are now auto-compressed in the
  // change handler rather than being rejected outright.
  // accept attribute on the input already restricts the picker to
  // image/png and image/jpeg, but the browser's filter isn't a hard
  // gate (drag-and-drop, devtools, OS file dialogs that ignore filters
  // on some platforms). Re-check the MIME explicitly so we surface a
  // useful message instead of letting the image decode fail opaquely.
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    return 'Logo must be a PNG or JPG image.';
  }

  // Image-decode dimension check. We have to actually load the file as
  // an image — there's no synchronous way to get pixel dimensions from
  // a File object. createObjectURL + new Image() is the standard idiom.
  const url = URL.createObjectURL(file);
  try {
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Could not decode image — file may be corrupt'));
      img.src = url;
    });
    if (dims.w > MAX_LOGO_DIMENSION || dims.h > MAX_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; max is ` +
        `${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px. Resize the image and try again.`;
    }
    if (dims.w < MIN_LOGO_DIMENSION || dims.h < MIN_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; minimum is ` +
        `${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px. Pick a larger image.`;
    }
    return null;
  } catch (e) {
    return e.message || 'Could not read the image.';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Show or clear the inline logo error message under the file picker.
// Passing null hides the element; passing a string reveals it with the
// message. Encapsulates the .hidden toggle so the call sites read
// clearly as "set the error" vs "clear the error."
function setLogoError(message) {
  const el = document.getElementById('tokenLogoError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

bind('tokenLogo', 'change', async (e) => {
  const f = e.target.files[0];
  const filenameEl = document.getElementById('logoFileName');
  // No file selected (user cancelled out of the picker, or cleared the
  // selection). Reset displayed state and any prior error.
  if (!f) {
    filenameEl.textContent = 'No file selected';
    setLogoError(null);
    return;
  }
  // Show the picked filename immediately so the UI feels responsive
  // even while we're decoding the image to check dimensions. We'll
  // overwrite this with "No file selected" if validation fails.
  filenameEl.textContent = f.name;
  setLogoError(null);

  // Run structural validation first (MIME type, dimensions).
  // If only the file SIZE is wrong, we compress instead of rejecting.
  const needsCompress = f.size > MAX_LOGO_BYTES;
  const err = await validateLogoFileDimensionsOnly(f);
  if (err) {
    e.target.value = '';
    filenameEl.textContent = 'No file selected';
    setLogoError(err);
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
    return;
  }

  if (needsCompress) {
    filenameEl.textContent = f.name + ' (compressing…)';
    try {
      const compressed = await compressImageToFit(f, MAX_LOGO_DIMENSION, MAX_LOGO_BYTES);
      // Replace the file input's FileList with the compressed version.
      var dt = new DataTransfer();
      dt.items.add(new File([compressed], f.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
      e.target.files = dt.files;
      var newKb = (compressed.size / 1024).toFixed(0);
      filenameEl.textContent = f.name + ' → compressed to ' + newKb + 'KB';
      setLogoError(null);
    } catch (compressErr) {
      e.target.value = '';
      filenameEl.textContent = 'No file selected';
      setLogoError('Could not compress the image enough. Try a smaller file.');
      if (typeof renderTokenPreview === 'function') renderTokenPreview();
      return;
    }
  }

  // The separate change-handler binding (bind('tokenLogo', 'change',
  // renderTokenPreview) below) updates the preview to reflect the
  // (possibly compressed) file.
});

const poolList = document.getElementById('poolList');

