/* Auto-Scout: reads the terrain in view (no marking required) and proposes ranked spots to scout,
   each with plain-English reasons, plus rifle-setup ideas with workable winds.
   Flat/bottomland mode: high-ground islands & ridges (bedding), land bridges between wet ground,
   and the narrowest slough crossings (funnels). Hill mode: saddles, benches, ridge points.
   Your own marks (access, sign, food, bedding, no-go) adjust the scores. */
(function () {
  "use strict";
  const { geo, WINDS, WIND_DEG, terrain } = window.WS;
  const FT = terrain.FT;

  function boxMean(src, w, h, r) {
    // separable box filter, NaN-aware
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; const v = src[y * w + xx]; if (!isNaN(v)) { s += v; n++; } }
        tmp[y * w + x] = n ? s / n : NaN;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; const v = tmp[yy * w + x]; if (!isNaN(v)) { s += v; n++; } }
        out[y * w + x] = n ? s / n : NaN;
      }
    }
    return out;
  }
  const AXES = [[1, 0], [0, 1], [1, 1], [1, -1]]; // E-W, N-S, diagonals (grid y grows south)
  const axisBearing = (dx, dy) => (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 180;

  // walk from (x,y) along (dx,dy) until pred fails; returns steps taken (capped)
  function run(x, y, dx, dy, pred, cap, w, h) {
    let i = 0;
    while (i < cap) {
      const nx = x + dx * (i + 1), ny = y + dy * (i + 1);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !pred(ny * w + nx)) break;
      i++;
    }
    return i;
  }
  // keep the best candidate per neighborhood
  function suppress(cands, radiusM, better) {
    const kept = [];
    cands.sort((a, b) => (better(a, b) ? -1 : 1)).forEach((c) => {
      if (!kept.some((k) => geo.dist(k.coords, c.coords) < radiusM)) kept.push(c);
    });
    return kept;
  }

  // weapon profiles: how close deer must pass, and how far an opening is still useful
  const WEAPONS = {
    bow: { key: "bow", label: "Bow", icon: "🏹", openMax: 0, windTol: 50 },
    muzzle: { key: "muzzle", label: "Muzzleloader", icon: "💥", openMax: 160, windTol: 45 },
    rifle: { key: "rifle", label: "Rifle", icon: "🎯", openMax: 320, windTol: 40 },
  };
  function weaponAdjust(c, WP) {
    const yd = (m) => Math.round(m * 1.09);
    if (WP.key === "bow") {
      if (c.kind === "neck") {
        if (c.widthM <= 40) { c.score += 10; c.reasons.push(`🏹 Narrow enough (~${yd(c.widthM)} yd) to cover the whole neck from one tree with a bow`); }
        else if (c.widthM <= 70) { c.score += 3; c.reasons.push(`🏹 At ~${yd(c.widthM)} yd wide, one tree covers most of it. Find the main trail`); }
        else { c.score -= 8; c.reasons.push(`🏹 Too wide (~${yd(c.widthM)} yd) to cover with a bow until you find the main trail through it`); }
      } else if (c.kind === "crossing") { c.score += 6; c.reasons.push("🏹 Crossings put deer on a predictable line, ideal for a 15–25 yd bow shot"); }
      else if (c.kind === "thicket") { c.score += 6; c.reasons.push("🏹 Thick-cover edges bring deer in close during daylight, a classic bow setup"); }
      else if (c.kind === "saddle" || c.kind === "bench") { c.score += 4; c.reasons.push("🏹 Terrain pinches deer onto one trail, so bow range is realistic"); }
      else if (c.kind === "island" || c.kind === "point") { c.score += 3; c.reasons.push("🏹 Trails leaving this high ground can put deer in bow range at first and last light"); }
    } else if (WP.key === "muzzle") {
      if (c.kind === "neck" && c.widthM <= 110) { c.score += 3; c.reasons.push(`💥 About ${yd(c.widthM)} yd wide: easy to cover with a muzzleloader`); }
    }
  }
  async function autoScout(bounds, features, opts) {
    const o = Object.assign({ style: "bottomland", wetPct: 0.35, max: 15, floodFt: null, weapon: "rifle" }, opts);
    const WP = WEAPONS[o.weapon] || WEAPONS.rifle;
    const g = await terrain.grid(bounds, 260);
    const { w, h } = g, N = w * h, cellM = g.cellM;
    const valid = Array.from(g.data).filter((v) => !isNaN(v)).length;
    if (valid < N * 0.6) throw new Error("Elevation didn't load for this view (offline?).");
    const sm = boxMean(g.data, w, h, 1);
    const p5 = terrain.percentile(sm, 0.05), p95 = terrain.percentile(sm, 0.95);
    const reliefFt = (p95 - p5) * FT;
    const flat = o.style === "bottomland" || o.style === "flat" || (o.style === "mixed" && reliefFt < 25);
    const R = Math.max(2, Math.round(160 / cellM));
    const local = boxMean(sm, w, h, R);
    const rel = new Float32Array(N);
    for (let k = 0; k < N; k++) rel[k] = sm[k] - local[k];
    const LL = (k) => g.toLatLng(k % w, (k / w) | 0);
    const cands = [];

    // ---------------------------------------------------------------- flat / bottomland
    let thr = null;
    const flatW = new Uint8Array(N); // open water (hydro-flattened DEM), filled in bottomland mode
    const isWaterAt = (p) => { const [i, j] = g.fromLatLng(p[0], p[1]); return flatW[j * w + i] === 1; };
    if (flat) {
      thr = o.floodFt != null ? o.floodFt / FT : terrain.percentile(sm, o.wetPct);
      const dry = (k) => sm[k] > thr, wet = (k) => !(sm[k] > thr);
      // open water: DEMs are hydro-flattened, so lakes/rivers read as dead-flat surfaces
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        const k = y * w + x; let mn = 1e9, mx = -1e9;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const v = g.data[k + j * w + i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mx - mn < 0.06 && wet(k)) flatW[k] = 1;
      }

      // 1) high-ground islands / ridges: connected blobs of locally high, dry ground
      const relHi = terrain.percentile(rel, 0.85);
      const seen = new Uint8Array(N);
      for (let k = 0; k < N; k++) {
        if (seen[k] || !(rel[k] > relHi) || !dry(k)) continue;
        const stack = [k], cells = []; seen[k] = 1;
        while (stack.length) {
          const c = stack.pop(); cells.push(c);
          const x = c % w, y = (c / w) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, nk = ny * w + nx;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[nk] && rel[nk] > relHi && dry(nk)) { seen[nk] = 1; stack.push(nk); }
          }
        }
        const acres = (cells.length * cellM * cellM) / 4046.86;
        if (acres < 1.5) continue;
        let top = cells[0];
        cells.forEach((c) => { if (rel[c] > rel[top]) top = c; });
        const lift = rel[top] * FT, aboveWater = (sm[top] - thr) * FT;
        cands.push({ kind: "island", coords: LL(top), acres, lift, aboveWater, base: 20 + Math.min(10, lift * 2) + Math.min(6, acres / 5),
          title: acres > 25 ? "High-ground ridge" : "High-ground island",
          reasons: [`${acres.toFixed(0)} ac of ground ${lift.toFixed(1)} ft above its surroundings, about ${aboveWater.toFixed(1)} ft above the wet-ground line`, "In the bottoms, deer bed on the highest, driest ground, especially if it's thick", "Check it for beds, droppings, and trails leading off the edges, and note how thick the cover is"] });
      }

      // 2) land bridges (narrow dry necks between wet ground) and 3) narrow slough crossings
      const maxW = Math.max(2, Math.round(90 / cellM)), needLen = Math.max(2, Math.round(50 / cellM));
      const maxX = Math.max(2, Math.round(45 / cellM)), chanLen = Math.max(3, Math.round(70 / cellM));
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const k = y * w + x;
          for (let a = 0; a < 4; a++) {
            const [dx, dy] = AXES[a], [px, py] = AXES[a === 0 ? 1 : a === 1 ? 0 : a === 2 ? 3 : 2];
            const diag = a >= 2 ? Math.SQRT2 : 1;
            if (dry(k)) {
              const l = run(x, y, -dx, -dy, dry, maxW, w, h), r = run(x, y, dx, dy, dry, maxW, w, h);
              const width = l + r + 1;
              if (width > maxW || l >= maxW || r >= maxW) continue;
              // must actually hit water on both sides, and stay dry along the perpendicular (a real bridge)
              const along1 = run(x, y, px, py, dry, needLen * 3, w, h), along2 = run(x, y, -px, -py, dry, needLen * 3, w, h);
              if (along1 < needLen || along2 < needLen) continue;
              // a real bridge opens up into bigger dry ground at both ends; a levee or road bed stays narrow
              const off = Math.min(along1, along2), wideAt = (sx, sy) => run(sx, sy, -dx, -dy, dry, maxW * 3, w, h) + run(sx, sy, dx, dy, dry, maxW * 3, w, h) + 1;
              const e1 = wideAt(x + px * off, y + py * off), e2 = wideAt(x - px * off, y - py * off);
              if (e1 < width * 2 || e2 < width * 2) continue;
              if (width < 2) continue; // 1-cell slivers are DEM noise
              cands.push({ kind: "neck", coords: LL(k), widthM: width * cellM * diag, axis: axisBearing(px, py), base: 0 });
            } else {
              if (flatW[k]) continue; // a river or lake isn't a deer crossing
              const l = run(x, y, -dx, -dy, wet, maxX, w, h), r = run(x, y, dx, dy, wet, maxX, w, h);
              const width = l + r + 1;
              if (width > maxX || l >= maxX || r >= maxX) continue;
              const c1 = run(x, y, px, py, wet, chanLen * 3, w, h), c2 = run(x, y, -px, -py, wet, chanLen * 3, w, h);
              if (c1 < chanLen || c2 < chanLen) continue;
              // travel crosses the channel, so the deer path runs along (dx,dy)
              cands.push({ kind: "crossing", coords: LL(k), widthM: width * cellM * diag, axis: axisBearing(dx, dy), base: 0 });
            }
          }
        }
      }
    } else {
      // ---------------------------------------------------------------- hill mode
      const rr = Math.max(2, Math.round(60 / cellM));
      const slope = new Float32Array(N);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        slope[k] = Math.atan(Math.hypot(sm[k + 1] - sm[k - 1], sm[k + w] - sm[k - w]) / (2 * cellM)) * 180 / Math.PI;
      }
      for (let y = rr; y < h - rr; y++) {
        for (let x = rr; x < w - rr; x++) {
          const k = y * w + x, c = sm[k];
          // saddle: 4+ sign changes around a ring, i.e. high-low-high-low
          let changes = 0, prev = null, hiMax = -1e9, loMin = 1e9;
          for (let i = 0; i <= 16; i++) {
            const t = (i % 16) / 16 * 2 * Math.PI, xx = Math.round(x + rr * Math.cos(t)), yy = Math.round(y + rr * Math.sin(t));
            const d = sm[yy * w + xx] - c;
            hiMax = Math.max(hiMax, d); loMin = Math.min(loMin, d);
            const s = d > 0.3 ? 1 : d < -0.3 ? -1 : 0;
            if (s !== 0) { if (prev !== null && s !== prev) changes++; prev = s; }
          }
          if (changes >= 4 && hiMax * FT > 6 && -loMin * FT > 6 && rel[k] > 0) {
            cands.push({ kind: "saddle", coords: LL(k), relief: Math.min(hiMax, -loMin) * FT, base: 0 });
            continue;
          }
          // bench: flat shelf with steep ground both above and below
          if (slope[k] < 5) {
            let up = false, down = false;
            for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
              for (const sgn of [1, -1]) {
                for (let i = 2; i <= rr; i++) {
                  const nk = (y + dy * i * sgn) * w + (x + dx * i * sgn);
                  if (slope[nk] > 14) { if (sm[nk] > c) up = true; else down = true; break; }
                }
              }
            }
            if (up && down) cands.push({ kind: "bench", coords: LL(k), base: 0 });
          }
        }
      }
      // ridge points (bedding)
      const relHi = terrain.percentile(rel, 0.97);
      for (let k = 0; k < N; k++) if (rel[k] > relHi && slope[k] < 12) cands.push({ kind: "point", coords: LL(k), lift: rel[k] * FT, base: 0 });
    }

    // ---------------------------------------------------------------- de-dupe and describe
    // ---------------------------------------------------------------- thick-cover patches (needs canopy data)
    const cover = o.cover;
    if (cover && cover.hasCanopy) {
      const isRegen = new Uint8Array(N);
      for (let k = 0; k < N; k++) {
        const v = cover.sample(...LL(k));
        if (v && v.cls === "regen" && (thr == null || sm[k] > thr)) isRegen[k] = 1;
      }
      const seen = new Uint8Array(N);
      for (let k = 0; k < N; k++) {
        if (!isRegen[k] || seen[k]) continue;
        const stack = [k], cells = []; seen[k] = 1;
        while (stack.length) {
          const c = stack.pop(); cells.push(c);
          const x = c % w, y = (c / w) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, nk = ny * w + nx;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[nk] && isRegen[nk]) { seen[nk] = 1; stack.push(nk); }
          }
        }
        const acres = (cells.length * cellM * cellM) / 4046.86;
        if (acres < 3) continue;
        // pick the cell deepest inside the patch (most regen neighbors) as the marker
        let best = cells[0], bestN = -1;
        cells.forEach((c) => { let n = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) n += isRegen[c + j * w + i] || 0; if (n > bestN) { bestN = n; best = c; } });
        const lift = thr != null ? (sm[best] - thr) * FT : null;
        cands.push({ kind: "thicket", coords: LL(best), acres, base: 24 + Math.min(10, acres / 4), title: "Thick-cover patch (bedding?)",
          reasons: [`About ${acres.toFixed(0)} ac of thick young growth, 2–8 m tall (regen, cutover, plantings, or brush)${lift != null ? `, on dry ground ${lift.toFixed(1)} ft above the wet line` : ""}`,
            "Does bed in the thickest cover close to food, and bucks cruise its downwind edge during the rut",
            "Walk the downwind edge only. Look for trails entering, beds, and rubs, and don't push through the middle"] });
      }
    }
    const islands = cands.filter((c) => c.kind === "island");
    let funnels = suppress(cands.filter((c) => c.kind === "neck"), 260, (a, b) => a.widthM < b.widthM).slice(0, 25);
    let crossings = suppress(cands.filter((c) => c.kind === "crossing"), 260, (a, b) => a.widthM < b.widthM).slice(0, 25);
    const saddles = suppress(cands.filter((c) => c.kind === "saddle"), 200, (a, b) => a.relief > b.relief).slice(0, 20);
    const benches = suppress(cands.filter((c) => c.kind === "bench"), 250, () => Math.random() < 0.5).slice(0, 15);
    const points = suppress(cands.filter((c) => c.kind === "point"), 300, (a, b) => a.lift > b.lift).slice(0, 12);
    const nearIsland = (c) => islands.map((i) => ({ i, d: geo.dist(c.coords, i.coords) })).sort((a, b) => a.d - b.d)[0];
    funnels.forEach((c) => {
      c.title = "Land bridge / pinch point";
      c.base = 26 + Math.max(0, 12 - c.widthM / 8);
      c.reasons = [`Dry neck only about ${Math.round(c.widthM * 1.09)} yd wide with wet ground on both sides`, "Deer moving through the bottoms get squeezed through here, a natural funnel", "Look for a trail worn through the neck, and rubs and scrapes along it"];
    });
    crossings.forEach((c) => {
      c.title = "Narrow slough crossing";
      c.base = 26 + Math.max(0, 12 - c.widthM / 4);
      c.reasons = [`Low channel narrows to about ${Math.round(c.widthM * 1.09)} yd here`, "Deer cross sloughs and brakes at their narrowest, shallowest spots, along with logs and beaver dams", "Check the banks for a muddy, tracked-up crossing"];
    });
    saddles.forEach((c) => { c.title = "Saddle"; c.base = 30 + Math.min(8, c.relief / 5); c.reasons = [`Low gap in a ridge with about ${Math.round(c.relief)} ft of rise on either side`, "Deer cross ridges at saddles to save energy, a classic rut crossing", "Look for trails converging through the low point"]; });
    benches.forEach((c) => { c.title = "Side-hill bench"; c.base = 22; c.reasons = ["Flat shelf with steep ground above and below", "Bucks travel benches to cruise a hillside downwind of bedding", "Check for a trail along the bench and rubs on the uphill side"]; });
    points.forEach((c) => { c.title = "Ridge point (bedding?)"; c.base = 20; c.reasons = [`Point sitting ${c.lift.toFixed(0)} ft above the surrounding ground`, "Bucks bed on points with the wind at their back and a view below", "Approach from below with care, and look for beds near the tip"]; });
    const thickets = suppress(cands.filter((c) => c.kind === "thicket"), 350, (a, b) => a.acres > b.acres).slice(0, 15);
    let all = islands.concat(thickets, funnels, crossings, saddles, benches, points);

    // ---------------------------------------------------------------- cover-aware reasoning
    function around(c, rM) {
      const f = { open: 0, regen: 0, pole: 0, mature: 0, water: 0, canopy: 0, n: 0 }, hs = [];
      for (let dy = -rM; dy <= rM; dy += rM / 3) for (let dx = -rM; dx <= rM; dx += rM / 3) {
        if (dx * dx + dy * dy > rM * rM) continue;
        const p = [c.coords[0] + dy / 110540, c.coords[1] + dx / (111320 * Math.cos(c.coords[0] * Math.PI / 180))];
        const v = cover.sample(p[0], p[1]);
        if (!v || !v.cls) continue;
        f[v.cls]++; f.n++; if (v.h != null && v.cls !== "water") hs.push(v.h);
      }
      if (f.n) Object.keys(f).forEach((k) => { if (k !== "n") f[k] /= f.n; });
      f.medH = hs.length ? hs.sort((a, b) => a - b)[hs.length >> 1] : null;
      return f;
    }
    function coverReasons(c) {
      const f = around(c, c.kind === "island" || c.kind === "point" ? 90 : 50);
      if (!f.n) return;
      const pct = (x) => Math.round(x * 100);
      if (c.kind === "island" || c.kind === "point") {
        if (f.regen > 0.35) { c.score += 12; c.reasons.push(`${pct(f.regen)}% thick young growth (2–8 m): bedding cover on high ground, the best combination`); }
        else if (f.open > 0.5) { c.score -= 10; c.reasons.push(`Mostly open ground (${pct(f.open)}%), so deer likely won't bed here in daylight`); }
        else if (f.mature > 0.6) { c.score -= 3; c.reasons.push(`Mostly mature timber (${pct(f.mature)}%, ~${f.medH} m tall). Likely an open understory, better for travel and acorns than bedding`); }
        if (f.mature > 0.5 && f.medH >= 18) c.reasons.push("Tall mature canopy on high ground could be an acorn flat. Check for red oaks and overcup still dropping");
      } else if (c.kind !== "thicket") {
        const here = cover.sample(...c.coords);
        if (here && here.cls === "open") { c.score -= WP.key === "bow" ? 10 : 6; c.reasons.push("The funnel itself is open ground, so expect mostly after-dark crossings unless it's thick on both sides"); }
        else if (f.regen + f.pole + f.mature > 0.7) { c.score += WP.key === "bow" ? 8 : 4; c.reasons.push(WP.key === "bow" ? "Covered travel: deer move through here in daylight and close, good for a bow" : "Covered travel: trees or brush on the funnel"); }
        if (f.regen > 0.2 && f.mature > 0.2) { c.score += 6; c.reasons.push("Thicket meets mature timber here. Edges like this are buck travel routes"); }
      }
      // rifle: find the best opening within 300 m (shooting lane / cutover / field edge)
      if (WP.openMax && ["neck", "crossing", "saddle", "bench", "thicket"].includes(c.kind)) {
        let best = null;
        for (let b = 0; b < 360; b += 22.5) {
          let run = 0, start = null, bestRun = 0, bestStart = null;
          for (let d = 30; d <= WP.openMax; d += 15) {
            const p = geo.dest(c.coords, b, d), v = cover.sample(p[0], p[1]);
            if (v && v.cls === "open" && !isWaterAt(p)) { if (start == null) start = d; run += 15; if (run > bestRun) { bestRun = run; bestStart = start; } }
            else { run = 0; start = null; }
          }
          if (bestRun >= 45 && (!best || bestRun > best.len)) best = { b, len: bestRun, at: bestStart };
        }
        if (best) {
          c.opening = best;
          c.score += 5;
          c.reasons.push(`Opening about ${Math.round(best.at * 1.09)} yd ${geo.compass(best.b)}, roughly ${Math.round(best.len * 1.09)} yd across. That's a ${WP.label.toLowerCase()} lane or cutover edge to watch the funnel from`);
        }
      }
    }

    // ---------------------------------------------------------------- weigh in your marks
    const byType = (...t) => features.filter((f) => t.includes(f.type));
    const access = byType("parking", "boat", "road", "atv", "check");
    const signs = byType("rub", "scrape", "tracks", "bed", "sighting", "buck", "trail", "rubline");
    const foods = byType("food", "foodpt"), beds = byType("bedding", "bedpt", "thicket"), nogo = byType("nogo");
    all = all.filter((c) => !nogo.some((f) => f.geom.type === "Polygon" && geo.pointInPoly(c.coords, f.geom.coords)));
    all.forEach((c) => {
      c.score = c.base;
      if (access.length) {
        const d = Math.min(...access.map((f) => geo.distToFeature(c.coords, f).d));
        c.accessM = d;
        if (d > 800) { c.score += 14; c.reasons.push(`${(d / 1609).toFixed(1)} mi from the nearest road, parking, or ATV trail you've marked. Most hunters won't walk this far`); }
        else if (d > 400) { c.score += 7; c.reasons.push(`${Math.round(d * 1.09)} yd from marked access: far enough to cut down pressure`); }
        else if (d < 120) { c.score -= 8; c.reasons.push(`Only ${Math.round(d * 1.09)} yd from marked access, so it likely gets pressured`); }
      }
      const s = signs.filter((f) => geo.distToFeature(c.coords, f).d < 160);
      if (s.length) { c.score += Math.min(16, s.length * 4); c.reasons.push(`${s.length} piece(s) of sign you've logged within 175 yd`); }
      if (foods.some((f) => geo.distToFeature(c.coords, f).d < 400)) { c.score += 6; c.reasons.push("Close to a food source you've marked"); }
      if (beds.some((f) => geo.distToFeature(c.coords, f).d < 400)) { c.score += 6; c.reasons.push("Close to bedding/thick cover you've marked"); }
      if ((c.kind === "neck" || c.kind === "crossing") && islands.length) {
        const ni = nearIsland(c);
        if (ni && ni.d < 500) { c.score += 10; c.bedRef = ni.i.coords; c.reasons.push(`${Math.round(ni.d * 1.09)} yd from a high-ground bedding candidate, so it connects bedding to the rest of the bottom`); }
      }
      if (cover) coverReasons(c);
      weaponAdjust(c, WP);
      c.score = Math.round(c.score);
    });
    all.sort((a, b) => b.score - a.score);
    // pick the best, with a small penalty for repeating the same kind so you get a mix of spot types
    const pool = suppress(all, 150, (a, b) => a.score > b.score), top = [], kindN = {};
    while (top.length < o.max && pool.length) {
      let bi = 0, bv = -1e9;
      pool.forEach((c, i) => { const v = c.score - 5 * (kindN[c.kind] || 0); if (v > bv) { bv = v; bi = i; } });
      const c = pool.splice(bi, 1)[0]; top.push(c); kindN[c.kind] = (kindN[c.kind] || 0) + 1;
    }

    // ---------------------------------------------------------------- rifle setup ideas at the best funnels
    top.forEach((c) => {
      if (!["neck", "crossing", "saddle", "bench", "thicket"].includes(c.kind)) return;
      const sensitive = [];
      if (c.axis != null) sensitive.push(c.axis, (c.axis + 180) % 360); // deer approach from both ends
      const bedB = c.bedRef ? geo.bearing(c.coords, c.bedRef) : null;
      if (bedB != null) sensitive.push(bedB);
      c.goodWinds = WINDS.filter((wd) => { const scent = (WIND_DEG[wd] + 180) % 360; return !sensitive.some((b) => geo.angDiff(scent, b) < WP.windTol); });
      if (c.kind === "thicket") {
        c.goodWinds = WINDS.slice();
        c.setup = WP.key === "bow"
          ? "Hang a stand 15–25 yd off the downwind edge, on a trail entering the thicket. Go 20+ ft up and trim 2–3 shooting lanes to the trail. Bucks scent-check this edge during the rut."
          : c.opening
          ? `Sit the downwind edge of the thicket where you can see the opening ${Math.round(c.opening.at * 1.09)} yd ${geo.compass(c.opening.b)}. Bucks scent-check the edge during the rut, and you get a ${WP.label.toLowerCase()} shot across the opening.`
          : "Sit the downwind edge on a trail entering the thicket. Pick your spot by the day's wind, and keep your scent from blowing into the cover.";
        c.windNote = "Any wind works if you choose the downwind side that day";
        c.hunt = true;
        return;
      }
      const travel = c.axis != null ? `${geo.compass(c.axis)}–${geo.compass((c.axis + 180) % 360)}` : null;
      if (WP.key === "bow") {
        c.setup = `Hang 15–25 yd off the ${c.kind === "crossing" ? "crossing" : "narrowest part of the funnel"}${bedB != null ? " on the side away from the bedding" : ""}, downwind of the main trail${travel ? ` (travel runs ${travel})` : ""}. Trim 2–3 shooting lanes to the trail.${c.kind === "neck" && c.widthM > 40 ? ` At about ${Math.round(c.widthM * 1.09)} yd wide, find the main trail first and set up on it.` : ""}`;
        c.hunt = c.goodWinds.length > 0;
        return;
      }
      if (WP.key === "muzzle") {
        c.setup = `Set up 30–100 yd off the funnel${bedB != null ? " on the side away from the bedding" : ""}, with a lane down the travel line${travel ? ` (${travel})` : ""}.${c.opening ? ` Opening ${Math.round(c.opening.at * 1.09)} yd ${geo.compass(c.opening.b)} makes a good lane.` : " Look for a gap or edge giving you 60–120 yd of visibility."}`;
        c.hunt = c.goodWinds.length > 0;
        return;
      }
      c.setup = c.axis != null
        ? `Set up 40–120 yd off the funnel on the side${bedB != null ? " away from the bedding" : ""}, with a shooting lane down the travel line (it runs ${geo.compass(c.axis)}–${geo.compass((c.axis + 180) % 360)}). Look for an opening, cutover edge, or long hardwood lane to stretch a rifle shot.`
        : "Set up off to the downwind side, where you can see the crossing and the trails feeding it.";
      if (c.opening) c.setup += ` Best lane found: an opening ${Math.round(c.opening.at * 1.09)} yd ${geo.compass(c.opening.b)} of the funnel.`;
      c.hunt = c.goodWinds.length > 0;
    });
    return { candidates: top, stats: { weapon: WP.key, cover: cover ? { canopy: cover.hasCanopy, shots: cover.shots } : null, reliefFt, mode: flat ? "bottomland" : "hill", thrFt: thr != null ? thr * FT : null, cellM, found: all.length } };
  }

  // split spots into n day-groups by location (k-means) so each scouting day covers one area
  function groupByArea(cands, n) {
    if (n <= 1 || cands.length <= n) return cands.map((_, i) => i % Math.max(1, n));
    let cent = cands.slice(0, n).map((c) => c.coords.slice());
    // spread initial centers: farthest-point seeding
    cent = [cands[0].coords.slice()];
    while (cent.length < n) {
      let best = null, bd = -1;
      cands.forEach((c) => { const d = Math.min(...cent.map((m) => geo.dist(m, c.coords))); if (d > bd) { bd = d; best = c; } });
      cent.push(best.coords.slice());
    }
    let asg = [];
    for (let it = 0; it < 20; it++) {
      asg = cands.map((c) => cent.map((m, i) => [geo.dist(m, c.coords), i]).sort((a, b) => a[0] - b[0])[0][1]);
      cent = cent.map((m, i) => {
        const mem = cands.filter((_, j) => asg[j] === i);
        return mem.length ? geo.centroid(mem.map((c) => c.coords)) : m;
      });
    }
    return asg;
  }

  window.WS = Object.assign(window.WS || {}, { autoscout: { autoScout, groupByArea, WEAPONS } });
})();
