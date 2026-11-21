/* Cover intelligence:
   1) Canopy height packs (Meta/WRI 1 m canopy height, resampled by tools/canopy_pack.py) → tree height
      per cell, giving open ground / thick young growth / pole timber / mature timber.
   2) Screenshot analysis of your own onX (or any) imagery overlays → openings & water from color + texture.
   Both are georeferenced web-mercator rasters, sampled by lat/lng. */
(function () {
  "use strict";
  const { store } = window.WS;
  const R = 6378137;
  const mx = (lng) => (lng * Math.PI / 180) * R;
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;

  // ---------------------------------------------------------------- classes
  const CLASSES = [
    { key: "open", label: "Open (<2 m): fields, fresh cutovers, clearings, roads, water", max: 2, color: [230, 200, 120, 110] },
    { key: "regen", label: "Thick young growth (2–8 m): regen, cutover, WRP plantings, brush", max: 8, color: [60, 230, 60, 200] },
    { key: "pole", label: "Pole / young timber (8–15 m)", max: 15, color: [170, 200, 50, 170] },
    { key: "mature", label: "Mature timber (15 m+)", max: 999, color: [20, 110, 40, 190] },
  ];
  const classOf = (h) => (h == null ? null : h < 2 ? "open" : h < 8 ? "regen" : h < 15 ? "pole" : "mature");

  // ---------------------------------------------------------------- raster helper
  function raster(bounds, w, h, data) {
    const x0 = mx(bounds[0][1]), x1 = mx(bounds[1][1]), y0 = my(bounds[0][0]), y1 = my(bounds[1][0]);
    return {
      bounds, w, h, data,
      at(lat, lng) {
        const i = Math.floor(((mx(lng) - x0) / (x1 - x0)) * w), j = Math.floor(((y1 - my(lat)) / (y1 - y0)) * h);
        if (i < 0 || j < 0 || i >= w || j >= h) return null;
        return data[j * w + i];
      },
    };
  }
  async function decodeGray(blob) {
    const bm = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bm, 0, 0);
    const px = ctx.getImageData(0, 0, bm.width, bm.height).data, out = new Uint8Array(bm.width * bm.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
    return { w: bm.width, h: bm.height, data: out };
  }

  // ---------------------------------------------------------------- canopy packs
  const mem = new Map(); // blobKey -> raster
  async function canopyRaster(meta) {
    if (!meta) return null;
    if (mem.has(meta.blobKey)) return mem.get(meta.blobKey);
    const blob = await store.getBlob(meta.blobKey);
    if (!blob) return null;
    const g = await decodeGray(blob);
    const r = raster(meta.bounds, g.w, g.h, g.data);
    mem.set(meta.blobKey, r);
    return r;
  }
  async function importCanopyPack(pack) {
    if (pack.type !== "scouthub-canopy") throw new Error("Not a Scout Hub canopy file.");
    const blob = await (await fetch(pack.png)).blob();
    const blobKey = "cn_" + Date.now().toString(36);
    await store.setBlob(blobKey, blob);
    return { blobKey, bounds: pack.bounds, width: pack.width, height: pack.height, resM: pack.resM, source: pack.source, name: pack.name };
  }
  // colorized image for the map layer
  async function canopyImageURL(meta) {
    const r = await canopyRaster(meta);
    if (!r) return null;
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
    const ctx = c.getContext("2d"), img = ctx.createImageData(r.w, r.h), d = img.data;
    const lut = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) {
      const k = CLASSES.find((cl) => v < cl.max) || CLASSES[3];
      const col = v === 0 ? [230, 200, 120, 70] : k.color;
      lut.set(col, v * 4);
    }
    for (let i = 0; i < r.data.length; i++) { const v = r.data[i] * 4; d[i * 4] = lut[v]; d[i * 4 + 1] = lut[v + 1]; d[i * 4 + 2] = lut[v + 2]; d[i * 4 + 3] = lut[v + 3]; }
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
  }

  // ---------------------------------------------------------------- screenshot analysis
  // Classes: 0 unknown, 1 canopy/vegetation, 2 opening, 3 water. Uses color + local texture (std-dev of
  // brightness): fields/cutovers/roads are smooth & light; water is dark & smooth or bluish; timber is textured.
  async function analyzeScreenshot(blob) {
    const bm = await createImageBitmap(blob);
    const scale = Math.min(1, 1400 / Math.max(bm.width, bm.height));
    const w = Math.round(bm.width * scale), h = Math.round(bm.height * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bm, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, N = w * h;
    const L = new Float32Array(N), S = new Float32Array(N), B = new Float32Array(N), G = new Float32Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = px[j], g = px[j + 1], b = px[j + 2], mxv = Math.max(r, g, b), mnv = Math.min(r, g, b);
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b; S[i] = mxv ? (mxv - mnv) / mxv : 0; B[i] = b - (r + g) / 2; G[i] = g - (r + b) / 2;
    }
    // local std-dev of brightness in a 7x7 window (integral images)
    const ii = new Float64Array((w + 1) * (h + 1)), ii2 = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let s = 0, s2 = 0; for (let x = 0; x < w; x++) { const v = L[y * w + x]; s += v; s2 += v * v; ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + s; ii2[(y + 1) * (w + 1) + x + 1] = ii2[y * (w + 1) + x + 1] + s2; } }
    const r = 3, cls = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1), n = (xb - xa) * (yb - ya);
      const q = (A, X, Y) => A[Y * (w + 1) + X];
      const s = q(ii, xb, yb) - q(ii, xa, yb) - q(ii, xb, ya) + q(ii, xa, ya), s2 = q(ii2, xb, yb) - q(ii2, xa, yb) - q(ii2, xb, ya) + q(ii2, xa, ya);
      const sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), i = y * w + x, l = L[i];
      if ((l < 70 && sd < 7) || (B[i] > 12 && sd < 10 && l < 150)) cls[i] = 3;          // water
      else if (sd < 9 && l > 85 && G[i] < 18) cls[i] = 2;                                // smooth & light, not lush green: opening
      else if (sd < 6 && l > 110) cls[i] = 2;                                            // very smooth & bright: field/road
      else cls[i] = 1;                                                                   // textured: canopy / brush
    }
    // speckle cleanup: majority filter 5x5
    const out = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cnt = [0, 0, 0, 0];
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < w && yy < h) cnt[cls[yy * w + xx]]++; }
      out[y * w + x] = cnt.indexOf(Math.max(...cnt));
    }
    // ignore onX UI chrome near the edges (buttons, scale bars)
    const m = Math.round(Math.min(w, h) * 0.03);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < m || y < m || x >= w - m || y >= h - m) out[y * w + x] = 0;
    const counts = [0, 0, 0, 0]; out.forEach((v) => counts[v]++);
    // store as PNG (value * 60 to keep it viewable/debuggable)
    const mc = document.createElement("canvas"); mc.width = w; mc.height = h;
    const mctx = mc.getContext("2d"), mi = mctx.createImageData(w, h);
    for (let i = 0; i < N; i++) { mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = out[i] * 60; mi.data[i * 4 + 3] = 255; }
    mctx.putImageData(mi, 0, 0);
    const pngBlob = await new Promise((res) => mc.toBlob(res, "image/png"));
    return { pngBlob, w, h, pct: { canopy: counts[1] / N, open: counts[2] / N, water: counts[3] / N } };
  }
  const shotMem = new Map();
  async function shotRaster(o) {
    if (!o.analysis) return null;
    const key = o.analysis.blobKey;
    if (shotMem.has(key)) return shotMem.get(key);
    const blob = await store.getBlob(key);
    if (!blob) return null;
    const g = await decodeGray(blob);
    for (let i = 0; i < g.data.length; i++) g.data[i] = Math.round(g.data[i] / 60);
    // overlay bounds are [[sw],[ne]] which is what raster() expects
    const r = raster(o.bounds, g.w, g.h, g.data);
    shotMem.set(key, r);
    return r;
  }
  async function shotImageURL(o) {
    const r = await shotRaster(o);
    if (!r) return null;
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
    const ctx = c.getContext("2d"), img = ctx.createImageData(r.w, r.h), d = img.data;
    const COL = [[0, 0, 0, 0], [0, 0, 0, 0], [255, 214, 0, 170], [30, 140, 255, 170]];
    for (let i = 0; i < r.data.length; i++) d.set(COL[r.data[i]] || COL[0], i * 4);
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
  }
  function forgetShot(o) { if (o.analysis) shotMem.delete(o.analysis.blobKey); }

  // ---------------------------------------------------------------- combined sampler for Auto-Scout
  // Returns { h: canopy m | null, cls: open|regen|pole|mature|water|null, src }
  async function sampler(prop) {
    const canopy = await canopyRaster(prop.canopy);
    const shots = [];
    for (const o of prop.overlays || []) { const r = await shotRaster(o); if (r) shots.push(r); }
    if (!canopy && !shots.length) return null;
    const sample = (lat, lng) => {
      // screenshot first for water/opening (newest info), canopy for everything else
      for (const s of shots) { const v = s.at(lat, lng); if (v === 3) return { h: 0, cls: "water", src: "screenshot" }; if (v === 2) return { h: 0, cls: "open", src: "screenshot" }; }
      if (canopy) { const v = canopy.at(lat, lng); if (v != null) return { h: v, cls: classOf(v), src: "canopy" }; }
      for (const s of shots) { const v = s.at(lat, lng); if (v === 1) return { h: null, cls: "canopy", src: "screenshot" }; }
      return null;
    };
    return { sample, hasCanopy: !!canopy, shots: shots.length };
  }

  window.WS = Object.assign(window.WS || {}, {
    cover: { CLASSES, classOf, canopyRaster, importCanopyPack, canopyImageURL, analyzeScreenshot, shotRaster, shotImageURL, forgetShot, sampler },
  });
})();
