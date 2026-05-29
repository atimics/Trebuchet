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
  // The fluted reeded-edge ring, added as a child of the coin mesh.
  let rimMesh = null;
  // Silhouette-blur glow pipeline: render targets, the silhouette/blur/
  // composite materials, and the fullscreen quads that drive the passes.
  let glowRTA = null, glowRTB = null;
  let glowSilMat = null, glowBlurMat = null, glowCompositeMat = null;
  let fsCam = null, fsScene = null, fsQuad = null;       // blur quad
  let glowScene = null, glowQuad = null;                 // composite quad
  // Track every texture we make so destroy() can dispose them all.
  const liveTextures = new Set();

  // Default relief strength for the embossed faces (drives normalScale).
  // Tunable via setBumpDepth().
  let reliefStrength = 1.2;

  // Spin speed (radians/sec) and a clock for frame-rate-independent motion.
  const SPIN_SPEED = 0.9;
  let lastTime = 0;

  // The face-texture resolution. 512 is plenty for a coin on screen and
  // keeps memory modest.
  const FACE_SIZE = 512;

  // Reeded edge (the milled ridges around a coin's rim, like a US quarter's
  // 119 reeds). These are built as real geometry — a fluted ring around the
  // rim — rather than a bump map, because at this small size a bump-mapped
  // edge aliases into coarse facets instead of fine ridges. RIM_RIDGES is how
  // many ridges go around; RIM_RIDGE_DEPTH is how far each crest stands out
  // (in coin radii, where the coin radius is 1). Both are easy to tune.
  const RIM_RIDGES = 90;
  const RIM_RIDGE_DEPTH = 0.03;

  // Emboss sharpness: how steeply the height→normal conversion reads slopes.
  // Higher = crisper, deeper-looking stamped relief on the faces.
  const NORMAL_SOBEL_STRENGTH = 2.6;

  // 3D contour glow. Built like a Photoshop "outer glow": each frame we render
  // the coin as a solid-colour silhouette (scaled up a touch = a few px of
  // dilation), gaussian-blur it, and draw it BEHIND the coin. Because the real
  // coin is drawn on top, the glow can't bleed over it; because it's the coin's
  // actual silhouette, the glow always hugs the contour as it spins; and the
  // blur gives a true soft falloff. GLOW_COLOR is the hue, GLOW_INTENSITY the
  // opacity, GLOW_DILATE how far the silhouette grows (the "+N px"),
  // GLOW_BLUR_PASSES/GLOW_SPREAD the softness, GLOW_RT_SIZE the buffer size.
  const GLOW_COLOR = 0xc0451f;
  const GLOW_INTENSITY = 0.9;
  const GLOW_DILATE = 1.03;
  const GLOW_BLUR_PASSES = 6;
  const GLOW_SPREAD = 2.6;
  const GLOW_RT_SIZE = 256;

  // -------------------------------------------------------------------------
  // Environment map — a soft vertical gradient (warm top, cool bottom) built
  // from a canvas and run through PMREMGenerator so MeshStandardMaterial can
  // use it for realistic metal reflection. This is what makes the gold read
  // as metal rather than flat paint.
  // -------------------------------------------------------------------------
  function buildEnvironment() {
    const W = 512, H = 256;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    // Base vertical gradient: bright warm sky, neutral horizon, dark warm
    // floor. This is the overall light-from-above wash on the metal.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.0, '#fff3da');
    g.addColorStop(0.40, '#cdb98a');
    g.addColorStop(0.62, '#94815a');     // horizon line
    g.addColorStop(1.0, '#39301f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Soft "softbox" lights placed at different azimuths (x) so the coin
    // sweeps through distinct specular highlights as it spins about its axis —
    // the moving glints that read as polished metal rather than flat paint.
    // Additive ('lighter') blending makes them behave like real light sources.
    ctx.globalCompositeOperation = 'lighter';
    const softbox = (cx, cy, radius, inner) => {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, inner);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    };
    softbox(W * 0.22, H * 0.26, 150, 'rgba(255,244,214,0.95)'); // warm key
    softbox(W * 0.60, H * 0.30, 120, 'rgba(220,232,255,0.55)'); // cool rim
    softbox(W * 0.86, H * 0.22,  80, 'rgba(255,255,255,0.85)'); // small hot spot
    softbox(W * 0.45, H * 0.78, 140, 'rgba(130,108,72,0.55)');  // warm floor bounce
    ctx.globalCompositeOperation = 'source-over';

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
  //   - height canvas: mid-grey background, white rim ring, grayscale logo.
  //     White = raised. This is converted to a normal map (heightToNormal)
  //     and used as both the base normalMap and the clearcoatNormalMap, so the
  //     relief shows through the glossy clearcoat. reliefStrength scales it.
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
          // Centre the relief on the disc's neutral height (128) and let the
          // logo's own luminance sculpt it: bright features rise above the
          // field, dark features sink below it — a stamped/minted look rather
          // than the whole logo bulging out as one flat plateau. Alpha-weighted
          // so transparent areas stay at the neutral field height.
          const a = px[i + 3] / 255;
          const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = Math.round(128 + (lum - 128) * 0.8 * a);
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

  // Convert a grayscale height canvas into a tangent-space normal map canvas
  // (Sobel slopes → RGB normal). We feed this to BOTH the base normalMap and
  // the clearcoatNormalMap so the embossed relief shows through the glossy
  // clearcoat instead of being flattened by it. Returns a neutral (flat) map
  // if the source canvas is unreadable (e.g. a tainted cross-origin image).
  function heightToNormal(heightCanvas, strength) {
    const w = heightCanvas.width, h = heightCanvas.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    let src;
    try {
      src = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    } catch (e) {
      // Unreadable: return a flat normal (points straight out: 128,128,255).
      octx.fillStyle = 'rgb(128,128,255)';
      octx.fillRect(0, 0, w, h);
      return out;
    }
    const dst = octx.createImageData(w, h);
    const at = (x, y) => {
      x = x < 0 ? 0 : x >= w ? w - 1 : x;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
      return src[(y * w + x) * 4];   // grayscale, so the red channel is height
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sobel gradients of the height field.
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        let nx = -(dx / 255) * strength;
        let ny = -(dy / 255) * strength;
        let nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        const i = (y * w + x) * 4;
        dst.data[i]     = Math.round((nx / len * 0.5 + 0.5) * 255);
        dst.data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
        dst.data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
        dst.data[i + 3] = 255;
      }
    }
    octx.putImageData(dst, 0, 0);
    return out;
  }

  // Build a {map, normalMap} pair of CanvasTextures for one face. `content`
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
    // Convert the grayscale relief canvas to a normal map. Normal maps are
    // linear data, so we leave its colorSpace at the default (not sRGB).
    const normalCanvas = heightToNormal(bumpCanvas, NORMAL_SOBEL_STRENGTH);
    const normalMap = new THREE.CanvasTexture(normalCanvas);
    normalMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
    liveTextures.add(map);
    liveTextures.add(normalMap);
    return { map, normalMap };
  }

  // Apply freshly-built textures to a face material, disposing the old ones.
  function applyFace(material, content) {
    const { map, normalMap } = buildFaceTextures(content);
    if (material.map) {
      liveTextures.delete(material.map);
      material.map.dispose();
    }
    // normalMap and clearcoatNormalMap share one texture instance, so dispose
    // it once via normalMap.
    if (material.normalMap) {
      liveTextures.delete(material.normalMap);
      material.normalMap.dispose();
    }
    material.map = map;
    material.normalMap = normalMap;
    material.normalScale.set(reliefStrength, reliefStrength);
    // Make the clearcoat follow the same relief so the gloss doesn't flatten
    // the emboss.
    if ('clearcoatNormalMap' in material) {
      material.clearcoatNormalMap = normalMap;
      material.clearcoatNormalScale.set(reliefStrength, reliefStrength);
    }
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
  // -------------------------------------------------------------------------
  // Reeded-edge geometry. A fluted ring whose outer radius gently oscillates
  // with angle — r(θ) = base + depth·(½ + ½cos(RIDGES·θ)) — so the surface
  // genuinely rises and falls into ridges and grooves around the rim. It sits
  // just outside the smooth cylinder side (which it hides), and its crests
  // stand a hair proud of the faces, like real reeding.
  //
  // Normals are computed analytically (outward, accounting for the radial
  // slope dr/dθ) so the ridges read as smoothly rounded rather than faceted.
  // The seam at θ=0/θ=2π is welded because the last segment wraps to vertex 0.
  // -------------------------------------------------------------------------
  function buildReededRim() {
    const segsPerRidge = 6;                 // angular resolution per ridge
    const segs = RIM_RIDGES * segsPerRidge; // total segments around
    const halfH = 0.16 / 2;                 // half the coin thickness
    const baseR = 1.004;                    // just outside the smooth side
    const depth = RIM_RIDGE_DEPTH;

    const positions = [];
    const normals = [];
    const uvs = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // Rounded ridge profile and its angular slope.
      const r = baseR + depth * (0.5 + 0.5 * Math.cos(theta * RIM_RIDGES));
      const dr = -0.5 * depth * RIM_RIDGES * Math.sin(theta * RIM_RIDGES);
      // Outward normal in the xz-plane (no vertical component): perpendicular
      // to the surface tangent, pointing away from the axis.
      let nx = r * cos + dr * sin;
      let nz = r * sin - dr * cos;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;

      const x = cos * r;
      const z = sin * r;
      const u = i / segs;
      positions.push(x, halfH, z);   // top ring   (vertex 2i)
      positions.push(x, -halfH, z);  // bottom ring (vertex 2i+1)
      normals.push(nx, 0, nz);
      normals.push(nx, 0, nz);
      uvs.push(u, 1);                // top
      uvs.push(u, 0);                // bottom
    }

    const indices = [];
    for (let i = 0; i < segs; i++) {
      const ni = (i + 1) % segs;
      const a = 2 * i, b = 2 * i + 1, c = 2 * ni, d = 2 * ni + 1;
      indices.push(a, b, d, a, d, c);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  // -------------------------------------------------------------------------
  // Metal "wear" detail map. A near-white field (so it barely changes the base
  // roughness) sprinkled with fine noise and faint random scratches. Used as a
  // roughnessMap on the metal so the surface has tiny imperfections that catch
  // the light differently as it turns — real metal is never a perfect mirror.
  // -------------------------------------------------------------------------
  function buildMetalDetailTexture() {
    const N = 512;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    // Base field + per-pixel micro-noise.
    const img = ctx.createImageData(N, N);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 232 + ((Math.random() * 16) | 0) - 8;   // ~0.91 ± a little
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Fine scratches: thin lines, mostly slightly rougher (lighter), a few
    // polished (darker). Translucent so they read as faint hairlines that
    // accumulate where they cross — minor wear, not damage.
    for (let k = 0; k < 180; k++) {
      const x = Math.random() * N, y = Math.random() * N;
      const ang = Math.random() * Math.PI;
      const len = 16 + Math.random() * 130;
      ctx.strokeStyle = Math.random() < 0.7
        ? 'rgba(255,255,255,0.35)'
        : 'rgba(105,105,105,0.30)';
      ctx.lineWidth = Math.random() < 0.85 ? 1 : 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    liveTextures.add(tex);
    return tex;
  }

  function buildCoin() {
    // radiusTop, radiusBottom, height, radialSegments. High segment count
    // keeps the rim smooth.
    const geo = new THREE.CylinderGeometry(1, 1, 0.16, 96);

    // Shared metal "wear" map (fine scratches + micro-noise) used as a
    // roughnessMap so no surface is a flawless mirror.
    const detail = buildMetalDetailTexture();

    // Side: polished gold metal. The visible rim is the fluted reeded ring
    // (added below), which sits just outside this smooth side and hides it.
    sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xc99a36,
      metalness: 1.0,
      roughness: 0.30,
      roughnessMap: detail,
      envMap: envRT ? envRT.texture : null,
      envMapIntensity: 1.35,
    });
    // Faces: MeshPhysicalMaterial so we can lay a thin clearcoat over them —
    // a smooth glossy layer (its own crisp reflection) sitting above the
    // embossed logo, like the lacquer/proof finish on a real coin. The base
    // is metallic gold tinted by the face texture; the clearcoat adds the
    // sharp surface sheen without flattening the logo's colour.
    const facePhysical = () => new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.9,
      roughness: 0.30,
      roughnessMap: detail,
      envMap: envRT ? envRT.texture : null,
      // Slightly lower than the rim's so the bright studio reflections don't
      // wash out the logo — the rim stays the shiniest part.
      envMapIntensity: 1.1,
      clearcoat: 0.6,
      clearcoatRoughness: 0.22,
    });
    frontMaterial = facePhysical();
    backMaterial = facePhysical();

    // CylinderGeometry material index order is [side, top, bottom].
    coinMesh = new THREE.Mesh(geo, [sideMaterial, frontMaterial, backMaterial]);
    // Tilt 90° so the flat "top" cap faces the camera (+Z).
    coinMesh.rotation.x = Math.PI / 2;

    // Reeded edge: a fluted ring parented to the coin mesh (so it inherits the
    // tilt and the spin). It shares the gold side material; DoubleSide keeps it
    // robust to winding so the ridges always render.
    sideMaterial.side = THREE.DoubleSide;
    rimMesh = new THREE.Mesh(buildReededRim(), sideMaterial);
    coinMesh.add(rimMesh);

    coinGroup = new THREE.Group();
    coinGroup.add(coinMesh);
    scene.add(coinGroup);
  }

  // -------------------------------------------------------------------------
  // Silhouette-blur contour glow. Sets up the render targets, the three
  // materials (solid-colour silhouette override, separable gaussian blur, and
  // the final colour+alpha composite), and two fullscreen quads. The actual
  // multi-pass render happens each frame in renderWithGlow().
  // -------------------------------------------------------------------------
  function buildGlow() {
    const opts = { depthBuffer: false, stencilBuffer: false };
    glowRTA = new THREE.WebGLRenderTarget(GLOW_RT_SIZE, GLOW_RT_SIZE, opts);
    glowRTB = new THREE.WebGLRenderTarget(GLOW_RT_SIZE, GLOW_RT_SIZE, opts);

    // Solid flat colour, drawn on both sides so the whole silhouette fills in.
    glowSilMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(GLOW_COLOR),
      side: THREE.DoubleSide,
    });
    glowSilMat.toneMapped = false;

    // A fullscreen-quad vertex shader (writes clip space directly, ignores the
    // camera) shared by the blur and composite passes.
    const fsVert = [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4(position.xy, 0.0, 1.0);',
      '}',
    ].join('\n');

    // Separable 9-tap gaussian. `dir` is the per-axis texel step.
    glowBlurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
      vertexShader: fsVert,
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform vec2 dir;',
        'varying vec2 vUv;',
        'void main() {',
        '  vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;',
        '  sum += texture2D(tDiffuse, vUv + dir * 1.3846153846) * 0.3162162162;',
        '  sum += texture2D(tDiffuse, vUv - dir * 1.3846153846) * 0.3162162162;',
        '  sum += texture2D(tDiffuse, vUv + dir * 3.2307692308) * 0.0702702703;',
        '  sum += texture2D(tDiffuse, vUv - dir * 3.2307692308) * 0.0702702703;',
        '  gl_FragColor = sum;',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });
    fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    fsScene = new THREE.Scene();
    fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glowBlurMat);
    fsScene.add(fsQuad);

    // Composite: tint the blurred silhouette's coverage (its alpha) with the
    // glow colour and overall intensity.
    glowCompositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tGlow: { value: null },
        glowColor: { value: new THREE.Color(GLOW_COLOR) },
        intensity: { value: GLOW_INTENSITY },
      },
      vertexShader: fsVert,
      fragmentShader: [
        'uniform sampler2D tGlow;',
        'uniform vec3 glowColor;',
        'uniform float intensity;',
        'varying vec2 vUv;',
        'void main() {',
        '  float a = texture2D(tGlow, vUv).a;',
        '  gl_FragColor = vec4(glowColor, a * intensity);',
        '}',
      ].join('\n'),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    glowScene = new THREE.Scene();
    glowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glowCompositeMat);
    glowScene.add(glowQuad);
  }

  // Per-frame: render the dilated silhouette, blur it, then draw the glow
  // behind a fresh render of the coin.
  function renderWithGlow() {
    // 1) Dilated silhouette → glowRTA (clear to transparent first).
    coinGroup.scale.setScalar(GLOW_DILATE);
    scene.overrideMaterial = glowSilMat;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(glowRTA);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    coinGroup.scale.setScalar(1);

    // 2) Separable gaussian blur, ping-ponging between the two targets.
    let src = glowRTA, dst = glowRTB;
    const step = GLOW_SPREAD / GLOW_RT_SIZE;
    for (let i = 0; i < GLOW_BLUR_PASSES; i++) {
      glowBlurMat.uniforms.tDiffuse.value = src.texture;
      glowBlurMat.uniforms.dir.value.set(step, 0);
      renderer.setRenderTarget(dst);
      renderer.clear();
      renderer.render(fsScene, fsCam);

      glowBlurMat.uniforms.tDiffuse.value = dst.texture;
      glowBlurMat.uniforms.dir.value.set(0, step);
      renderer.setRenderTarget(src);
      renderer.clear();
      renderer.render(fsScene, fsCam);
    }

    // 3) To the screen: glow first (clears to transparent), then the coin on
    // top without wiping the glow colour.
    glowCompositeMat.uniforms.tGlow.value = src.texture;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(glowScene, fsCam);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = true;
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
    renderWithGlow();
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
    // Filmic tone mapping: rolls off bright specular highlights smoothly
    // instead of clipping them to flat white, which is what sells polished
    // metal. Exposure is the master brightness knob for the whole coin.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    // The canvas should fill its mount and never intercept page scrolls.
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
    // Sit slightly above and look at centre: a gentle 3/4 view so the reeded
    // rim and the coin's thickness read, rather than a flat head-on spin. The
    // distance is set so the coin fills only the centre of its (larger) canvas,
    // leaving a margin around it for the contour glow to spread into without
    // being clipped at the canvas edge. The y offset is scaled with the
    // distance to keep the same 3/4 tilt angle.
    camera.position.set(0, 0.67, 5.72);
    camera.lookAt(0, 0, 0);

    // Environment for metal reflection.
    const envTex = buildEnvironment();
    scene.environment = envTex;

    // Lights, balanced for the filmic tone curve above. A warm key from the
    // upper-left does most of the modelling; a cool fill keeps the shadow side
    // from going dead; a back/rim "kicker" from behind-above catches the top
    // edge and the rim ridges so the silhouette pops; a low ambient lifts the
    // deepest creases of the relief.
    const key = new THREE.DirectionalLight(0xfff2d6, 3.0);
    key.position.set(-2.2, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.85);
    fill.position.set(3, -1, 2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfff0d8, 1.5);
    rim.position.set(0.6, 2.4, -3);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    buildCoin();
    buildGlow();

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
    reliefStrength = value;
    for (const m of [frontMaterial, backMaterial]) {
      if (!m) continue;
      if (m.normalScale) m.normalScale.set(value, value);
      if (m.clearcoatNormalScale) m.clearcoatNormalScale.set(value, value);
    }
  }

  function isActive() {
    return renderer != null;
  }

  // Re-home the existing canvas into a (possibly new) mount element. Used when
  // the page re-renders the area around the coin — e.g. entering "review
  // completed step" rebuilds the step DOM, which detaches our canvas while the
  // WebGL context itself is still alive. Rather than tearing down and
  // recreating the context (which the browser caps and which would lose the
  // built coin/glow), we just move the canvas into the new mount, re-point the
  // ResizeObserver, and resize. Returns false if there's nothing to reattach
  // (not initialised) so the caller can init() instead.
  function reattach(mountEl) {
    if (!renderer || !mountEl) return false;
    if (renderer.domElement.parentNode !== mountEl) {
      mountEl.appendChild(renderer.domElement); // moves it if already elsewhere
    }
    mount = mountEl;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver.observe(mount);
    }
    resize();
    return true;
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
    if (rimMesh) {
      rimMesh.geometry.dispose();
      rimMesh = null;
    }
    if (glowRTA) { glowRTA.dispose(); glowRTA = null; }
    if (glowRTB) { glowRTB.dispose(); glowRTB = null; }
    if (glowSilMat) { glowSilMat.dispose(); glowSilMat = null; }
    if (glowBlurMat) { glowBlurMat.dispose(); glowBlurMat = null; }
    if (glowCompositeMat) { glowCompositeMat.dispose(); glowCompositeMat = null; }
    if (fsQuad) { fsQuad.geometry.dispose(); fsQuad = null; }
    if (glowQuad) { glowQuad.geometry.dispose(); glowQuad = null; }
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
    reattach,
    setFaces,
    setBackSymbol,
    setBumpDepth,
    isActive,
    destroy,
  };
})(window);
