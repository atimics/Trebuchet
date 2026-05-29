// coinRenderer.js
//
// A small, self-contained 3D gold-coin preview built on three.js (loaded
// as the global `THREE` from vendor/three/three.min.js). The coin spins in
// the token-preview card: the front face shows the user's uploaded token
// logo, the back shows the logo of the largest pool's quote token (usually
// SOL). Both logos are embossed with a real bump map so the relief catches
// the light as the coin turns, with a generated environment map for the
// metal shine.
//
// Design notes / deliberate choices:
//   - Plain readable three.js, no abstractions. One module owns one scene.
//   - No examples/jsm imports (no OrbitControls etc.), so none of the
//     version-specific extras-module caveats apply. Only long-stable core
//     APIs are used.
//   - alpha:true renderer so the canvas background is transparent and the
//     parchment card shows through.
//   - The environment map is built in-memory from a canvas gradient — no
//     external HDR file to fetch, so the feature stays fully offline and
//     needs no CSP changes.
//   - Lifecycle discipline: browsers cap live WebGL contexts, so every
//     show/hide must fully tear down (cancel RAF, dispose geometry,
//     materials, textures, env map, renderer). See destroy().
//
// Public surface (see the exported object at the bottom):
//   init(mountEl)              — create renderer/scene/coin, start the loop
//   setFaces(frontImg, backImg)— (re)build the two cap textures
//   setBackSymbol(symbol)      — emboss a text symbol on the back instead
//                                of an image (CORS fallback / no-image case)
//   setBumpDepth(value)        — tune the relief depth on both faces
//   isActive()                 — whether init() has run and not been destroyed
//   destroy()                  — stop and dispose everything

(function (global) {
  'use strict';

  // ----- Module-level state (one coin per page; we never run two) ----------
  let renderer = null;
  let scene = null;
  let camera = null;
  let coinGroup = null;      // parent group we spin
  let coinMesh = null;       // the cylinder
  let pmrem = null;          // PMREMGenerator
  let envRT = null;          // the generated environment render target
  let rafId = null;          // requestAnimationFrame handle
  let mount = null;          // the DOM element we render into
  let resizeObserver = null;

  // Materials/textures we create and must dispose. The cylinder uses a
  // 3-material array: [side, topCap (front face), bottomCap (back face)].
  let sideMaterial = null;
  let frontMaterial = null;
  let backMaterial = null;
  // Track every texture we make so destroy() can dispose them all.
  const liveTextures = new Set();

  // Default relief depth. Tunable via setBumpDepth().
  let bumpScale = 0.45;

  // Spin speed (radians/sec) and a clock for frame-rate-independent motion.
  const SPIN_SPEED = 0.9;
  let lastTime = 0;

  // The face-texture resolution. 512 is plenty for a coin on screen and
  // keeps memory modest.
  const FACE_SIZE = 512;

  // -------------------------------------------------------------------------
  // Environment map — a soft vertical gradient (warm top, cool bottom) built
  // from a canvas and run through PMREMGenerator so MeshStandardMaterial can
  // use it for realistic metal reflection. This is what makes the gold read
  // as metal rather than flat paint.
  // -------------------------------------------------------------------------
  function buildEnvironment() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    // Light warm sky at the top, mid neutral, darker warm floor at the
    // bottom — gives the metal a believable light-from-above gradient.
    g.addColorStop(0.0, '#fff6e0');
    g.addColorStop(0.45, '#cdb98a');
    g.addColorStop(1.0, '#5a4a30');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;

    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    envRT = pmrem.fromEquirectangular(tex);
    // The source canvas texture is consumed by PMREM; dispose it now.
    tex.dispose();
    return envRT.texture;
  }

  // -------------------------------------------------------------------------
  // Face textures. For each face we draw two offscreen canvases:
  //   - colour canvas: a radial gold gradient disc + raised rim ring + the
  //     logo composited in the centre (letterboxed so non-square logos
  //     aren't distorted). Becomes the material's `map`.
  //   - bump canvas: mid-grey background, white rim ring, grayscale logo.
  //     White = raised, so the logo and rim emboss outward. Becomes the
  //     `bumpMap`; bumpScale controls depth.
  // -------------------------------------------------------------------------

  // Draw the gold disc + rim shared by both canvases' backgrounds.
  function drawDiscBackground(ctx, colour) {
    const s = FACE_SIZE;
    const r = s / 2;
    ctx.clearRect(0, 0, s, s);
    if (colour) {
      // Radial gold gradient: brighter centre, deeper edge.
      const grad = ctx.createRadialGradient(r, r * 0.8, r * 0.1, r, r, r);
      grad.addColorStop(0, '#f4d98a');
      grad.addColorStop(0.55, '#cda14a');
      grad.addColorStop(1, '#8a6a22');
      ctx.fillStyle = grad;
    } else {
      // Bump base: mid-grey = the neutral "flat" height.
      ctx.fillStyle = '#808080';
    }
    ctx.beginPath();
    ctx.arc(r, r, r - 2, 0, Math.PI * 2);
    ctx.fill();

    // Raised rim ring near the edge.
    ctx.lineWidth = s * 0.045;
    ctx.strokeStyle = colour ? '#b88a2a' : '#ffffff';
    ctx.beginPath();
    ctx.arc(r, r, r * 0.86, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Composite the logo as a CIRCLE that fills the coin face out to the rim,
  // matching the round logo shown elsewhere in the app. We clip to a disc
  // and "cover"-scale the image so it fills that disc (cropping any
  // overflow) instead of letterboxing a small square in the middle.
  // `colour` true → full colour on the metal; false → grayscale for the bump.
  function drawLogoImage(ctx, img, colour) {
    const s = FACE_SIZE;
    const r = s / 2;
    const faceR = r * 0.80;            // fill out to just inside the rim ring

    // Cover-scale: the larger axis fills the clip circle's bounding box, so
    // the round logo reaches the edge of the face with no empty border.
    const target = faceR * 2;
    const scale = Math.max(target / img.width, target / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = r - w / 2;
    const y = r - h / 2;

    ctx.save();
    // Circular clip centred on the disc — only the round logo shows.
    ctx.beginPath();
    ctx.arc(r, r, faceR, 0, Math.PI * 2);
    ctx.clip();

    if (colour) {
      ctx.drawImage(img, x, y, w, h);
    } else {
      // Grayscale version for the bump map. Draw to a scratch canvas, read
      // pixels, convert to luminance, draw back inside the clip. White = raised.
      const scratch = document.createElement('canvas');
      scratch.width = Math.max(1, Math.round(w));
      scratch.height = Math.max(1, Math.round(h));
      const sctx = scratch.getContext('2d');
      sctx.drawImage(img, 0, 0, scratch.width, scratch.height);
      try {
        const data = sctx.getImageData(0, 0, scratch.width, scratch.height);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          // Luminance, weighted by alpha so transparent areas stay neutral.
          const a = px[i + 3] / 255;
          const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = Math.round(128 + (lum - 128) * 0.4 * a + 96 * a);
          const clamped = Math.max(0, Math.min(255, v));
          px[i] = px[i + 1] = px[i + 2] = clamped;
          px[i + 3] = 255;
        }
        sctx.putImageData(data, 0, 0);
      } catch (e) {
        // Tainted canvas (cross-origin without CORS): fall back to a dimmed
        // draw so there's still some relief.
        ctx.globalAlpha = 0.5;
      }
      ctx.drawImage(scratch, x, y, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // Draw a text symbol (e.g. "SOL") embossed in the disc centre. Used for
  // the back face when there's no usable image.
  function drawSymbol(ctx, symbol, colour) {
    const s = FACE_SIZE;
    ctx.fillStyle = colour ? '#7a5c18' : '#ffffff';
    ctx.font = `bold ${Math.round(s * 0.26)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((symbol || '?').slice(0, 4).toUpperCase(), s / 2, s / 2);
  }

  // Build a {map, bumpMap} pair of CanvasTextures for one face. `content`
  // is either {img} (an HTMLImageElement) or {symbol} (a string) or null
  // (blank disc).
  function buildFaceTextures(content) {
    const colourCanvas = document.createElement('canvas');
    colourCanvas.width = colourCanvas.height = FACE_SIZE;
    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = bumpCanvas.height = FACE_SIZE;
    const cctx = colourCanvas.getContext('2d');
    const bctx = bumpCanvas.getContext('2d');

    drawDiscBackground(cctx, true);
    drawDiscBackground(bctx, false);

    // The cylinder cap maps a face texture so it lands rotated 90° CW on
    // screen (a consequence of the cap UVs + the rotation.x = 90° tilt).
    // Pre-rotate the *content* 90° CCW about the centre so the logo/symbol
    // read upright. The gold disc + rim are radially symmetric, so they're
    // drawn above (unrotated) and only the content needs this.
    const cr = FACE_SIZE / 2;
    function drawUpright(ctx, draw) {
      ctx.save();
      ctx.translate(cr, cr);
      ctx.rotate(-Math.PI / 2);     // CCW in canvas space, cancels the cap's CW
      ctx.translate(-cr, -cr);
      draw();
      ctx.restore();
    }

    if (content && content.img) {
      drawUpright(cctx, () => drawLogoImage(cctx, content.img, true));
      drawUpright(bctx, () => drawLogoImage(bctx, content.img, false));
    } else if (content && content.symbol) {
      drawUpright(cctx, () => drawSymbol(cctx, content.symbol, true));
      drawUpright(bctx, () => drawSymbol(bctx, content.symbol, false));
    }
    // else: blank gold disc (no-logo placeholder).

    const map = new THREE.CanvasTexture(colourCanvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const bumpMap = new THREE.CanvasTexture(bumpCanvas);
    liveTextures.add(map);
    liveTextures.add(bumpMap);
    return { map, bumpMap };
  }

  // Apply freshly-built textures to a face material, disposing the old ones.
  function applyFace(material, content) {
    const { map, bumpMap } = buildFaceTextures(content);
    if (material.map) {
      liveTextures.delete(material.map);
      material.map.dispose();
    }
    if (material.bumpMap) {
      liveTextures.delete(material.bumpMap);
      material.bumpMap.dispose();
    }
    material.map = map;
    material.bumpMap = bumpMap;
    material.bumpScale = bumpScale;
    material.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Image loading. The front face is a same-origin blob: URL (safe). The
  // back face is a remote https: URL; load it crossOrigin so WebGL can read
  // the canvas pixels, and let the caller fall back to a symbol on failure.
  // -------------------------------------------------------------------------
  function loadImage(url, crossOrigin) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + url));
      img.src = url;
    });
  }

  // -------------------------------------------------------------------------
  // Build the coin mesh: a short cylinder tilted so its flat faces point at
  // the camera, parented to a group that spins around the vertical axis.
  // -------------------------------------------------------------------------
  function buildCoin() {
    // radiusTop, radiusBottom, height, radialSegments. High segment count
    // keeps the rim smooth.
    const geo = new THREE.CylinderGeometry(1, 1, 0.16, 96);

    // Side: plain metallic gold, no map.
    sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xc99a36,
      metalness: 0.95,
      roughness: 0.32,
      envMap: envRT ? envRT.texture : null,
      envMapIntensity: 1.1,
    });
    // Two cap materials (front/back). Maps applied later via setFaces().
    frontMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.95,
      roughness: 0.28,
      envMap: envRT ? envRT.texture : null,
      envMapIntensity: 1.1,
      bumpScale: bumpScale,
    });
    backMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.95,
      roughness: 0.28,
      envMap: envRT ? envRT.texture : null,
      envMapIntensity: 1.1,
      bumpScale: bumpScale,
    });

    // CylinderGeometry material index order is [side, top, bottom].
    coinMesh = new THREE.Mesh(geo, [sideMaterial, frontMaterial, backMaterial]);
    // Tilt 90° so the flat "top" cap faces the camera (+Z).
    coinMesh.rotation.x = Math.PI / 2;

    coinGroup = new THREE.Group();
    coinGroup.add(coinMesh);
    scene.add(coinGroup);
  }

  // -------------------------------------------------------------------------
  // Animation loop. Frame-rate independent spin via a clock delta. Paused
  // automatically when the tab is hidden (visibilitychange) to save CPU.
  // -------------------------------------------------------------------------
  function animate(now) {
    rafId = requestAnimationFrame(animate);
    const t = now || 0;
    const dt = lastTime ? (t - lastTime) / 1000 : 0;
    lastTime = t;
    if (coinGroup) coinGroup.rotation.y += SPIN_SPEED * dt;
    renderer.render(scene, camera);
  }

  function startLoop() {
    if (rafId == null) {
      lastTime = 0;
      rafId = requestAnimationFrame(animate);
    }
  }
  function stopLoop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function onVisibilityChange() {
    if (!renderer) return;
    if (document.hidden) stopLoop();
    else startLoop();
  }

  // Keep the renderer sized to its mount element.
  function resize() {
    if (!renderer || !mount) return;
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  function init(mountEl) {
    if (renderer) return; // already initialised; ignore double-init
    if (typeof THREE === 'undefined') {
      console.warn('coinRenderer: THREE not loaded; coin disabled.');
      return;
    }
    mount = mountEl;

    const w = mount.clientWidth || 240;
    const h = mount.clientHeight || 240;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    // The canvas should fill its mount and never intercept page scrolls.
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    // Environment for metal reflection.
    const envTex = buildEnvironment();
    scene.environment = envTex;

    // Lights: a key directional from upper-left, a softer fill, and a low
    // ambient so the shadowed side of the relief never goes fully black.
    const key = new THREE.DirectionalLight(0xfff2d6, 2.4);
    key.position.set(-2, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.7);
    fill.position.set(3, -1, 2);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    buildCoin();

    // Start with blank gold discs until setFaces() is called.
    applyFace(frontMaterial, null);
    applyFace(backMaterial, { symbol: 'SOL' });

    // Track size changes (the card can reflow).
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    startLoop();
  }

  // (re)build both faces. Args may be null. Each arg is either a URL string
  // or null. frontUrl is treated as same-origin (blob); backUrl as remote
  // (loaded crossOrigin, with a symbol fallback supplied separately).
  function setFaces(frontUrl, backUrl, backSymbol) {
    if (!renderer) return;

    // Front face: same-origin blob, no CORS needed.
    if (frontUrl) {
      loadImage(frontUrl, false)
        .then((img) => applyFace(frontMaterial, { img }))
        .catch(() => applyFace(frontMaterial, null));
    } else {
      applyFace(frontMaterial, null);
    }

    // Back face: remote image, load crossOrigin; on any failure fall back to
    // an embossed symbol so the face is never blank/black.
    if (backUrl) {
      loadImage(backUrl, true)
        .then((img) => applyFace(backMaterial, { img }))
        .catch(() => applyFace(backMaterial, { symbol: backSymbol || 'SOL' }));
    } else {
      applyFace(backMaterial, { symbol: backSymbol || 'SOL' });
    }
  }

  function setBackSymbol(symbol) {
    if (!renderer) return;
    applyFace(backMaterial, { symbol: symbol || 'SOL' });
  }

  function setBumpDepth(value) {
    bumpScale = value;
    if (frontMaterial) frontMaterial.bumpScale = value;
    if (backMaterial) backMaterial.bumpScale = value;
  }

  function isActive() {
    return renderer != null;
  }

  // Full teardown. Browsers cap live WebGL contexts, so this must dispose
  // EVERYTHING and is called whenever the coin is hidden / the screen is
  // left / the window unloads.
  function destroy() {
    if (!renderer) return;
    stopLoop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    // Dispose all tracked textures.
    for (const tex of liveTextures) tex.dispose();
    liveTextures.clear();

    if (coinMesh) {
      coinMesh.geometry.dispose();
    }
    if (sideMaterial) sideMaterial.dispose();
    if (frontMaterial) frontMaterial.dispose();
    if (backMaterial) backMaterial.dispose();
    if (envRT) envRT.dispose();
    if (pmrem) pmrem.dispose();

    if (scene) {
      scene.environment = null;
      scene.clear();
    }

    // Drop the canvas and free the GL context.
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    renderer.dispose();
    renderer.forceContextLoss();

    renderer = null;
    scene = null;
    camera = null;
    coinGroup = null;
    coinMesh = null;
    sideMaterial = frontMaterial = backMaterial = null;
    pmrem = null;
    envRT = null;
    mount = null;
    lastTime = 0;
  }

  // Free the context if the page is torn down without an explicit destroy().
  window.addEventListener('beforeunload', () => {
    try { destroy(); } catch (e) { /* ignore */ }
  });

  global.coinRenderer = {
    init,
    setFaces,
    setBackSymbol,
    setBumpDepth,
    isActive,
    destroy,
  };
})(window);
