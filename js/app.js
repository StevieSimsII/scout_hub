/* Scout Hub — multi-property scouting & hunt planner. UI, map, and state wiring. */
(async function () {
  "use strict";
  const { TYPES, TYPE, WINDS, WIND_DEG, geo, fmt, uid, esc, store, astro, terrain, analysis, io } = window.WS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ================================================================== reference data
  const LAND_TYPES = {
    wma: "State WMA", nwr: "National Wildlife Refuge", nf: "National Forest", state: "Other state land",
    private: "Private land", lease: "Lease / hunting club",
  };
  const TERRAIN_STYLES = { bottomland: "Bottomland / Delta / river swamp", hill: "Hills / ridges / hollows", mixed: "Mixed / farm country", flat: "Flatwoods / pine" };
  const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
  const REG_TEMPLATES = {
    wma: ["Season/draw permit & WMA user permit in hand", "Check-in / check-out and permit-card rules", "Stand rules: when stands can be placed and removed, and whether they can be left overnight", "ATV/UTV: designated trails only? Dates and hours?", "Trail-camera rules", "Flagging / reflective tack rules", "Earliest entry time before legal light", "Flood / river-stage closure triggers", "Antler restriction & bag limits for this unit", "Baiting/feeding prohibited?", "Blaze orange requirement"],
    nwr: ["Refuge hunt permit / signed brochure (often required on your person)", "Quota hunt or open hunt? Check-station requirements", "Portable stands only? Placement/removal rules", "Cameras usually prohibited: check", "Flagging/tacks only of approved type, if at all", "Closed areas & sanctuaries marked on the map", "ATV trails and seasons", "Entry hours (often no earlier than 4 AM)", "No baiting, no cutting vegetation", "Refuge-specific bag limits and antler rules"],
    nf: ["State license + any NF-specific permit", "ATV per Motor Vehicle Use Map (MVUM) only", "Stand-removal rules (e.g. no permanent stands)", "Camping/dispersed rules if staying", "Adjacent private boundaries marked"],
    state: ["Permit / access requirements", "Stand, camera, and flagging rules", "ATV/vehicle access", "Entry hours", "Bag & antler rules"],
    private: ["Written permission / landowner contact on you", "Boundary lines walked and marked on the map", "Neighbor contacts and where their stands are", "Gate codes / lock combos", "Emergency address for 911", "Harvest rules (QDM, doe limits)", "Baiting/feeding legal in this state and county?"],
    lease: ["Lease agreement & club rules on you", "Sign-in board / stand assignment rules", "Club harvest rules (points, spread, does)", "Guest rules", "Boundary lines & neighbors", "Gate codes, camp rules, emergency address", "Food plot / feeder rules"],
  };
  const DEFAULT_CENTER = [32.47, -90.912]; // Ten Point unit core, from the "10 pt unit" pins in your onX export

  // ================================================================== dates & time zones
  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
  const dayDiff = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
  function tzOffsetMin(date, tz) {
    const s = date.toLocaleString("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const [d, t] = s.split(", "), [mo, da, yr] = d.split("/");
    let [h, mi, se] = t.split(":"); if (h === "24") h = "00";
    return (Date.UTC(+yr, +mo - 1, +da, +h, +mi, +se) - date.getTime()) / 6e4;
  }
  // midnight in the property's time zone, for astronomical calcs
  const tzMidnight = (s) => { const [y, m, d] = s.split("-").map(Number); const guess = Date.UTC(y, m - 1, d); return new Date(guess - tzOffsetMin(new Date(guess + 12 * 36e5), P.tz) * 6e4); };
  const dayLabel = (s) => parseDay(s).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const dowOf = (s) => parseDay(s).toLocaleDateString([], { weekday: "short" });

  // ================================================================== plan templates
  const SCOUT_TEMPLATES = [
    { title: "Big-picture recon", tasks: (p) => [
      ...(p.landType === "wma" || p.landType === "nwr" ? ["Check in / pick up permit card and confirm current scouting & entry rules"] : ["Check in with landowner / club; confirm where others are hunting"]),
      ...(p.terrainStyle === "bottomland" ? ["Check river stage + backwater forecast; set the Flood slider to match"] : []),
      "Drive/ride legal roads & trails at first light; log parking spots, gates, and other hunters' vehicles",
      "Walk the edges of the top food sources — check for fresh feeding & droppings",
      "Time every walk-in from parking/boat launch to candidate stands",
      "Evening: glass an opening or edge from a distance; log every deer seen and its direction",
    ] },
    { title: "Sign & corridors", tasks: () => [
      "Run the corridor model, then walk each predicted lane — confirm (log sign) or kill it",
      "Inspect every magenta hotspot / funnel / crossing the model flagged",
      "Log every scrape (licking branch? fresh?), rub (diameter), track line, and crossing",
      "Midday: work bedding EDGES only — never push through the interior",
      "Pick a primary + backup stand for each likely wind",
      "Draw entry & exit routes that keep your scent off bedding",
    ] },
    { title: "Finalize & stay quiet", tasks: () => [
      "Light touch only — no new ground near your best stands",
      "Confirm entry/exit routes (reflective tacks only if the rules allow)",
      "Prep stand sites midday (minimal lane trimming; follow the property's stand rules)",
      "Pull the NWS forecast (Deer Intel tab) and assign sits by wind",
      "Evening observation sit from long range on the best food/edge",
      "Gear check: license, permits, blaze orange, headlamp, drag rope, wind checker",
    ] },
  ];
  const HUNT_TASKS = [
    "Enter by headlamp before legal shooting light; check wind at the truck",
    "Log every deer seen (Field Log) with time & direction",
    "Midday: hold during peak rut — bucks move 10 am–2 pm",
    "Re-check wind before the PM sit; switch stands if it shifted",
  ];
  function scoutTemplateFor(i, n) { // first = recon, last = finalize, middle = sign
    if (n === 1) return { title: "Recon & sign", tasks: (p) => SCOUT_TEMPLATES[0].tasks(p).slice(0, 3).concat(SCOUT_TEMPLATES[1].tasks().slice(0, 3)) };
    if (i === 0) return SCOUT_TEMPLATES[0];
    if (i === n - 1) return SCOUT_TEMPLATES[2];
    return SCOUT_TEMPLATES[1];
  }
  const blankForecast = () => ({ am: "", amSpd: "", pm: "", pmSpd: "", hi: "", lo: "", front: false, src: "" });
  function buildDays(prop, hunt) {
    const days = [];
    const nScout = hunt.scoutStart ? Math.max(0, dayDiff(hunt.scoutStart, hunt.start)) : 0;
    for (let i = 0; i < nScout; i++) {
      const date = addDays(hunt.scoutStart, i), t = scoutTemplateFor(i, nScout);
      days.push({ date, kind: "scout", dow: dowOf(date), title: t.title, tasks: t.tasks(prop).map((x) => ({ id: uid(), text: x, done: false })), notes: "", forecast: blankForecast(), sits: {}, routeStart: "" });
    }
    const nHunt = Math.max(1, dayDiff(hunt.start, hunt.end) + 1);
    for (let i = 0; i < Math.min(nHunt, 30); i++) {
      const date = addDays(hunt.start, i);
      days.push({ date, kind: "hunt", dow: dowOf(date), title: "Hunt day", tasks: HUNT_TASKS.map((x) => ({ id: uid(), text: x, done: false })), notes: "", forecast: blankForecast(), sits: {}, routeStart: "" });
    }
    return days;
  }
  // keep existing day data when dates change; add/remove days as needed
  function rebuildDays(prop, hunt) {
    const old = new Map((hunt.days || []).map((d) => [d.date, d]));
    hunt.days = buildDays(prop, hunt).map((d) => (old.has(d.date) && old.get(d.date).kind === d.kind ? old.get(d.date) : d));
  }

  const defaultTerrain = () => ({ relief: false, hillshade: false, flood: false, opRelief: 0.55, opHill: 0.8, opFlood: 0.7, lo: 80, hi: 100, floodFt: 85, exag: 12 });
  function newProperty(o = {}) {
    const p = Object.assign({
      id: uid(), name: "New property", landType: "wma", state: "", tz: "America/Chicago", terrainStyle: "mixed",
      center: null, zoom: 14, homeSet: false, conception: "11-15", legalMin: 30, gaugeUrl: "", notes: "",
      features: [], imports: [], overlays: [], model: null, terrain: defaultTerrain(), hunts: [], activeHuntId: "",
    }, o);
    p.terrain = Object.assign(defaultTerrain(), p.terrain || {});
    if (!p.regs) p.regs = (REG_TEMPLATES[p.landType] || []).map((t) => ({ id: uid(), text: t, done: false }));
    return p;
  }
  function newHunt(prop, o = {}) {
    const h = Object.assign({ id: uid(), name: "Hunt", scoutStart: "", start: isoDay(new Date()), end: isoDay(new Date()) }, o);
    if (!h.days) rebuildDays(prop, h);
    return h;
  }
  function tenPointExample() {
    const p = newProperty({ name: "Phil Bryant WMA – Ten Point", landType: "wma", state: "MS", tz: "America/Chicago", terrainStyle: "bottomland",
      center: DEFAULT_CENTER, conception: "12-27", gaugeUrl: "https://water.noaa.gov/gauges/vckm6",
      notes: "Issaquena/Warren Cos. Permit cards at the west Ten Point check station on Hwy 465. Your onX export (95 pins/tracks incl. 18 scrapes from Nov 2023) is included: Data → Import → data/onx/ten-point-onx-export.kml.", zoom: 14 });
    p.regs.unshift({ id: uid(), text: "Permit card from the west Ten Point check station (Hwy 465)", done: false });
    const h = newHunt(p, { name: "Gun draw hunt", scoutStart: "2026-12-14", start: "2026-12-17", end: "2026-12-20", weapon: "rifle" });
    p.hunts.push(h); p.activeHuntId = h.id;
    return p;
  }
  const DEFAULT_GEAR = () => [
    "Hunting license + any land permits", "Draw / quota permit or permit card", "Blaze orange (meet state minimum)", "Rifle/muzzleloader/bow + ammo (per property rules)",
    "Headlamp + spare", "Phone + battery bank (onX offline maps downloaded)", "Wind checker", "Knee boots / waders", "Climber or harness + lifeline",
    "Drag rope, knife, gloves", "Trail flagging/tacks (only where allowed)", "Rain gear", "Snacks & water",
  ].map((t) => ({ id: uid(), text: t, done: false }));
  const DEFAULT_STATE = () => {
    const p = tenPointExample();
    return { version: 2, activePropertyId: p.id, properties: [p], settings: { hunters: "Me", labels: true, basemap: "sat", ref: true }, gear: DEFAULT_GEAR(), wind: "", modelOpts: { rut: true, useFlood: false, lowWeight: 4 } };
  };
  // v1 (single-hunt WMA Scout) -> v2
  function migrate(s) {
    if (!s) return DEFAULT_STATE();
    if (s.version === 2 && s.properties) return s;
    const p = tenPointExample();
    Object.assign(p, { features: s.features || [], imports: s.imports || [], overlays: s.overlays || [], model: s.model || null, terrain: Object.assign(defaultTerrain(), s.terrain || {}) });
    if (s.settings) { p.center = s.settings.center || p.center; p.zoom = s.settings.zoom || p.zoom; p.homeSet = !!s.settings.homeSet; if (s.settings.conception) p.conception = s.settings.conception.slice(5); }
    if (s.days) p.hunts[0].days = s.days.map((d) => Object.assign({ dow: dowOf(d.date) }, d));
    return { version: 2, activePropertyId: p.id, properties: [p], settings: Object.assign({ hunters: "Me", labels: true, basemap: "sat", ref: true }, s.settings || {}), gear: s.gear || DEFAULT_GEAR(), wind: s.wind || "", modelOpts: s.modelOpts || { rut: true, useFlood: false, lowWeight: 4 } };
  }

  // ================================================================== state
  let S = migrate(await store.get("state").catch(() => null));
  S.settings = Object.assign({ hunters: "Me", labels: true, basemap: "sat", ref: true }, S.settings);
  let P = null, H = null; // active property & hunt
  const NO_HUNT = { id: "", name: "", days: [] };
  function bindActive() {
    P = S.properties.find((p) => p.id === S.activePropertyId) || S.properties[0];
    if (!P) { P = newProperty({ name: "My first property", center: DEFAULT_CENTER }); S.properties.push(P); }
    S.activePropertyId = P.id;
    P.terrain = Object.assign(defaultTerrain(), P.terrain);
    H = P.hunts.find((h) => h.id === P.activeHuntId) || P.hunts[0] || NO_HUNT;
    window.WS.tz = P.tz;
    window.WS.weapon = curWeapon();
  }
  function curWeapon() { return (H && H.weapon) || P.weapon || "rifle"; }
  function setWeapon(w) { if (H && H.id) H.weapon = w; else P.weapon = w; window.WS.weapon = w; save(); }
  bindActive();
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => store.set("state", JSON.parse(JSON.stringify(S))).catch((e) => toast("Save failed: " + e.message)), 300); };
  const featById = (id) => P.features.find((f) => f.id === id);
  // conception is stored as MM-DD (a regional constant); pick the instance nearest the active hunt
  function conceptionDate() {
    const [m, d] = (P.conception || "11-15").split("-").map(Number);
    const ref = H.start ? parseDay(H.start) : new Date();
    return [-1, 0, 1].map((k) => new Date(ref.getFullYear() + k, m - 1, d)).sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
  }
  const huntMid = () => (H.start ? new Date((parseDay(H.start).getTime() + parseDay(H.end).getTime()) / 2) : new Date());

  function dayRep(date) {
    const c = map.getCenter(), r = astro.dayReport(tzMidnight(date), c.lat, c.lng), lm = (P.legalMin ?? 30) * 6e4;
    r.legalStart = new Date(r.sunrise.getTime() - lm); r.legalEnd = new Date(r.sunset.getTime() + lm);
    return r;
  }

  function toast(msg, ms = 2600) {
    const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add("hidden"), ms);
  }

  // ================================================================== map
  const map = L.map("map", { zoomControl: true, center: P.center || DEFAULT_CENTER, zoom: P.zoom, maxZoom: 20, preferCanvas: false });
  const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const usgs = (svc) => `https://basemap.nationalmap.gov/arcgis/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const BASEMAPS = {
    sat: { name: "Satellite (Esri World Imagery)", url: esri("World_Imagery"), max: 19, attr: "Imagery © Esri, Maxar, Earthstar, USDA" },
    naip: { name: "USGS Imagery (NAIP)", url: usgs("USGSImageryOnly"), max: 16, attr: "USGS The National Map" },
    imgtopo: { name: "USGS Imagery + Topo", url: usgs("USGSImageryTopo"), max: 16, attr: "USGS The National Map" },
    topo: { name: "USGS Topo (contours)", url: usgs("USGSTopo"), max: 16, attr: "USGS The National Map" },
    esritopo: { name: "Esri World Topo", url: esri("World_Topo_Map"), max: 19, attr: "© Esri" },
    otm: { name: "OpenTopoMap", url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", max: 17, attr: "© OpenStreetMap, SRTM | OpenTopoMap (CC-BY-SA)" },
  };
  const baseLayers = {};
  Object.entries(BASEMAPS).forEach(([k, b]) => (baseLayers[k] = L.tileLayer(b.url, { maxNativeZoom: b.max, maxZoom: 20, attribution: b.attr, crossOrigin: false })));
  const refLayer = L.layerGroup([
    L.tileLayer(esri("Reference/World_Transportation"), { maxNativeZoom: 19, maxZoom: 20, opacity: 0.85 }),
    L.tileLayer(esri("Reference/World_Boundaries_and_Places"), { maxNativeZoom: 19, maxZoom: 20 }),
  ]);
  let curBase = null;
  function setBase(k) {
    if (curBase) map.removeLayer(curBase);
    curBase = baseLayers[k] || baseLayers.sat; curBase.addTo(map); curBase.bringToBack();
    S.settings.basemap = k; save();
  }
  setBase(S.settings.basemap);
  if (S.settings.ref) refLayer.addTo(map);

  map.createPane("terrain"); map.getPane("terrain").style.zIndex = 350;
  map.createPane("overlayImg"); map.getPane("overlayImg").style.zIndex = 360;
  map.createPane("cones"); map.getPane("cones").style.zIndex = 390;
  const reliefL = terrain.makeLayer("relief", L, { pane: "terrain", opacity: P.terrain.opRelief });
  const hillL = terrain.makeLayer("hillshade", L, { pane: "terrain", opacity: P.terrain.opHill });
  const floodL = terrain.makeLayer("flood", L, { pane: "terrain", opacity: P.terrain.opFlood });
  Object.assign(terrain.settings, { lo: P.terrain.lo, hi: P.terrain.hi, flood: P.terrain.floodFt, exag: P.terrain.exag });
  function syncTerrain() {
    [[reliefL, "relief"], [hillL, "hillshade"], [floodL, "flood"]].forEach(([l, k]) => {
      if (P.terrain[k] && !map.hasLayer(l)) l.addTo(map);
      if (!P.terrain[k] && map.hasLayer(l)) map.removeLayer(l);
    });
    reliefL.setOpacity(P.terrain.opRelief); hillL.setOpacity(P.terrain.opHill); floodL.setOpacity(P.terrain.opFlood);
    renderLegend();
  }
  let redrawT = null;
  function redrawTerrain(which) {
    Object.assign(terrain.settings, { lo: P.terrain.lo, hi: P.terrain.hi, flood: P.terrain.floodFt, exag: P.terrain.exag });
    clearTimeout(redrawT);
    redrawT = setTimeout(() => { (which || [reliefL, hillL, floodL]).forEach((l) => map.hasLayer(l) && l.redraw()); renderLegend(); }, 120);
  }
  syncTerrain();

  const gImports = L.layerGroup().addTo(map);
  const gOverlays = L.layerGroup().addTo(map);
  const gModel = L.layerGroup().addTo(map);
  const gAuto = L.layerGroup().addTo(map);
  const gCones = L.layerGroup().addTo(map);
  const gRoute = L.layerGroup().addTo(map);
  const gHeat = L.layerGroup();
  const gFeatures = L.layerGroup().addTo(map);
  const gEdit = L.layerGroup().addTo(map);
  const gMe = L.layerGroup().addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  // locate control
  const LocateCtl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar");
      d.innerHTML = '<a href="#" title="Show my location" style="font-size:16px">◎</a><a href="#" title="Home view" style="font-size:15px">⌂</a>';
      L.DomEvent.disableClickPropagation(d);
      d.children[0].onclick = (e) => { e.preventDefault(); startGPS(true); };
      d.children[1].onclick = (e) => { e.preventDefault(); map.setView(P.center || DEFAULT_CENTER, P.zoom); };
      return d;
    },
  });
  map.addControl(new LocateCtl());

  map.on("moveend", () => { if (!P.homeSet) { P.center = [map.getCenter().lat, map.getCenter().lng]; P.zoom = map.getZoom(); save(); } });

  // ================================================================== feature rendering
  let sel = null;
  function pinIcon(f) {
    const t = TYPE[f.type];
    const lbl = S.settings.labels && f.name ? `<span class="lbl">${esc(f.name)}</span>` : "";
    return L.divIcon({ className: "", html: `<div class="pin${sel === f.id ? " sel" : ""}">${t.icon}${lbl}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  }
  function popupHtml(f) {
    const t = TYPE[f.type];
    let extra = "";
    if (f.geom.type === "LineString") extra = `<br><span class="muted">${fmt.yd(geo.lineLength(f.geom.coords))}</span>`;
    if (f.geom.type === "Polygon") extra = `<br><span class="muted">${fmt.acres(geo.areaM2(f.geom.coords))}</span>`;
    return `<b>${t.icon} ${esc(f.name || t.label)}</b><br><span class="muted">${esc(t.label)}${f.created ? " · " + new Date(f.created).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>${extra}${f.notes ? `<p>${esc(f.notes)}</p>` : ""}`;
  }
  function renderFeatures() {
    gFeatures.clearLayers(); gEdit.clearLayers();
    // areas first, then lines, then points on top
    const order = { Polygon: 0, LineString: 1, Point: 2 };
    P.features.slice().sort((a, b) => order[a.geom.type] - order[b.geom.type]).forEach((f) => {
      const t = TYPE[f.type] || TYPE.note, isSel = sel === f.id;
      let l;
      if (f.geom.type === "Point") {
        l = L.marker(f.geom.coords, { icon: pinIcon(f), draggable: isSel, zIndexOffset: isSel ? 1000 : 0, riseOnHover: true });
        l.on("dragend", (e) => { const p = e.target.getLatLng(); f.geom.coords = [p.lat, p.lng]; save(); afterGeomChange(); });
      } else if (f.geom.type === "LineString") {
        l = L.polyline(f.geom.coords, { color: t.color, weight: isSel ? 6 : 4, dashArray: t.dash, opacity: 0.95 });
      } else {
        l = L.polygon(f.geom.coords, { color: t.color, weight: isSel ? 3 : 2, fillOpacity: isSel ? 0.3 : 0.16, dashArray: t.dash });
      }
      l.on("click", (e) => { L.DomEvent.stopPropagation(e); if (draw) return onMapClick(e); select(f.id); });
      l.bindTooltip(`${t.icon} ${esc(f.name || t.label)}`, { sticky: true, direction: "top", opacity: 0.9 });
      l.addTo(gFeatures);
      if (isSel && f.geom.type !== "Point") vertexHandles(f);
    });
    renderCones();
  }
  function vertexHandles(f) {
    f.geom.coords.forEach((c, i) => {
      const m = L.marker(c, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="vertex"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }), title: "Drag to move · right-click/long-press to delete" });
      m.on("drag", (e) => { const p = e.target.getLatLng(); f.geom.coords[i] = [p.lat, p.lng]; });
      m.on("dragend", () => { save(); renderFeatures(); afterGeomChange(); });
      m.on("contextmenu", () => {
        const min = f.geom.type === "Polygon" ? 3 : 2;
        if (f.geom.coords.length <= min) return toast("Can't remove — shape needs more points.");
        f.geom.coords.splice(i, 1); save(); renderFeatures(); afterGeomChange();
      });
      m.addTo(gEdit);
    });
  }
  function afterGeomChange() { renderEditor(); if ($("#panel-intel").classList.contains("active")) renderIntel(); }

  function select(id, opts = {}) {
    sel = id;
    renderFeatures();
    if (id) { showTab("mark"); renderMark(); if (opts.pan) { const f = featById(id); if (f) map.panTo(geo.featureAnchor(f)); } }
    else renderMark();
  }

  // ================================================================== scent cones
  function renderCones() {
    gCones.clearLayers();
    const w = S.wind;
    if (!w) return;
    const scentTo = (WIND_DEG[w] + 180) % 360;
    P.features.filter((f) => f.type === "stand").forEach((f) => {
      const a = analysis.analyzeStand(f, P.features, P.model);
      const ok = analysis.windOk(f, a, w);
      const p = f.geom.coords, len = 320, half = 22, pts = [p];
      for (let b = -half; b <= half; b += 4) pts.push(geo.dest(p, scentTo + b, len));
      const color = ok === true ? "#66bb6a" : ok === false ? "#ff5252" : "#bdbdbd";
      L.polygon(pts, { pane: "cones", color, weight: 1, fillColor: color, fillOpacity: 0.18, interactive: false }).addTo(gCones);
    });
  }

  // ================================================================== drawing
  let draw = null; // {type, pts, temp, measure}
  function startDraw(type) {
    cancelDraw();
    const t = type === "measure" ? { geom: "line", label: "Measure" } : TYPE[type];
    draw = { type, pts: [], geom: t.geom, measure: type === "measure" };
    map.doubleClickZoom.disable();
    $("#map").style.cursor = "crosshair";
    if (t.geom === "point") { $("#drawbar").classList.add("hidden"); toast(`Tap the map to place: ${t.label}`); }
    else { $("#drawbar").classList.remove("hidden"); updateDrawMsg(); }
    renderPalette();
  }
  function updateDrawMsg() {
    if (!draw) return;
    const t = draw.measure ? { label: "Measure" } : TYPE[draw.type];
    let m = `${t.label}: tap to add points (${draw.pts.length})`;
    if (draw.pts.length > 1) m += draw.geom === "area" ? ` · ${fmt.acres(geo.areaM2(draw.pts))}` : ` · ${fmt.yd(geo.lineLength(draw.pts))}`;
    $("#drawMsg").textContent = m;
    $("#drawFinish").classList.toggle("hidden", !!draw.measure);
  }
  function redrawTemp() {
    if (draw.temp) map.removeLayer(draw.temp);
    const c = draw.measure ? "#ffeb3b" : TYPE[draw.type].color;
    draw.temp = draw.geom === "area" && draw.pts.length > 2 ? L.polygon(draw.pts, { color: c, dashArray: "4 4", fillOpacity: 0.15 }) : L.polyline(draw.pts, { color: c, dashArray: "4 4", weight: 3 });
    draw.temp.addTo(map);
    updateDrawMsg();
  }
  function finishDraw() {
    if (!draw) return;
    const need = draw.geom === "area" ? 3 : 2;
    if (draw.measure) return cancelDraw();
    if (draw.pts.length < need) return toast(`Need at least ${need} points.`);
    const f = newFeature(draw.type, draw.geom === "area" ? "Polygon" : "LineString", draw.pts.slice());
    cancelDraw();
    select(f.id);
  }
  function cancelDraw() {
    if (draw && draw.temp) map.removeLayer(draw.temp);
    draw = null;
    map.doubleClickZoom.enable();
    $("#map").style.cursor = "";
    $("#drawbar").classList.add("hidden");
    renderPalette();
  }
  $("#drawFinish").onclick = finishDraw;
  $("#drawCancel").onclick = cancelDraw;
  $("#drawUndo").onclick = () => { if (draw && draw.pts.length) { draw.pts.pop(); redrawTemp(); } };
  map.on("dblclick", (e) => { if (draw && draw.geom !== "point") { L.DomEvent.stop(e); finishDraw(); } });
  map.on("click", (e) => onMapClick(e));
  async function onMapClick(e) {
    const p = [e.latlng.lat, e.latlng.lng];
    if (draw) {
      if (draw.geom === "point") {
        const f = newFeature(draw.type, "Point", p);
        cancelDraw(); select(f.id);
      } else { draw.pts.push(p); redrawTemp(); }
      return;
    }
    if (overlayEdit) return;
    if (sel) select(null);
    $("#readout").textContent = `${fmt.ll(p)} · elev …`;
    const el = await terrain.elevationAt(p[0], p[1]);
    let cv = "";
    if (P.canopy) { const r = await WS.cover.canopyRaster(P.canopy); const hgt = r && r.at(p[0], p[1]); if (hgt != null) cv = ` · trees ${hgt} m (${({ open: "open", regen: "thick young growth", pole: "pole timber", mature: "mature timber" })[WS.cover.classOf(hgt)]})`; }
    $("#readout").textContent = `${fmt.ll(p)} · elev ${el == null ? "n/a" : (el * terrain.FT).toFixed(1) + " ft"}${cv}`;
  }
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "Escape") { cancelDraw(); select(null); }
    if (e.key === "Enter" && draw) finishDraw();
  });

  function newFeature(type, gtype, coords, extra = {}) {
    const f = Object.assign({ id: uid(), type, name: "", notes: "", created: new Date().toISOString(), geom: { type: gtype, coords }, day: "", status: "", photos: [] }, extra);
    P.features.push(f); save();
    return f;
  }

  // ================================================================== tabs & sidebar
  function showTab(name) {
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
    $("#sidebar").classList.remove("collapsed");
    ({ spots: renderSpots, prop: renderProp, layers: renderLayers, mark: renderMark, intel: renderIntel, plan: renderPlan, log: renderLog, data: renderData })[name]();
    setTimeout(() => map.invalidateSize(), 220);
  }
  $$(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("#toggleSidebar").onclick = () => { $("#sidebar").classList.toggle("collapsed"); setTimeout(() => map.invalidateSize(), 250); };

  // top bar
  $("#windSelect").innerHTML = `<option value="">— off —</option>` + WINDS.map((w) => `<option>${w}</option>`).join("");
  $("#windSelect").value = S.wind || "";
  $("#windSelect").onchange = (e) => { S.wind = e.target.value; save(); renderCones(); if ($("#panel-intel").classList.contains("active")) renderIntel(); };
  function renderCountdown() {
    $("#brandSub").textContent = `${P.name}${H.name ? " · " + H.name : ""}${H.id ? " " + (WS.autoscout.WEAPONS[curWeapon()] || {}).icon : ""}${H.start ? " · " + fmtRange(H.start, H.end) : ""}`;
    if (!H.start) { $("#countdown").textContent = "No hunt planned"; return; }
    const now = new Date(), hunt = parseDay(H.start), scout = H.scoutStart ? parseDay(H.scoutStart) : hunt, end = parseDay(addDays(H.end, 1));
    const d = (a) => Math.ceil((a - now) / 864e5);
    let txt;
    if (now < scout && scout < hunt) txt = `🔎 Scouting in ${d(scout)}d · 🎯 Hunt in ${d(hunt)}d`;
    else if (now < hunt && scout >= hunt) txt = `🎯 Hunt in ${d(hunt)}d`;
    else if (now < hunt) txt = `🔎 Scouting now · Hunt in ${d(hunt)}d`;
    else if (now < end) txt = "🎯 Hunt is ON";
    else txt = "Season wrap-up";
    $("#countdown").textContent = txt;
  }
  function fmtRange(a, b) {
    const o = { month: "short", day: "numeric" }, A = parseDay(a), B = parseDay(b);
    return a === b ? A.toLocaleDateString([], { ...o, year: "numeric" }) : `${A.toLocaleDateString([], o)}–${B.toLocaleDateString([], { ...o, year: "numeric" })}`;
  }
  renderCountdown();

  // ================================================================== LAYERS panel
  function renderLayers() {
    const T = P.terrain;
    const p = $("#panel-layers");
    p.innerHTML = `
      <h3>Base map</h3>
      <div class="card">
        ${Object.entries(BASEMAPS).map(([k, b]) => `<label class="row"><input type="radio" name="base" value="${k}" ${S.settings.basemap === k ? "checked" : ""}> ${b.name}</label>`).join("")}
        <label class="row"><input type="checkbox" id="refT" ${S.settings.ref ? "checked" : ""}> Roads & place labels overlay</label>
        <label class="row"><input type="checkbox" id="lblT" ${S.settings.labels ? "checked" : ""}> Show marker names</label>
        <p class="muted small">Tip: compare Esri vs. NAIP — different flight dates show different leaf/flood conditions. USGS Topo shows contours, sloughs, and old channel scars.</p>
      </div>

      <h3>Terrain intelligence</h3>
      <div class="card">
        <label class="row"><input type="checkbox" id="hillT" ${T.hillshade ? "checked" : ""}> <b>Micro-relief hillshade</b></label>
        <div class="row"><span class="small muted">Exaggeration</span><input type="range" id="exag" min="1" max="40" value="${T.exag}"><span class="small" id="exagV">${T.exag}×</span></div>
        <div class="row"><span class="small muted">Opacity</span><input type="range" id="opHill" min="0.1" max="1" step="0.05" value="${T.opHill}"></div>
        <p class="muted small">Bottomland ground looks flat, but 2–4 ft ridges, old natural levees and slough banks are deer highways. Crank exaggeration to 15–30× to see them.</p>
        <hr style="border-color:var(--line)">
        <label class="row"><input type="checkbox" id="relT" ${T.relief ? "checked" : ""}> <b>Relative elevation (high ground)</b></label>
        <div class="row"><span class="small muted">Low ft</span><input type="number" id="lo" value="${T.lo.toFixed(1)}" step="0.5"><span class="small muted">High ft</span><input type="number" id="hi" value="${T.hi.toFixed(1)}" step="0.5"></div>
        <div class="btn-row"><button class="btn small" id="autoRange">Auto-fit to current view</button></div>
        <div class="row"><span class="small muted">Opacity</span><input type="range" id="opRel" min="0.1" max="1" step="0.05" value="${T.opRelief}"></div>
        <hr style="border-color:var(--line)">
        <label class="row"><input type="checkbox" id="floodT" ${T.flood ? "checked" : ""}> <b>Flood / backwater simulator</b></label>
        <div class="row"><span class="small muted">Water at</span><input type="range" id="floodFt" min="${Math.floor(T.lo - 5)}" max="${Math.ceil(T.hi + 5)}" step="0.25" value="${T.floodFt}"><span class="small" id="floodV">${T.floodFt.toFixed(1)} ft</span></div>
        <div class="row"><span class="small muted">Opacity</span><input type="range" id="opFlood" min="0.1" max="1" step="0.05" value="${T.opFlood}"></div>
        <p class="muted small">Blue = under water at that ground elevation, <span style="color:#ffe600">yellow</span> = last dry ground. When a river backs water into the bottoms, deer pile onto those yellow islands and ridges. Elevations are approximate (USGS 3DEP via AWS Terrain Tiles); calibrate by tapping a known waterline.</p>
      </div>

      <h3>Cover: tree canopy height</h3>
      <div class="card" id="canopyBox"></div>

      <h3>Imported onX layers</h3>
      <div class="card" id="importList"></div>

      <h3>Image overlays (onX screenshots)</h3>
      <div class="card" id="overlayList"></div>
    `;
    $$('input[name=base]', p).forEach((r) => (r.onchange = () => setBase(r.value)));
    $("#refT").onchange = (e) => { S.settings.ref = e.target.checked; e.target.checked ? refLayer.addTo(map) : map.removeLayer(refLayer); save(); };
    $("#lblT").onchange = (e) => { S.settings.labels = e.target.checked; save(); renderFeatures(); };
    const bindT = (id, key, fn) => ($("#" + id).onchange = (e) => { P.terrain[key] = e.target.type === "checkbox" ? e.target.checked : parseFloat(e.target.value); save(); fn && fn(); });
    bindT("hillT", "hillshade", syncTerrain); bindT("relT", "relief", syncTerrain); bindT("floodT", "flood", syncTerrain);
    $("#exag").oninput = (e) => { P.terrain.exag = +e.target.value; $("#exagV").textContent = e.target.value + "×"; save(); redrawTerrain([hillL]); };
    $("#opHill").oninput = (e) => { P.terrain.opHill = +e.target.value; save(); syncTerrain(); };
    $("#opRel").oninput = (e) => { P.terrain.opRelief = +e.target.value; save(); syncTerrain(); };
    $("#opFlood").oninput = (e) => { P.terrain.opFlood = +e.target.value; save(); syncTerrain(); };
    $("#lo").onchange = (e) => { P.terrain.lo = +e.target.value; save(); redrawTerrain([reliefL]); };
    $("#hi").onchange = (e) => { P.terrain.hi = +e.target.value; save(); redrawTerrain([reliefL]); };
    $("#floodFt").oninput = (e) => { P.terrain.floodFt = +e.target.value; $("#floodV").textContent = (+e.target.value).toFixed(1) + " ft"; save(); redrawTerrain([floodL]); };
    $("#autoRange").onclick = autoRange;
    renderCanopyBox();
    renderImportList(); renderOverlayList();
  }
  async function autoRange() {
    toast("Sampling elevation in view…");
    const b = map.getBounds();
    try {
      const r = await terrain.viewRange({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
      if (isNaN(r.lo)) throw new Error("no data");
      P.terrain.lo = Math.floor(r.lo * 2) / 2; P.terrain.hi = Math.ceil(r.hi * 2) / 2;
      if (P.terrain.floodFt < P.terrain.lo || P.terrain.floodFt > P.terrain.hi) P.terrain.floodFt = Math.round(r.median * 4) / 4;
      if (!P.terrain.relief) P.terrain.relief = true;
      save(); syncTerrain(); redrawTerrain(); renderLayers();
      toast(`View spans ${P.terrain.lo}–${P.terrain.hi} ft (median ${r.median.toFixed(1)} ft)`);
    } catch (e) { toast("Couldn't load elevation tiles — are you online?"); }
  }
  function renderLegend() {
    const T = P.terrain, el = $("#legend");
    if (!T.relief && !T.flood) return el.classList.add("hidden");
    el.classList.remove("hidden");
    let h = "";
    if (T.relief) h += `<div>Relative elevation</div><div class="bar" style="background:linear-gradient(90deg,#142878,#1e6ebe,#28aaaa,#5abe5a,#d2d246,#eb9628,#dc4628,#ffebe6)"></div><div class="ends"><span>${T.lo.toFixed(1)} ft</span><span>${T.hi.toFixed(1)} ft</span></div>`;
    if (T.flood) h += `<div style="margin-top:6px">Water level ${T.floodFt.toFixed(1)} ft: <span style="color:#4fa3ff">■</span> flooded <span style="color:#ffe600">■</span> last dry</div>`;
    el.innerHTML = h;
  }

  // ---------- imports
  const importLayers = new Map();
  function renderImportsOnMap() {
    gImports.clearLayers(); importLayers.clear();
    P.imports.forEach((imp) => {
      if (!imp.visible) return;
      const l = L.geoJSON(imp.geojson, {
        style: (f) => ({ color: (f.properties && (f.properties.stroke || f.properties["stroke-color"])) || imp.color, weight: 3, fillOpacity: 0.12 }),
        pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, color: "#000", weight: 1, fillColor: imp.color, fillOpacity: 0.95 }),
        onEachFeature: (f, layer) => {
          const pr = f.properties || {};
          layer.bindPopup(`<b>${esc(pr.name || "(unnamed)")}</b><br><span class="muted">${esc(imp.name)}</span>${pr.description ? `<p>${esc(String(pr.description).replace(/<[^>]+>/g, " "))}</p>` : ""}`);
        },
      }).addTo(gImports);
      importLayers.set(imp.id, l);
    });
  }
  function renderImportList() {
    const el = $("#importList");
    if (!el) return;
    el.innerHTML = P.imports.length ? P.imports.map((imp) => `
      <div class="row" data-id="${imp.id}">
        <input type="checkbox" class="vis" ${imp.visible ? "checked" : ""}>
        <input type="color" class="col" value="${imp.color}" style="width:28px;padding:0;border:0;background:none">
        <label>${esc(imp.name)} <span class="muted small">(${imp.geojson.features.length})</span></label>
        <button class="btn small zoom">Zoom</button>
        <button class="btn small conv" title="Turn these into editable markers with types guessed from names">Convert</button>
        <button class="btn small danger del">✕</button>
      </div>`).join("") : `<p class="muted small">Export waypoints, tracks, and areas from onX (Web Map → My Content → Export as KML/GPX) and import them on the Data tab. They show up here.</p>`;
    $$("[data-id]", el).forEach((row) => {
      const imp = P.imports.find((i) => i.id === row.dataset.id);
      $(".vis", row).onchange = (e) => { imp.visible = e.target.checked; save(); renderImportsOnMap(); };
      $(".col", row).onchange = (e) => { imp.color = e.target.value; save(); renderImportsOnMap(); };
      $(".zoom", row).onclick = () => { const l = importLayers.get(imp.id); if (l && l.getBounds().isValid()) map.fitBounds(l.getBounds(), { padding: [20, 20] }); };
      $(".conv", row).onclick = () => {
        const fs = imp.geojson.features.flatMap(io.fromGeoJSON);
        fs.forEach((f) => P.features.push(Object.assign({ day: "", status: "", photos: [] }, f)));
        imp.visible = false; save(); renderImportsOnMap(); renderFeatures(); renderImportList();
        toast(`Converted ${fs.length} features — review their types on the Log/Mark tabs.`);
      };
      $(".del", row).onclick = () => { if (!confirm(`Remove imported layer "${imp.name}"?`)) return; P.imports = P.imports.filter((i) => i !== imp); save(); renderImportsOnMap(); renderImportList(); };
    });
  }

  // ---------- image overlays
  const overlayObjs = new Map();
  let overlayEdit = null;
  async function renderOverlaysOnMap() {
    gOverlays.clearLayers(); overlayObjs.clear();
    for (const o of P.overlays) {
      if (!o.visible) continue;
      const blob = await store.getBlob(o.blobKey);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const img = L.imageOverlay(url, o.bounds, { opacity: o.opacity, pane: "overlayImg", interactive: false }).addTo(gOverlays);
      overlayObjs.set(o.id, img);
      if (o.analysis && o.analysis.show) { const au = await WS.cover.shotImageURL(o); if (au) L.imageOverlay(au, o.bounds, { opacity: 0.9, pane: "overlayImg", interactive: false }).addTo(gOverlays); }
    }
    if (overlayEdit) overlayHandles(overlayEdit);
  }
  function overlayHandles(id) {
    const o = P.overlays.find((x) => x.id === id), img = overlayObjs.get(id);
    if (!o || !img) return;
    const mk = (cls) => L.divIcon({ className: "", html: `<div class="handle ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    const sw = L.marker(o.bounds[0], { draggable: true, icon: mk(""), title: "SW corner" }).addTo(gOverlays);
    const ne = L.marker(o.bounds[1], { draggable: true, icon: mk(""), title: "NE corner" }).addTo(gOverlays);
    const ctr = () => [(o.bounds[0][0] + o.bounds[1][0]) / 2, (o.bounds[0][1] + o.bounds[1][1]) / 2];
    const mv = L.marker(ctr(), { draggable: true, icon: mk("move"), title: "Move whole image" }).addTo(gOverlays);
    const upd = () => { img.setBounds(o.bounds); sw.setLatLng(o.bounds[0]); ne.setLatLng(o.bounds[1]); mv.setLatLng(ctr()); };
    sw.on("drag", (e) => { const p = e.target.getLatLng(); o.bounds[0] = [p.lat, p.lng]; img.setBounds(o.bounds); mv.setLatLng(ctr()); });
    ne.on("drag", (e) => { const p = e.target.getLatLng(); o.bounds[1] = [p.lat, p.lng]; img.setBounds(o.bounds); mv.setLatLng(ctr()); });
    let start = null;
    mv.on("dragstart", () => { start = { c: ctr(), b: JSON.parse(JSON.stringify(o.bounds)) }; });
    mv.on("drag", (e) => {
      const p = e.target.getLatLng(), dLat = p.lat - start.c[0], dLng = p.lng - start.c[1];
      o.bounds = start.b.map((q) => [q[0] + dLat, q[1] + dLng]);
      img.setBounds(o.bounds); sw.setLatLng(o.bounds[0]); ne.setLatLng(o.bounds[1]);
    });
    [sw, ne, mv].forEach((m) => m.on("dragend", () => { save(); upd(); }));
  }
  // ---------- canopy height layer
  let canopyLayer = null;
  async function renderCanopyOnMap() {
    if (canopyLayer) { map.removeLayer(canopyLayer); canopyLayer = null; }
    if (!P.canopy || !P.canopyShow) return;
    const url = await WS.cover.canopyImageURL(P.canopy);
    if (!url) return;
    canopyLayer = L.imageOverlay(url, P.canopy.bounds, { opacity: P.canopyOpacity ?? 0.6, pane: "overlayImg", interactive: false }).addTo(map);
  }
  function renderCanopyBox() {
    const el = $("#canopyBox");
    if (!el) return;
    const C = P.canopy;
    el.innerHTML = C ? `
      <label class="row"><input type="checkbox" id="cnShow" ${P.canopyShow ? "checked" : ""}> <b>Show canopy height</b></label>
      <div class="row"><span class="small muted">Opacity</span><input type="range" id="cnOp" min="0.1" max="1" step="0.05" value="${P.canopyOpacity ?? 0.6}"></div>
      ${WS.cover.CLASSES.map((c) => `<div class="small"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(${c.color.slice(0, 3).join(",")},0.9);vertical-align:-2px"></span> ${c.label}</div>`).join("")}
      <p class="muted small">${esc(C.name || "")} · ${C.width}×${C.height} cells at ${C.resM} m · ${esc(C.source || "")}</p>
      <div class="btn-row"><button class="btn small" id="cnZoom">Zoom to coverage</button><button class="btn small danger" id="cnDel">Remove</button></div>` : `
      <p class="small">Tree height (about 1 m source data) shows <b>thick young growth</b> (bedding cover), <b>mature timber</b>, <b>openings</b>, and the <b>edges</b> between them. Auto-Scout uses it automatically once it's loaded.</p>
      <div class="btn-row"><button class="btn small accent" id="cnBundled">🌳 Load Phil Bryant WMA area (included)</button></div>
      <p class="muted small">For other properties, run <code>tools/canopy_pack.py</code> with the property's bounding box (see README), then import the <code>.canopy.json</code> file on the Data tab.</p>`;
    if (!C) {
      $("#cnBundled").onclick = async () => {
        try {
          toast("Loading canopy data (~7 MB)…");
          const pack = await (await fetch("data/phil-bryant-area.canopy.json")).json();
          await attachCanopy(pack);
        } catch (e) { toast("Couldn't load the bundled file. Open the app via a web address (GitHub Pages or localhost), not by double-clicking index.html, or import the file from the data folder on the Data tab.", 7000); }
      };
      return;
    }
    $("#cnShow").onchange = (e) => { P.canopyShow = e.target.checked; save(); renderCanopyOnMap(); };
    $("#cnOp").oninput = (e) => { P.canopyOpacity = +e.target.value; if (canopyLayer) canopyLayer.setOpacity(P.canopyOpacity); save(); };
    $("#cnZoom").onclick = () => map.fitBounds(C.bounds);
    $("#cnDel").onclick = async () => { if (!confirm("Remove canopy data from this property?")) return; await store.delBlob(C.blobKey); P.canopy = null; save(); renderCanopyOnMap(); renderCanopyBox(); };
  }
  async function attachCanopy(pack) {
    if (P.canopy) await store.delBlob(P.canopy.blobKey);
    P.canopy = await WS.cover.importCanopyPack(pack);
    P.canopyShow = true; save();
    await renderCanopyOnMap(); renderCanopyBox();
    const c = map.getCenter(), b = P.canopy.bounds;
    if (c.lat < b[0][0] || c.lat > b[1][0] || c.lng < b[0][1] || c.lng > b[1][1]) map.fitBounds(b);
    toast("Canopy height loaded. Auto-Scout will now use cover.");
  }

  function renderOverlayList() {
    const el = $("#overlayList");
    if (!el) return;
    el.innerHTML = `
      <label class="btn small accent file-btn">➕ Add screenshot<input type="file" id="ovFile" accept="image/*" hidden multiple></label>
      <p class="muted small">Screenshot a north-up onX view (satellite, hybrid, or topo), add it here, then drag the orange corners until roads/sloughs line up. Lower opacity to compare against live imagery.</p>
      ${P.overlays.map((o) => `
        <div class="card" data-id="${o.id}" style="margin:8px 0 0">
          <div class="row"><input type="checkbox" class="vis" ${o.visible ? "checked" : ""}><label>${esc(o.name)}</label>
            <button class="btn small edit ${overlayEdit === o.id ? "on" : ""}">${overlayEdit === o.id ? "Lock" : "Align"}</button>
            <button class="btn small ana" title="Find openings and water in this image for Auto-Scout">${o.analysis ? "Re-analyze" : "Analyze"}</button>
            <button class="btn small danger del">✕</button></div>
          <div class="row"><span class="small muted">Opacity</span><input type="range" class="op" min="0.05" max="1" step="0.05" value="${o.opacity}"></div>
          ${o.analysis ? `<label class="row small"><input type="checkbox" class="anaShow" ${o.analysis.show ? "checked" : ""}> Show analysis: <span style="color:#ffd600">■ openings ${Math.round(o.analysis.pct.open * 100)}%</span> <span style="color:#1e8cff">■ water ${Math.round(o.analysis.pct.water * 100)}%</span></label>` : ""}
        </div>`).join("")}
      <p class="muted small">Align the screenshot first, then press <b>Analyze</b>. It marks openings (fields, cutovers, roads) and water by color and texture, and Auto-Scout uses them for rifle lanes and newer cuts. Satellite or hybrid screenshots work best. Topo screenshots won't analyze well.</p>`;
    $("#ovFile").onchange = async (e) => { for (const f of e.target.files) await addOverlay(f); e.target.value = ""; };
    $$("[data-id]", el).forEach((row) => {
      const o = P.overlays.find((x) => x.id === row.dataset.id);
      $(".vis", row).onchange = (e) => { o.visible = e.target.checked; save(); renderOverlaysOnMap(); };
      $(".op", row).oninput = (e) => { o.opacity = +e.target.value; const im = overlayObjs.get(o.id); if (im) im.setOpacity(o.opacity); save(); };
      $(".edit", row).onclick = () => { overlayEdit = overlayEdit === o.id ? null : o.id; if (overlayEdit) { o.visible = true; map.fitBounds(o.bounds, { padding: [30, 30] }); } renderOverlaysOnMap(); renderOverlayList(); };
      $(".ana", row).onclick = async () => {
        toast("Analyzing screenshot…");
        const blob = await store.getBlob(o.blobKey);
        const r = await WS.cover.analyzeScreenshot(blob);
        if (o.analysis) { WS.cover.forgetShot(o); await store.delBlob(o.analysis.blobKey); }
        const key = "an_" + uid(); await store.setBlob(key, r.pngBlob);
        o.analysis = { blobKey: key, pct: r.pct, show: true, at: new Date().toISOString() };
        save(); renderOverlaysOnMap(); renderOverlayList();
        toast(`Found ${Math.round(r.pct.open * 100)}% openings and ${Math.round(r.pct.water * 100)}% water. Re-align and re-analyze if the corners move.`, 4500);
      };
      if ($(".anaShow", row)) $(".anaShow", row).onchange = (e) => { o.analysis.show = e.target.checked; save(); renderOverlaysOnMap(); };
      $(".del", row).onclick = async () => { if (!confirm(`Delete overlay "${o.name}"?`)) return; if (o.analysis) await store.delBlob(o.analysis.blobKey); await store.delBlob(o.blobKey); P.overlays = P.overlays.filter((x) => x !== o); if (overlayEdit === o.id) overlayEdit = null; save(); renderOverlaysOnMap(); renderOverlayList(); };
    });
  }
  async function addOverlay(file) {
    const key = "ov_" + uid();
    await store.setBlob(key, file);
    const dims = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res([4, 3]); im.src = URL.createObjectURL(file); });
    // fit into 70% of current view, preserving the screenshot's aspect ratio in screen space
    const size = map.getSize(), c = map.getCenter(), cp = map.latLngToContainerPoint(c);
    let w = size.x * 0.7, h = (w * dims[1]) / dims[0];
    if (h > size.y * 0.7) { h = size.y * 0.7; w = (h * dims[0]) / dims[1]; }
    const sw = map.containerPointToLatLng([cp.x - w / 2, cp.y + h / 2]), ne = map.containerPointToLatLng([cp.x + w / 2, cp.y - h / 2]);
    const o = { id: uid(), name: file.name, blobKey: key, bounds: [[sw.lat, sw.lng], [ne.lat, ne.lng]], opacity: 0.7, visible: true };
    P.overlays.push(o); overlayEdit = o.id; save();
    await renderOverlaysOnMap(); renderOverlayList();
    toast("Drag the orange corners (and blue center) to align the screenshot.");
  }

  // ================================================================== MARK panel
  let activeType = null;
  function renderPalette() {
    const el = $("#palette");
    if (!el) return;
    const groups = [...new Set(TYPES.map((t) => t.group))];
    el.innerHTML = groups.map((g) => `<h4>${g}</h4><div class="palette">${TYPES.filter((t) => t.group === g).map((t) =>
      `<button data-t="${t.id}" class="${draw && draw.type === t.id ? "active" : ""}"><span class="ic">${t.icon}</span>${t.label}<span class="g">${t.geom}</span></button>`).join("")}</div>`).join("") +
      `<div class="btn-row" style="margin-top:10px"><button class="btn small ${draw && draw.measure ? "on" : ""}" id="measureBtn">📏 Measure distance</button></div>`;
    $$("[data-t]", el).forEach((b) => (b.onclick = () => (draw && draw.type === b.dataset.t ? cancelDraw() : startDraw(b.dataset.t))));
    $("#measureBtn").onclick = () => (draw && draw.measure ? cancelDraw() : startDraw("measure"));
  }
  function renderMark() {
    const p = $("#panel-mark");
    p.innerHTML = `<div id="editor"></div><h3>Add to map</h3><p class="muted small">Pick a type, then tap the map. Lines & areas: tap each point, then Finish (or double-click).</p><div id="palette"></div>`;
    renderEditor(); renderPalette();
  }
  function renderEditor() {
    const el = $("#editor");
    if (!el) return;
    const f = sel && featById(sel);
    if (!f) { el.innerHTML = ""; return; }
    const t = TYPE[f.type];
    const sameGeom = TYPES.filter((x) => x.geom === t.geom);
    let geomInfo = "";
    if (f.geom.type === "LineString") geomInfo = `Length ${fmt.yd(geo.lineLength(f.geom.coords))}`;
    else if (f.geom.type === "Polygon") geomInfo = `Area ${fmt.acres(geo.areaM2(f.geom.coords))} · perimeter ${fmt.yd(geo.lineLength(f.geom.coords.concat([f.geom.coords[0]])))}`;
    else geomInfo = fmt.ll(f.geom.coords) + ' · <span id="elevInfo">elev …</span>';
    const statusOpts = f.type === "stand" ? ["", "candidate", "confirmed", "hung/ready", "rejected"] : f.type === "target" ? ["", "to check", "checked — good", "checked — dead"] : t.sign ? ["", "fresh", "old"] : null;
    el.innerHTML = `
      <div class="card hl">
        <div class="row"><span style="font-size:22px">${t.icon}</span><strong style="flex:1">${esc(f.name || t.label)}</strong><button class="btn small" id="edClose">Done</button></div>
        <div class="field"><span>Type</span><select id="edType">${sameGeom.map((x) => `<option value="${x.id}" ${x.id === f.type ? "selected" : ""}>${x.icon} ${x.label}</option>`).join("")}</select></div>
        <div class="field"><span>Name</span><input type="text" id="edName" value="${esc(f.name)}" placeholder="e.g. Overcup flat north, Big rub tree"></div>
        <div class="field"><span>Notes</span><textarea id="edNotes" placeholder="What you saw, sign size/freshness, travel direction, wind, access…">${esc(f.notes)}</textarea></div>
        <div class="row">
          <div class="field" style="flex:1"><span>Logged</span><input type="datetime-local" id="edDate" value="${toLocalInput(f.created)}"></div>
          <div class="field" style="flex:1"><span>Plan day</span><select id="edDay"><option value="">—</option>${H.days.map((d) => `<option value="${d.date}" ${f.day === d.date ? "selected" : ""}>${d.dow} ${d.date.slice(5)} (${d.kind})</option>`).join("")}</select></div>
        </div>
        ${statusOpts ? `<div class="field"><span>Status</span><select id="edStatus">${statusOpts.map((s) => `<option ${f.status === s ? "selected" : ""} value="${s}">${s || "—"}</option>`).join("")}</select></div>` : ""}
        ${f.type === "stand" ? `<div class="field"><span>Your wind call (overrides computed)</span><div class="btn-row">${WINDS.map((w) => `<button class="btn small mw ${(f.manualWinds || []).includes(w) ? "on" : ""}" data-w="${w}">${w}</button>`).join("")}</div></div><div id="standAnalysis"></div>` : ""}
        <p class="muted small">${geomInfo}${f.geom.type !== "Point" ? " · drag white dots to reshape, right-click/long-press one to delete it" : " · drag the marker to move it"}</p>
        <div class="thumbs" id="edThumbs"></div>
        <div class="btn-row">
          <label class="btn small file-btn">📷 Add photo<input type="file" id="edPhoto" accept="image/*" multiple hidden></label>
          <button class="btn small" id="edZoom">Zoom to</button>
          <button class="btn small" id="edDup">Duplicate</button>
          <button class="btn small danger" id="edDel">Delete</button>
        </div>
      </div>`;
    $("#edClose").onclick = () => select(null);
    $("#edType").onchange = (e) => { f.type = e.target.value; save(); renderFeatures(); renderEditor(); };
    $("#edName").oninput = (e) => { f.name = e.target.value; save(); };
    $("#edName").onchange = () => renderFeatures();
    $("#edNotes").oninput = (e) => { f.notes = e.target.value; save(); };
    $("#edDate").onchange = (e) => { f.created = new Date(e.target.value).toISOString(); save(); };
    $("#edDay").onchange = (e) => { f.day = e.target.value; save(); };
    if ($("#edStatus")) $("#edStatus").onchange = (e) => { f.status = e.target.value; save(); };
    $$(".mw", el).forEach((b) => (b.onclick = () => {
      f.manualWinds = f.manualWinds || [];
      const i = f.manualWinds.indexOf(b.dataset.w);
      i >= 0 ? f.manualWinds.splice(i, 1) : f.manualWinds.push(b.dataset.w);
      save(); renderEditor(); renderCones();
    }));
    $("#edZoom").onclick = () => { if (f.geom.type === "Point") map.setView(f.geom.coords, Math.max(map.getZoom(), 17)); else map.fitBounds(L.latLngBounds(f.geom.coords), { padding: [40, 40] }); };
    $("#edDup").onclick = () => { const c = JSON.parse(JSON.stringify(f)); c.id = uid(); c.name = (f.name || "") + " (copy)"; c.photos = []; if (c.geom.type === "Point") c.geom.coords = [c.geom.coords[0] + 0.0003, c.geom.coords[1]]; P.features.push(c); save(); select(c.id); };
    $("#edDel").onclick = async () => { if (!confirm("Delete this feature?")) return; for (const k of f.photos || []) await store.delBlob(k); P.features = P.features.filter((x) => x !== f); save(); select(null); };
    $("#edPhoto").onchange = async (e) => { for (const file of e.target.files) { const k = "ph_" + uid(); await store.setBlob(k, file); (f.photos = f.photos || []).push(k); } save(); renderThumbs(f); };
    renderThumbs(f);
    if (f.geom.type === "Point") terrain.elevationAt(f.geom.coords[0], f.geom.coords[1]).then((v) => { const e = $("#elevInfo"); if (e) e.textContent = v == null ? "elev n/a" : `elev ${(v * terrain.FT).toFixed(1)} ft`; });
    if (f.type === "stand") renderStandAnalysis(f, $("#standAnalysis"));
  }
  async function renderThumbs(f) {
    const el = $("#edThumbs");
    if (!el) return;
    el.innerHTML = "";
    for (const k of f.photos || []) {
      const b = await store.getBlob(k);
      if (!b) continue;
      const u = URL.createObjectURL(b), d = document.createElement("div");
      d.className = "t"; d.innerHTML = `<img src="${u}" alt="photo"><button title="Remove">✕</button>`;
      d.querySelector("img").onclick = () => window.open(u, "_blank");
      d.querySelector("button").onclick = async () => { await store.delBlob(k); f.photos = f.photos.filter((x) => x !== k); save(); renderThumbs(f); };
      el.appendChild(d);
    }
  }
  function toLocalInput(iso) {
    const d = iso ? new Date(iso) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function renderStandAnalysis(f, el) {
    const a = analysis.analyzeStand(f, P.features, P.model);
    const c = Object.entries(a.counts).map(([k, v]) => `<span class="pill">${TYPE[k].icon} ${v}</span>`).join("") || '<span class="muted small">no sign logged within 165 yd</span>';
    el.innerHTML = `
      <div class="card" style="background:#11140c">
        <div class="row"><span class="score">${a.score}</span><span class="muted small">/100 setup score</span></div>
        <div class="kv">
          <b>Sign nearby</b><span>${c}</span>
          <b>Bedding</b><span>${a.bed ? `${fmt.yd(a.bed.d)} ${geo.compass(geo.bearing(f.geom.coords, a.bed.pt))}` : "—"}</span>
          <b>Food</b><span>${a.food ? `${fmt.yd(a.food.d)} ${geo.compass(geo.bearing(f.geom.coords, a.food.pt))}` : "—"}</span>
          <b>Funnel / crossing</b><span>${a.pinch ? fmt.yd(a.pinch.d) : "—"}</span>
          <b>Predicted lane</b><span>${a.lane ? `${fmt.yd(a.lane.d)} (${esc(a.lane.path.from)} → ${esc(a.lane.path.to)})` : "run model in Deer Intel"}</span>
          <b>Access</b><span>${a.acc ? `${fmt.yd(a.acc.d)} from ${esc(a.acc.f.name || TYPE[a.acc.f.type].label)}` : "no parking/boat marked"}</span>
          <b>Good winds</b><span>${a.goodWinds.map((w) => `<span class="pill good">${w}</span>`).join("") || "—"}</span>
          <b>Bad winds</b><span>${a.badWinds.map((x) => `<span class="pill bad" title="blows scent toward ${x.why}">${x.w}</span>`).join("") || "—"}</span>
        </div>
        ${a.notes.map((n) => `<p class="small">${esc(n)}</p>`).join("")}
      </div>`;
  }

  // ================================================================== INTEL panel
  function renderIntel() {
    const p = $("#panel-intel");
    const C = conceptionDate();
    const huntPhase = analysis.phaseFor(huntMid(), C);
    const mid = H.start ? huntMid() : C, start = new Date(Math.min(mid, C) - 40 * 864e5), end = new Date(Math.max(mid, C) + 40 * 864e5), span = end - start;
    const pos = (d) => Math.max(0, Math.min(100, ((d - start) / span) * 100));
    const segs = analysis.PHASES.map((ph) => {
      const a = new Date(C.getTime() + ph.from * 864e5), b = new Date(C.getTime() + (ph.to + 1) * 864e5);
      const l = pos(a), r = pos(b);
      return r > l ? `<div class="seg" style="position:absolute;left:${l}%;width:${r - l}%;background:${ph.color}" title="${ph.name}">${r - l > 9 ? ph.name.split(" ")[0] : ""}</div>` : "";
    }).join("");
    const center = map.getCenter();
    const sunRows = H.days.map((d) => {
      const r = dayRep(d.date), ph = analysis.phaseFor(parseDay(d.date), C);
      return `<tr class="${d.kind}"><td>${d.dow} ${d.date.slice(8)}</td><td>${fmt.time(r.legalStart)}<br><span class="muted">${fmt.time(r.sunrise)}</span></td><td>${fmt.time(r.legalEnd)}<br><span class="muted">${fmt.time(r.sunset)}</span></td><td>${r.moonName.split(" ").pop()} ${Math.round(r.moonFraction * 100)}%<br><span class="muted">↑${fmt.time(r.moonrise)} ↓${fmt.time(r.moonset)}</span></td><td><span class="muted">${fmt.time(r.moonOverhead)}<br>${fmt.time(r.moonUnderfoot)}</span></td><td><span class="pill" style="border-color:${ph.color};color:${ph.color}">${ph.name.split(" ")[0]}</span></td></tr>`;
    }).join("");
    const stands = P.features.filter((f) => f.type === "stand");
    const ranked = stands.map((f) => ({ f, a: analysis.analyzeStand(f, P.features, P.model) })).sort((x, y) => y.a.score - x.a.score);
    const windMatrix = WINDS.map((w) => {
      const ok = ranked.filter((r) => analysis.windOk(r.f, r.a, w)).slice(0, 3);
      return `<tr><td><b>${w}</b></td><td>${ok.map((r) => `<a href="#" data-sel="${r.f.id}">${esc(r.f.name || "Stand")}</a> <span class="muted">(${r.a.score})</span>`).join(", ") || '<span class="muted">none — find a setup for this wind</span>'}</td></tr>`;
    }).join("");
    const m = P.model;
    p.innerHTML = `
      <h3>Rut timing — ${esc(P.name)}</h3>
      <div class="card">
        <div class="row"><div class="field" style="flex:1"><span>Mean conception (breeding) date for this area — from your state wildlife agency's rut/breeding map</span></div><select id="concM" style="width:90px">${["Oct","Nov","Dec","Jan","Feb"].map((mn, i) => `<option value="${[10,11,12,1,2][i]}" ${+P.conception.split("-")[0] === [10,11,12,1,2][i] ? "selected" : ""}>${mn}</option>`).join("")}</select><input type="number" id="concD" min="1" max="31" value="${+P.conception.split("-")[1]}" style="width:64px"></div>
        <div class="timeline">${segs}
          ${H.scoutStart && H.start ? `<div class="huntband" style="left:${pos(parseDay(H.scoutStart))}%;width:${pos(parseDay(H.start)) - pos(parseDay(H.scoutStart))}%;background:rgba(156,204,101,.35);border-color:#9ccc65" title="Scouting"></div>` : ""}
          ${H.start ? `<div class="huntband" style="left:${pos(parseDay(H.start))}%;width:${pos(parseDay(addDays(H.end, 1))) - pos(parseDay(H.start))}%" title="Hunt"></div>` : ""}
          <div class="mark" style="left:${pos(C)}%"><span>conception</span></div>
        </div>
        ${H.start ? "" : '<p class="muted small">No hunt planned for this property. Add one on the Property tab. Phase shown is for today.</p>'}<p><b>${H.start ? `${esc(H.name || "Your hunt")} (${fmtRange(H.start, H.end)})` : "Today"} lands ${Math.abs(huntPhase.offset)} days ${huntPhase.offset < 0 ? "before" : "after"} mean conception → <span style="color:${huntPhase.color}">${huntPhase.name}</span>.</b></p>
        <ul class="small" style="padding-left:18px;margin:6px 0">${huntPhase.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
        <details><summary>How to read this</summary>
          <p class="small">Most state agencies publish a <i>mean conception</i> (breeding) date from fetal data, not "peak rut". Hunter-observed chasing usually peaks 1–2 weeks <i>before</i> mean conception. Dates vary widely: early-to-mid November across much of the Midwest and Northeast, and anywhere from October to February across the South. In Mississippi, for example, the Delta runs about Dec 10 to Jan 2. Enter your county's date and every phase, tip, and day badge updates.</p>
        </details>
      </div>

      <h3>Sun, legal light & moon</h3>
      <div class="card">
        <table class="tbl"><tr><th>Day</th><th>Legal start<br>sunrise</th><th>Legal end<br>sunset</th><th>Moon</th><th>Overhead<br>underfoot</th><th>Phase</th></tr>${sunRows}</table>
        <p class="muted small">Legal light = ${P.legalMin ?? 30} min before sunrise / after sunset (set per property). Times are in ${esc(P.tz.split("/")[1].replace("_", " "))} time for the current map center. Many hunters watch moon overhead/underfoot for midday movement.</p>
      </div>

      <h3>Weather & wind</h3>
      <div class="card">
        <div class="btn-row"><button class="btn small accent" id="nws">Pull NWS hourly forecast</button><a class="btn small" href="https://forecast.weather.gov/MapClick.php?lat=${center.lat.toFixed(3)}&lon=${center.lng.toFixed(3)}" target="_blank" rel="noopener">NWS page ↗</a>${P.gaugeUrl ? `<a class="btn small" href="${esc(P.gaugeUrl)}" target="_blank" rel="noopener">River gauge ↗</a>` : ""}</div>
        <div id="nwsOut" class="small muted">The NWS gives about 7 days of hourly forecast. It fills each plan day's AM/PM wind automatically from about Dec 10 on.</div>
        <p class="small">Typical fall pattern: S/SE winds ahead of a cold front, then a hard N/NW wind behind it. The <b>first 24–48 hrs after a front</b> (falling temps, rising pressure, N wind) is when to sit all day. Warm, humid, high-moon days are the time to hunt thick cover close to beds.</p>
      </div>

      <h3>Travel-corridor model</h3>
      <div class="card">
        <p class="small">Builds least-cost deer routes from each <b>Bedding</b> area to its nearest <b>Food</b>, plus bedding→bedding cruising lanes in rut mode. The cost surface favors high ground, your logged deer trails, rub lines, ridges, crossings, and cover. It penalizes low wet ground, water, roads, and ATV trails. Lanes that overlap become <b style="color:#e056fd">hotspots</b>: candidate funnels to check on foot.</p>
        <label class="row"><input type="checkbox" id="moRut" ${S.modelOpts.rut ? "checked" : ""}> Rut mode: add buck cruising lanes between bedding areas</label>
        <label class="row"><input type="checkbox" id="moFlood" ${S.modelOpts.useFlood ? "checked" : ""}> Treat ground below flood level (${P.terrain.floodFt.toFixed(1)} ft) as water</label>
        <div class="row"><span class="small muted">High-ground preference</span><input type="range" id="moLow" min="0" max="10" step="0.5" value="${S.modelOpts.lowWeight}"><span class="small">${S.modelOpts.lowWeight}</span></div>
        <div class="btn-row"><button class="btn accent small" id="runModel">Run model</button><button class="btn small" id="clearModel">Clear</button><button class="btn small" id="saveLanes" ${m ? "" : "disabled"}>Save lanes as features</button></div>
        <div id="modelOut" class="small">${m ? modelSummary(m) : '<span class="muted">Not run yet.</span>'}</div>
      </div>

      <h3>Stand rankings ${S.wind ? `· wind ${S.wind}` : ""}</h3>
      <div class="card">
        ${ranked.length ? `<table class="tbl"><tr><th>Stand</th><th>Score</th><th>Good winds</th><th>${S.wind || "Wind"}</th></tr>${ranked.map((r) => {
          const ok = analysis.windOk(r.f, r.a, S.wind);
          return `<tr><td><a href="#" data-sel="${r.f.id}">${esc(r.f.name || "Stand")}</a><br><span class="muted">${esc(r.f.status || "")}</span></td><td><b>${r.a.score}</b></td><td>${(r.f.manualWinds && r.f.manualWinds.length ? r.f.manualWinds : r.a.goodWinds).join(" ")}</td><td>${ok == null ? "—" : ok ? "✅" : "❌"}</td></tr>`;
        }).join("")}</table>` : '<p class="muted small">Mark a few 🎯 Stand / Setup spots to rank them.</p>'}
      </div>
      <h3>Best stands by wind</h3>
      <div class="card"><table class="tbl">${windMatrix}</table></div>

      <h3>Reading this ground</h3>
      <div class="card small">${terrainGuide()}</div>`;
    const setConc = () => { const m = +$("#concM").value, d = Math.max(1, Math.min(31, +$("#concD").value || 1)); P.conception = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; save(); renderIntel(); };
    $("#concM").onchange = setConc; $("#concD").onchange = setConc;
    $$("[data-sel]", p).forEach((a) => (a.onclick = (e) => { e.preventDefault(); select(a.dataset.sel, { pan: true }); }));
    $("#nws").onclick = pullNWS;
    $("#moRut").onchange = (e) => { S.modelOpts.rut = e.target.checked; save(); };
    $("#moFlood").onchange = (e) => { S.modelOpts.useFlood = e.target.checked; save(); };
    $("#moLow").onchange = (e) => { S.modelOpts.lowWeight = +e.target.value; save(); renderIntel(); };
    $("#runModel").onclick = runModel;
    $("#clearModel").onclick = () => { P.model = null; save(); renderModel(); renderIntel(); };
    $("#saveLanes").onclick = () => {
      if (!P.model) return;
      P.model.paths.forEach((pa) => newFeature("trail", "LineString", pa.coords, { name: `Predicted: ${pa.from} → ${pa.to}`, notes: "Model-predicted lane — confirm with sign.", status: "" }));
      P.model.hotspots.forEach((h, i) => newFeature("target", "Point", h.coords, { name: `Hotspot ${i + 1}`, notes: `Model convergence of ${h.count} lanes — check for a funnel/crossing.`, status: "to check" }));
      renderFeatures(); toast("Lanes saved as Deer Trail lines and hotspots as Scout Targets.");
    };
  }
  function terrainGuide() {
    const G = {
      bottomland: [
        ["High ground is everything", "Low ground floods, so deer bed and travel on the subtle ridges between sloughs and brakes. Use micro-relief hillshade + relative elevation to find them."],
        ["Slough & bayou crossings", "are the natural funnels: beaver dams, downed logs, shallow necks, and the narrow ends of brakes. Mark every one you find."],
        ["Late acorns", "Red-oak group (water, willow, Nuttall, cherrybark) and overcup drop late. Find the trees still dropping and you've found the does."],
        ["Doe bedding during lockdown", "Thick regen, cutovers, and briar/cane patches on high ground. Sit the downwind edge and the pinch points between two of them."],
      ],
      hill: [
        ["Benches & saddles", "Deer travel side-hill benches about ⅓ down from the top and cross ridges at saddles. Crank hillshade exaggeration down (3–6×) and look for flat shelves and low gaps."],
        ["Points & thermals", "Bucks bed on points with the wind at their back and a view below. Mornings, thermals pull scent downhill; evenings, uphill. Hunt above deer in the PM and below them in the AM with care."],
        ["Hollow heads & creek crossings", "Where hollows head out and where creeks have gentle banks concentrate movement."],
        ["South-facing slopes", "Hold more browse and warmth late in the season."],
      ],
      mixed: [
        ["Inside corners & edges", "Field corners, hedgerow junctions, and the inside corner where timber meets crops are classic pinch points."],
        ["Ditches & draws", "Brushy ditches, creek bottoms, and draws connect bedding to fields. Deer use them to stay hidden."],
        ["Staging cover", "In the PM, bucks wait in cover 50–150 yd off the field edge before stepping out. Hunt the staging area, not the field."],
        ["CRP / tall grass", "Rut-time bedding often shifts into CRP, cutovers, and overgrown fields."],
      ],
      flat: [
        ["Cover changes are the terrain", "In flat pine country, the edges between thinned pines, clearcuts, SMZ hardwood strips, and burns do what ridges do elsewhere."],
        ["SMZ hardwood strips", "Streamside hardwood strips are travel corridors and hold acorns. Hunt the crossings."],
        ["Burns & fresh cuts", "Fresh green browse after burns pulls deer. Check how many months ago each block was burned."],
        ["Roads & lanes", "Deer cross lanes and firebreaks at the same spots: look for worn crossings and log them."],
      ],
    };
    const press = {
      wma: "Pressure: on draw/quota WMAs, the best spots are often past where most hunters stop walking, or across water. Deer move away from ATV trails and roads once gun hunts start.",
      nwr: "Pressure: refuges have sanctuaries and closed areas. Deer pile into them when hunting starts, so hunt the travel routes leading out of the sanctuary edges.",
      nf: "Pressure: on National Forest, hunters cluster near roads. A mile walk or a steep climb often means you have the ground to yourself.",
      state: "Pressure: get past the easy-access zone. Find the overlooked thick stuff near parking that everyone walks past.",
      private: "Pressure: keep intrusion low. Scout from the edges, use cameras, and save your best stands for the right wind.",
      lease: "Pressure: coordinate with members. Map everyone's stands and plan to intercept deer pushed by other hunters.",
    };
    const items = G[P.terrainStyle] || G.mixed;
    return items.map(([h, t]) => `<p><b>${h}</b>: ${t}</p>`).join("") + `<p><b>Edges</b>: deer travel transitions, such as cutover against mature timber or thick against open. Satellite views from different dates show these clearly.</p><p>${press[P.landType] || ""}</p>`;
  }
  function modelSummary(m) {
    return `<p>${m.paths.length} lanes · ${m.hotspots.length} hotspots · grid ${Math.round(m.stats.cellM)} m cells · ground ${m.stats.loFt.toFixed(1)}–${m.stats.hiFt.toFixed(1)} ft</p>
      <ul class="list">${m.paths.map((pa) => `<li><span class="ic">${pa.kind === "cruise" ? "💘" : "🌰"}</span><div class="grow">${esc(pa.from)} → ${esc(pa.to)}<div class="sub">${pa.kind === "cruise" ? "buck cruising lane" : "bed→feed lane"} · ${fmt.yd(pa.len)}</div></div></li>`).join("")}</ul>`;
  }
  async function runModel() {
    const out = $("#modelOut");
    out.innerHTML = '<span class="muted">Loading elevation & routing…</span>';
    try {
      const m = await analysis.modelCorridors(P.features, { ...S.modelOpts, floodFt: P.terrain.floodFt });
      P.model = m; save(); renderModel(); renderFeatures(); renderIntel();
      toast(`Model: ${m.paths.length} lanes, ${m.hotspots.length} hotspots`);
    } catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
  }
  function renderModel() {
    gModel.clearLayers();
    const m = P.model;
    if (!m) return;
    m.paths.forEach((pa) => {
      L.polyline(pa.coords, { color: "#000", weight: 7, opacity: 0.35, interactive: false }).addTo(gModel);
      L.polyline(pa.coords, { color: pa.kind === "cruise" ? "#e056fd" : "#ffb300", weight: 3.5, dashArray: "10 6", opacity: 0.95 })
        .bindTooltip(`${pa.kind === "cruise" ? "💘 Cruising lane" : "🌰 Bed→feed lane"}: ${esc(pa.from)} → ${esc(pa.to)} (${fmt.yd(pa.len)})`, { sticky: true }).addTo(gModel);
    });
    m.hotspots.forEach((h, i) => L.marker(h.coords, { icon: L.divIcon({ className: "", html: '<div class="hotspot"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindTooltip(`Hotspot ${i + 1}: ${h.count} lanes converge — likely funnel`).addTo(gModel));
  }

  // ---------- NWS
  const DIR16 = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  async function pullNWS() {
    const out = $("#nwsOut"), c = map.getCenter();
    out.textContent = "Contacting api.weather.gov…";
    try {
      const pt = await (await fetch(`https://api.weather.gov/points/${c.lat.toFixed(4)},${c.lng.toFixed(4)}`)).json();
      const fc = await (await fetch(pt.properties.forecastHourly)).json();
      const periods = fc.properties.periods;
      let filled = 0;
      const rows = [];
      H.days.forEach((d) => {
        const at = (h) => periods.find((p) => p.startTime.slice(0, 10) === d.date && +p.startTime.slice(11, 13) === h);
        const am = at(7), pm = at(15);
        const temps = periods.filter((p) => p.startTime.slice(0, 10) === d.date).map((p) => p.temperature);
        if (am || pm) {
          filled++;
          const to8 = (s) => geo.compass(DIR16[s] ?? 0);
          if (am) { d.forecast.am = to8(am.windDirection); d.forecast.amSpd = am.windSpeed; }
          if (pm) { d.forecast.pm = to8(pm.windDirection); d.forecast.pmSpd = pm.windSpeed; }
          if (temps.length) { d.forecast.hi = Math.max(...temps); d.forecast.lo = Math.min(...temps); }
          d.forecast.src = "NWS " + new Date().toLocaleDateString();
          rows.push(`<tr><td>${d.dow}</td><td>${d.forecast.am} ${esc(d.forecast.amSpd)}</td><td>${d.forecast.pm} ${esc(d.forecast.pmSpd)}</td><td>${d.forecast.lo}–${d.forecast.hi}°</td><td>${esc((am || pm).shortForecast)}</td></tr>`);
        }
      });
      save();
      out.innerHTML = filled ? `<table class="tbl"><tr><th></th><th>7 AM</th><th>3 PM</th><th>Temp</th><th></th></tr>${rows.join("")}</table>` :
        `Forecast reaches ${periods[periods.length - 1].startTime.slice(0, 10)} — your dates aren't in range yet. Try again within ~7 days of Dec 14.`;
    } catch (e) { out.textContent = "Couldn't reach the NWS API (offline or blocked). Enter winds manually on the Plan tab."; }
  }

  // ================================================================== PLAN panel
  function renderPlan() {
    const p = $("#panel-plan");
    const stands = P.features.filter((f) => f.type === "stand");
    const access = P.features.filter((f) => ["parking", "boat", "check"].includes(f.type));
    const hunters = S.settings.hunters.split(",").map((s) => s.trim()).filter(Boolean);
    const C = conceptionDate();
    p.innerHTML = `
      <div class="card small">${P.hunts.length ? `<div class="row"><span class="muted">Hunt</span><select id="huntPick">${P.hunts.map((h) => `<option value="${h.id}" ${h.id === H.id ? "selected" : ""}>${esc(h.name)} · ${fmtRange(h.start, h.end)}</option>`).join("")}</select><button class="btn small" id="toProp">Edit hunts</button></div>` : `<p><b>No hunt planned for ${esc(P.name)}.</b> <button class="btn small accent" id="toProp">➕ Add a hunt</button></p>`}
      ${H.start ? `${H.scoutStart ? `Scout <b>${fmtRange(H.scoutStart, addDays(H.start, -1))}</b>, ` : ""}hunt <b>${fmtRange(H.start, H.end)}</b>. ` : ""}Assign map features to a day from the editor (Plan day), and they show up here as stops. Hunters: <input type="text" id="hunters" value="${esc(S.settings.hunters)}" placeholder="Me, Dad" style="margin-top:4px"></div>
      ${H.days.map((d, di) => {
        const ph = analysis.phaseFor(parseDay(d.date), C), r = dayRep(d.date);
        const stops = P.features.filter((f) => f.day === d.date);
        const fc = d.forecast;
        return `<div class="card daycard ${d.kind}" data-di="${di}">
          <div class="dh"><strong>${dayLabel(d.date)} · ${d.kind === "scout" ? "🔎 Scout" : "🎯 Hunt"}</strong><span class="pill" style="border-color:${ph.color};color:${ph.color}">${ph.name.split(" (")[0]}</span></div>
          <input type="text" class="dtitle" value="${esc(d.title)}" style="margin:6px 0">
          <div class="small muted">Legal ${fmt.time(r.legalStart)}–${fmt.time(r.legalEnd)} · ${r.moonName} ${Math.round(r.moonFraction * 100)}%</div>
          <div class="row" style="flex-wrap:wrap">
            <span class="small muted">AM wind</span><select class="fam" style="width:70px"><option value="">?</option>${WINDS.map((w) => `<option ${fc.am === w ? "selected" : ""}>${w}</option>`).join("")}</select>
            <span class="small muted">PM</span><select class="fpm" style="width:70px"><option value="">?</option>${WINDS.map((w) => `<option ${fc.pm === w ? "selected" : ""}>${w}</option>`).join("")}</select>
            <label class="small"><input type="checkbox" class="ffront" ${fc.front ? "checked" : ""}> cold front</label>
          </div>
          ${fc.src ? `<div class="small muted">${esc(fc.amSpd)} / ${esc(fc.pmSpd)} · ${fc.lo}–${fc.hi}°F · ${esc(fc.src)}</div>` : ""}
          ${d.kind === "hunt" ? `<h4>Sits</h4>${hunters.map((h) => {
            const s = d.sits[h] || {};
            const sel = (slot) => `<select class="sit" data-h="${esc(h)}" data-slot="${slot}"><option value="">${slot.toUpperCase()} stand…</option>${stands.map((st) => `<option value="${st.id}" ${s[slot] === st.id ? "selected" : ""}>${esc(st.name || "Stand")}</option>`).join("")}</select>`;
            const chk = (slot) => {
              const st = s[slot] && featById(s[slot]), w = slot === "am" ? fc.am : fc.pm;
              if (!st || !w) return "";
              const ok = analysis.windOk(st, analysis.analyzeStand(st, P.features, P.model), w);
              return ok ? `<span class="pill good">${w} ✓</span>` : `<span class="pill bad">${w} ✗ bad wind</span>`;
            };
            return `<div class="small" style="margin-top:4px"><b>${esc(h)}</b></div><div class="sits"><div>${sel("am")}${chk("am")}</div><div>${sel("pm")}${chk("pm")}</div></div>`;
          }).join("")}` : ""}
          <h4>${d.kind === "scout" ? "Stops for this day" : "Linked features"} (${stops.length})</h4>
          ${stops.length ? `<ul class="list">${stops.map((f) => `<li data-sel="${f.id}"><span class="ic">${TYPE[f.type].icon}</span><div class="grow">${esc(f.name || TYPE[f.type].label)}<div class="sub">${esc(f.status || TYPE[f.type].label)}</div></div></li>`).join("")}</ul>` : '<p class="muted small">None yet. Select a marker → set "Plan day".</p>'}
          ${d.kind === "scout" ? `<div class="row"><select class="rstart"><option value="">Start from…</option>${access.map((a) => `<option value="${a.id}" ${d.routeStart === a.id ? "selected" : ""}>${TYPE[a.type].icon} ${esc(a.name || TYPE[a.type].label)}</option>`).join("")}</select><button class="btn small route">Plan route</button></div><div class="small routeOut"></div>` : ""}
          <h4>Tasks</h4>
          ${d.tasks.map((t) => `<div class="check ${t.done ? "done" : ""}" data-t="${t.id}"><input type="checkbox" ${t.done ? "checked" : ""}><span>${esc(t.text)}</span><button class="x" title="Remove">✕</button></div>`).join("")}
          <div class="row"><input type="text" class="newtask" placeholder="Add task…"><button class="btn small addtask">Add</button></div>
          <textarea class="dnotes" placeholder="Day notes / debrief…">${esc(d.notes)}</textarea>
        </div>`;
      }).join("")}
      <h3>Gear & regs checklist</h3>
      <div class="card" id="gear">${S.gear.map((t) => `<div class="check ${t.done ? "done" : ""}" data-g="${t.id}"><input type="checkbox" ${t.done ? "checked" : ""}><span>${esc(t.text)}</span><button class="x">✕</button></div>`).join("")}
        <div class="row"><input type="text" id="newGear" placeholder="Add item…"><button class="btn small" id="addGear">Add</button></div></div>`;
    $("#toProp").onclick = () => showTab("prop");
    if ($("#huntPick")) $("#huntPick").onchange = (e) => { P.activeHuntId = e.target.value; bindActive(); save(); renderCountdown(); renderPlan(); };
    $("#hunters").onchange = (e) => { S.settings.hunters = e.target.value; save(); renderPlan(); };
    $$(".daycard", p).forEach((card) => {
      const d = H.days[+card.dataset.di];
      $(".dtitle", card).oninput = (e) => { d.title = e.target.value; save(); };
      $(".fam", card).onchange = (e) => { d.forecast.am = e.target.value; save(); renderPlan(); };
      $(".fpm", card).onchange = (e) => { d.forecast.pm = e.target.value; save(); renderPlan(); };
      $(".ffront", card).onchange = (e) => { d.forecast.front = e.target.checked; save(); };
      $(".dnotes", card).oninput = (e) => { d.notes = e.target.value; save(); };
      $$(".sit", card).forEach((s) => (s.onchange = () => { d.sits[s.dataset.h] = d.sits[s.dataset.h] || {}; d.sits[s.dataset.h][s.dataset.slot] = s.value; save(); renderPlan(); }));
      $$("[data-t]", card).forEach((row) => {
        const t = d.tasks.find((x) => x.id === row.dataset.t);
        $("input", row).onchange = (e) => { t.done = e.target.checked; save(); row.classList.toggle("done", t.done); };
        $(".x", row).onclick = () => { d.tasks = d.tasks.filter((x) => x !== t); save(); renderPlan(); };
      });
      const add = () => { const v = $(".newtask", card).value.trim(); if (!v) return; d.tasks.push({ id: uid(), text: v, done: false }); save(); renderPlan(); };
      $(".addtask", card).onclick = add;
      $(".newtask", card).onkeydown = (e) => { if (e.key === "Enter") add(); };
      $$("[data-sel]", card).forEach((li) => (li.onclick = () => select(li.dataset.sel, { pan: true })));
      if ($(".route", card)) {
        $(".rstart", card).onchange = (e) => { d.routeStart = e.target.value; save(); };
        $(".route", card).onclick = () => planRoute(d, $(".routeOut", card));
      }
    });
    $$("[data-g]", p).forEach((row) => {
      const t = S.gear.find((x) => x.id === row.dataset.g);
      $("input", row).onchange = (e) => { t.done = e.target.checked; save(); row.classList.toggle("done", t.done); };
      $(".x", row).onclick = () => { S.gear = S.gear.filter((x) => x !== t); save(); renderPlan(); };
    });
    $("#addGear").onclick = () => { const v = $("#newGear").value.trim(); if (v) { S.gear.push({ id: uid(), text: v, done: false }); save(); renderPlan(); } };
  }
  function planRoute(d, out) {
    const stops = P.features.filter((f) => f.day === d.date && f.geom.type === "Point" && !["parking", "boat", "check"].includes(f.type));
    const startF = d.routeStart && featById(d.routeStart);
    if (!stops.length) { out.textContent = "Assign some point features (targets, stands, sign to re-check) to this day first."; return; }
    const r = analysis.orderRoute(startF ? startF.geom.coords : null, stops);
    gRoute.clearLayers();
    const pts = (startF ? [startF.geom.coords] : []).concat(r.order.map((f) => f.geom.coords)).concat(startF ? [startF.geom.coords] : []);
    L.polyline(pts, { color: "#00e5ff", weight: 3, dashArray: "2 8", opacity: 0.95 }).addTo(gRoute);
    r.order.forEach((f, i) => L.marker(f.geom.coords, { icon: L.divIcon({ className: "", html: `<div style="background:#00e5ff;color:#000;border-radius:50%;width:18px;height:18px;font-size:11px;font-weight:700;text-align:center;line-height:18px;transform:translate(12px,-12px)">${i + 1}</div>`, iconSize: [18, 18] }), interactive: false }).addTo(gRoute));
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    const walkMin = (r.total * 1.3) / 0.6 / 60; // 1.3 tortuosity factor, ~1.35 mph through bottoms
    const stopMin = r.order.length * 15;
    out.innerHTML = `<p>Route ${fmt.yd(r.total)} straight-line (${startF ? "round trip" : "one way"}) · ≈ ${Math.round((walkMin + stopMin) / 60 * 10) / 10} hrs incl. 15 min/stop.</p><ol style="padding-left:18px;margin:4px 0">${r.order.map((f, i) => `<li>${TYPE[f.type].icon} ${esc(f.name || TYPE[f.type].label)} <span class="muted">+${fmt.yd(r.legs[i])}</span></li>`).join("")}</ol><button class="btn small" id="clrRoute">Clear route</button>`;
    $("#clrRoute", out).onclick = () => { gRoute.clearLayers(); out.innerHTML = ""; };
  }

  // ================================================================== LOG panel
  let logFilter = { type: "", day: "" };
  function renderLog() {
    const p = $("#panel-log");
    const signs = P.features.filter((f) => TYPE[f.type].sign || ["camera", "note", "target"].includes(f.type));
    const cnt = (t) => P.features.filter((f) => f.type === t).length;
    let list = signs.filter((f) => (!logFilter.type || f.type === logFilter.type) && (!logFilter.day || (f.created || "").slice(0, 10) === logFilter.day || f.day === logFilter.day));
    list.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    p.innerHTML = `
      <h3>Sign summary</h3>
      <div class="stat-grid">
        <div><b>${cnt("rub") + cnt("rubline")}</b>rubs</div><div><b>${cnt("scrape")}</b>scrapes</div><div><b>${cnt("tracks") + cnt("trail")}</b>tracks/trails</div><div><b>${cnt("sighting") + cnt("buck")}</b>sightings</div>
        <div><b>${cnt("bedding") + cnt("bed")}</b>bedding</div><div><b>${cnt("food")}</b>food</div><div><b>${cnt("stand")}</b>stands</div><div><b>${cnt("crossing") + cnt("funnel")}</b>funnels</div>
      </div>
      <div class="btn-row" style="margin-top:8px"><button class="btn small ${map.hasLayer(gHeat) ? "on" : ""}" id="heatT">🔥 Sign density heat</button><button class="btn small accent" id="openField">📍 Field Log</button></div>
      <h3>Entries</h3>
      <div class="row"><select id="fType"><option value="">All types</option>${TYPES.filter((t) => t.sign || ["camera", "note", "target"].includes(t.id)).map((t) => `<option value="${t.id}" ${logFilter.type === t.id ? "selected" : ""}>${t.icon} ${t.label}</option>`).join("")}</select>
      <select id="fDay"><option value="">All days</option>${H.days.map((d) => `<option value="${d.date}" ${logFilter.day === d.date ? "selected" : ""}>${d.dow} ${d.date.slice(5)}</option>`).join("")}</select></div>
      <ul class="list">${list.map((f) => `<li data-sel="${f.id}"><span class="ic">${TYPE[f.type].icon}</span><div class="grow">${esc(f.name || TYPE[f.type].label)} ${f.status ? `<span class="pill">${esc(f.status)}</span>` : ""}${(f.photos || []).length ? " 📷" : ""}<div class="sub">${f.created ? new Date(f.created).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}${f.notes ? " · " + esc(f.notes.slice(0, 80)) : ""}</div></div></li>`).join("") || '<p class="muted small">No entries yet. Use the Field Log button while you scout.</p>'}</ul>`;
    $("#fType").onchange = (e) => { logFilter.type = e.target.value; renderLog(); };
    $("#fDay").onchange = (e) => { logFilter.day = e.target.value; renderLog(); };
    $("#heatT").onclick = () => { map.hasLayer(gHeat) ? map.removeLayer(gHeat) : (renderHeat(), gHeat.addTo(map)); renderLog(); };
    $("#openField").onclick = openField;
    $$("[data-sel]", p).forEach((li) => (li.onclick = () => select(li.dataset.sel, { pan: true })));
  }
  function renderHeat() {
    gHeat.clearLayers();
    const W = { rub: 1, scrape: 1.4, tracks: 0.6, bed: 1, droppings: 0.5, sighting: 1, buck: 1.6 };
    P.features.forEach((f) => {
      const w = W[f.type];
      if (w && f.geom.type === "Point") {
        L.circle(f.geom.coords, { radius: 90, stroke: false, fillColor: "#ff3d00", fillOpacity: 0.12 * w, interactive: false }).addTo(gHeat);
        L.circle(f.geom.coords, { radius: 40, stroke: false, fillColor: "#ffea00", fillOpacity: 0.15 * w, interactive: false }).addTo(gHeat);
      }
    });
  }

  // ================================================================== Field mode
  let gps = null, gpsWatch = null;
  function startGPS(pan) {
    if (!navigator.geolocation) return toast("No GPS available in this browser.");
    if (gpsWatch == null) {
      gpsWatch = navigator.geolocation.watchPosition((pos) => {
        gps = pos;
        const ll = [pos.coords.latitude, pos.coords.longitude];
        gMe.clearLayers();
        L.circle(ll, { radius: pos.coords.accuracy, color: "#2196f3", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(gMe);
        L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#2196f3", fillOpacity: 1 }).addTo(gMe);
        const st = $("#gpsStatus"); if (st) st.textContent = `GPS ±${Math.round(pos.coords.accuracy * 1.09)} yd`;
        if (pan && pan !== "done") { map.setView(ll, Math.max(map.getZoom(), 16)); pan = "done"; }
      }, (err) => { const st = $("#gpsStatus"); if (st) st.textContent = "GPS error: " + err.message; toast("GPS: " + err.message); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } else if (gps && pan) map.setView([gps.coords.latitude, gps.coords.longitude], Math.max(map.getZoom(), 16));
  }
  function openField() {
    $("#fieldModal").classList.remove("hidden");
    startGPS(false);
    const quick = ["rub", "scrape", "tracks", "bed", "droppings", "sighting", "buck", "trail", "crossing", "funnel", "camera", "stand", "target", "parking", "note"];
    $("#fieldGrid").innerHTML = quick.map((t) => `<button data-q="${t}"><span class="ic">${TYPE[t].icon}</span>${TYPE[t].label}</button>`).join("");
    $$("[data-q]", $("#fieldGrid")).forEach((b) => (b.onclick = async () => {
      const ll = gps ? [gps.coords.latitude, gps.coords.longitude] : [map.getCenter().lat, map.getCenter().lng];
      const type = b.dataset.q;
      const gtype = TYPE[type].geom === "point" ? "Point" : "LineString";
      const coords = gtype === "Point" ? ll : [ll, geo.dest(ll, 0, 15)];
      const f = newFeature(type, gtype, coords, { notes: $("#fieldNote").value.trim() + (gps ? "" : " [no GPS fix — placed at map center]") });
      const file = $("#fieldPhoto").files[0];
      if (file) { const k = "ph_" + uid(); await store.setBlob(k, file); f.photos.push(k); save(); }
      $("#fieldNote").value = ""; $("#fieldPhoto").value = "";
      renderFeatures();
      toast(`${TYPE[type].icon} ${TYPE[type].label} logged${gps ? ` (±${Math.round(gps.coords.accuracy * 1.09)} yd)` : " at map center"}`);
    }));
  }
  $("#fieldModeBtn").onclick = openField;
  $("#fieldClose").onclick = () => $("#fieldModal").classList.add("hidden");

  // ================================================================== DATA panel
  function renderData() {
    const p = $("#panel-data");
    const online = location.protocol.startsWith("http");
    p.innerHTML = `
      <h3>Import</h3>
      <div class="card">
        <label class="btn accent file-btn">📂 Import files<input type="file" id="impFile" multiple accept=".kml,.kmz,.gpx,.geojson,.json,image/*" hidden></label>
        <p class="small">• <b>onX</b>: export waypoints/tracks/areas as <b>KML</b> or <b>GPX</b> (onX Web Map → My Content → select → Export). KMZ and GeoJSON also work.<br>
        • <b>Images</b> (PNG/JPG screenshots of onX satellite/topo/hybrid) become draggable map overlays.<br>
        • <b>.json</b> backups from this app restore everything.</p>
        ${P.name.includes("Ten Point") ? '<div class="btn-row"><button class="btn small" id="impIncluded">📥 Import my Ten Point onX export (included)</button></div>' : ""}
        <div id="impOut" class="small muted"></div>
      </div>
      <h3>Export (send to onX / your hunting partner)</h3>
      <div class="card">
        <div class="field"><span>What</span><select id="expWhat"><option value="all">Everything I've marked (${P.features.length})</option><option value="plan">Plan only: stands, routes, targets, access</option><option value="sign">Sign only</option></select></div>
        <div class="btn-row"><button class="btn small" data-x="kml">KML (onX, Google Earth)</button><button class="btn small" data-x="gpx">GPX (onX, GPS units)</button><button class="btn small" data-x="geojson">GeoJSON</button></div>
        <p class="muted small">Import the KML into onX (Web Map → Import) so your stands, routes, and hotspots are on your phone with onX's offline maps in the woods.</p>
        <hr style="border-color:var(--line)">
        <div class="btn-row"><button class="btn small accent" id="backup">💾 Full backup (.json incl. photos)</button></div>
      </div>
      <h3>Offline maps</h3>
      <div class="card">
        <p class="small">Saves the current view's tiles (active base map + elevation) to the browser cache for spotty cell service. ${online ? "" : "<b style='color:var(--warn)'>Only works when the app is served over http(s), not opened as a file.</b>"}</p>
        <div class="row"><span class="small muted">Zoom levels</span><select id="offZ"><option value="2">current +2</option><option value="3" selected>current +3</option><option value="4">current +4</option></select></div>
        <div class="btn-row"><button class="btn small" id="cacheBtn" ${online ? "" : "disabled"}>⬇️ Cache this view</button></div>
        <div class="progress"><div id="cacheProg"></div></div><div class="small muted" id="cacheOut"></div>
      </div>
      <h3>Settings</h3>
      <div class="card">
        <p class="muted small">Property details, home view, rules, and hunts live on the 🏞️ Property tab.</p>
        <div class="btn-row"><button class="btn small danger" id="resetAll">Erase everything (all properties)</button></div>
      </div>
      <h3>Sources & reminders</h3>
      <div class="card small">
        <p>Rules change every year and differ between WMAs, refuges, national forests, and private ground. Work through the rules checklist on the Property tab against the current brochure, refuge hunt plan, or lease agreement.</p>
        <p class="muted">Elevation: AWS Terrain Tiles (USGS 3DEP and others). Imagery: Esri, USGS NAIP. Forecast: NWS. Rut model: MDWFP mean conception date (you enter it).</p>
      </div>`;
    if ($("#impIncluded")) $("#impIncluded").onclick = async () => {
      try {
        const txt = await (await fetch("data/onx/ten-point-onx-export.kml")).text();
        await importFiles([new File([txt], "ten-point-onx-export.kml", { type: "application/vnd.google-earth.kml+xml" })]);
      } catch (e) { toast("Couldn't load it here. Open the app via GitHub Pages/localhost, or import data/onx/ten-point-onx-export.kml with Import files.", 6000); }
    };
    $("#impFile").onchange = (e) => importFiles([...e.target.files]).finally(() => (e.target.value = ""));
    $$("[data-x]", p).forEach((b) => (b.onclick = () => doExport(b.dataset.x)));
    $("#backup").onclick = backup;
    $("#cacheBtn").onclick = cacheView;
    $("#resetAll").onclick = async () => { if (!confirm("Erase ALL properties, features, imports, overlays, photos and plans? (Make a backup first!)")) return; const keys = await store.allBlobKeys(); for (const k of keys || []) await store.delBlob(k); await store.set("state", DEFAULT_STATE()); location.reload(); };
  }
  async function importFiles(files) {
    const out = $("#impOut"), msgs = [];
    for (const file of files) {
      try {
        if (file.type.startsWith("image/")) { await addOverlay(file); msgs.push(`🖼️ ${file.name}: overlay added. Align it on the map`); continue; }
        const r = await io.readGeoFile(file);
        if (r.backup) { await restore(r.backup); msgs.push(`💾 Restored backup ${file.name}`); continue; }
        if (r.canopy) { await attachCanopy(r.canopy); msgs.push(`🌳 ${file.name}: canopy height loaded into ${P.name}`); continue; }
        const n = r.geojson.features.length;
        const colors = ["#ffeb3b", "#00e5ff", "#ff4081", "#76ff03", "#ff9100", "#e040fb"];
        const imp = { id: uid(), name: r.name, geojson: r.geojson, color: colors[P.imports.length % colors.length], visible: true };
        P.imports.push(imp); save(); renderImportsOnMap();
        const l = importLayers.get(imp.id);
        if (l && l.getBounds().isValid()) map.fitBounds(l.getBounds(), { padding: [20, 20] });
        msgs.push(`✅ ${file.name}: ${n} features. See Layers → Imported (use Convert to make them editable)`);
      } catch (e) { msgs.push(`❌ ${file.name}: ${e.message}`); }
    }
    if (out) out.innerHTML = msgs.map(esc).join("<br>");
    toast(msgs[msgs.length - 1] || "Nothing imported");
  }
  function exportSet(what) {
    if (what === "plan") return P.features.filter((f) => ["Plan", "Access"].includes(TYPE[f.type].group) || ["funnel", "crossing"].includes(f.type));
    if (what === "sign") return P.features.filter((f) => TYPE[f.type].sign);
    return P.features;
  }
  function doExport(kind) {
    const fs = exportSet($("#expWhat").value);
    if (!fs.length) return toast("Nothing to export yet.");
    const base = `${slug(P.name)}-${new Date().toISOString().slice(0, 10)}`;
    if (kind === "kml") io.download(base + ".kml", io.toKML(fs, `Scout Hub – ${P.name}`), "application/vnd.google-earth.kml+xml");
    if (kind === "gpx") io.download(base + ".gpx", io.toGPX(fs), "application/gpx+xml");
    if (kind === "geojson") io.download(base + ".geojson", JSON.stringify(io.toGeoJSONFC(fs), null, 1), "application/geo+json");
  }
  async function backup() {
    const keys = (await store.allBlobKeys()) || [];
    const blobs = {};
    for (const k of keys) { const b = await store.getBlob(k); if (b) blobs[k] = await io.blobToDataURL(b); }
    io.download(`scout-hub-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ scoutHubBackup: 2, saved: new Date().toISOString(), state: S, blobs }), "application/json");
  }
  async function restore(b) {
    if (!confirm("Restore this backup? It replaces everything currently in the app.")) return;
    for (const [k, v] of Object.entries(b.blobs || {})) await store.setBlob(k, await io.dataURLToBlob(v));
    S = migrate(b.state);
    await store.set("state", JSON.parse(JSON.stringify(S)));
    location.reload();
  }
  async function cacheView() {
    const zAdd = +$("#offZ").value, z0 = map.getZoom(), b = map.getBounds();
    const base = BASEMAPS[S.settings.basemap];
    const urls = [];
    for (let z = Math.max(10, z0 - 1); z <= Math.min(19, z0 + zAdd); z++) {
      const x0 = Math.floor(terrain.lng2x(b.getWest(), z)), x1 = Math.floor(terrain.lng2x(b.getEast(), z));
      const y0 = Math.floor(terrain.lat2y(b.getNorth(), z)), y1 = Math.floor(terrain.lat2y(b.getSouth(), z));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        if (z <= base.max) urls.push(base.url.replace("{s}", "a").replace("{z}", z).replace("{x}", x).replace("{y}", y));
        if (z <= 15) urls.push(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      }
    }
    if (urls.length > 6000 && !confirm(`${urls.length} tiles is a lot (~${Math.round(urls.length * 0.02)} MB). Continue?`)) return;
    const prog = $("#cacheProg"), out = $("#cacheOut");
    let done = 0, fail = 0;
    const q = urls.slice();
    const worker = async () => {
      while (q.length) {
        const u = q.shift();
        try { await fetch(u, { mode: u.includes("elevation-tiles") ? "cors" : "no-cors" }); } catch (e) { fail++; }
        done++;
        if (done % 10 === 0 || done === urls.length) { prog.style.width = `${(done / urls.length) * 100}%`; out.textContent = `${done}/${urls.length} tiles${fail ? ` · ${fail} failed` : ""}`; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    out.textContent = `Cached ${done - fail} tiles${fail ? ` (${fail} failed)` : ""}. They'll load from cache when you're offline.`;
  }

  // ================================================================== AUTO-SCOUT (Spots) panel
  const KIND_ICON = { thicket: "🌿", island: "⛰️", neck: "⏳", crossing: "🌉", saddle: "🐎", bench: "🪜", point: "📍" };
  const KIND_COLOR = { thicket: "#2e7d32", island: "#c0392b", neck: "#e056fd", crossing: "#00b0ff", saddle: "#e056fd", bench: "#ffb300", point: "#c0392b" };
  let spotOpts = { wetPct: 35, useFlood: false, max: 15 };
  function renderAutoMap() {
    gAuto.clearLayers();
    const A = P.auto;
    if (!A) return;
    A.candidates.forEach((c, i) => {
      if (c.dismissed) return;
      const col = KIND_COLOR[c.kind] || "#ffb300";
      const html = `<div style="background:${col};color:#fff;border:2px solid #fff;border-radius:50%;width:24px;height:24px;font:700 12px/20px system-ui;text-align:center;box-shadow:0 0 6px #000;${c.addedAs ? "opacity:.45" : ""}">${i + 1}</div>`;
      L.marker(c.coords, { icon: L.divIcon({ className: "", html, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 500 })
        .bindTooltip(`#${i + 1} ${KIND_ICON[c.kind] || ""} ${esc(c.title)} · score ${c.score}`, { direction: "top" })
        .on("click", () => { showTab("spots"); const el = $(`#spot-${i}`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("hl"); } })
        .addTo(gAuto);
    });
  }
  function spotToFeature(c, as, day) {
    const notes = `Auto-Scout ${c.title} (score ${c.score}):\n- ${c.reasons.join("\n- ")}${c.setup ? `\nSetup: ${c.setup}` : ""}${c.goodWinds && c.goodWinds.length ? `\nWinds: ${c.goodWinds.join(", ")}` : ""}`;
    if (as === "stand") return newFeature("stand", "Point", c.coords.slice(), { name: `${c.title} setup`, notes, status: "candidate", manualWinds: (c.goodWinds || []).slice(), day: day || "" });
    return newFeature("target", "Point", c.coords.slice(), { name: c.title, notes, status: "to check", day: day || "" });
  }
  async function runAutoScout() {
    const out = $("#spotOut");
    const b = map.getBounds(), spanM = geo.dist([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]);
    if (spanM > 16000) { out.innerHTML = `<p style="color:var(--warn)">Zoom in a bit first. The view is ${(spanM / 1609).toFixed(0)} mi corner to corner. Frame just the unit or property (about 2–8 mi across) for the most detailed analysis.</p>`; return; }
    if (spanM < 600) { out.innerHTML = `<p style="color:var(--warn)">Zoom out so the whole area you might hunt is in view.</p>`; return; }
    out.innerHTML = '<p class="muted">Reading the terrain… (a few seconds)</p>';
    try {
      const r = await WS.autoscout.autoScout({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }, P.features,
        { style: P.terrainStyle, wetPct: spotOpts.wetPct / 100, max: spotOpts.max, floodFt: spotOpts.useFlood ? P.terrain.floodFt : null, cover: await WS.cover.sampler(P), weapon: curWeapon() });
      P.auto = Object.assign(r, { ran: new Date().toISOString(), bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] });
      save(); renderAutoMap(); renderSpots();
      toast(`Found ${r.candidates.length} spots worth a look`);
    } catch (e) { out.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
  }
  function renderSpots() {
    const el = $("#panel-spots"), A = P.auto;
    const scoutDays = H.days.filter((d) => d.kind === "scout");
    const live = A ? A.candidates.filter((c) => !c.dismissed) : [];
    el.innerHTML = `
      <h3>🎯 Auto-Scout: find spots for me</h3>
      <div class="card">
        <p class="small">Frame the area you'll hunt on the map, then press the button. Auto-Scout reads the elevation and picks out the terrain features that concentrate deer: ${P.terrainStyle === "hill" ? "<b>saddles, benches, and ridge points</b>" : "<b>high-ground bedding islands, land bridges between wet ground, and the narrowest slough crossings</b>"}. Each spot is ranked and explained. It also uses anything you've marked: access (to find low-pressure ground), sign, food, bedding, and no-go areas.</p>
        <div class="field"><span>Hunting with</span><div class="btn-row">${Object.values(WS.autoscout.WEAPONS).map((wp) => `<button class="btn ${curWeapon() === wp.key ? "on" : ""}" data-wpn="${wp.key}">${wp.icon} ${wp.label}</button>`).join("")}</div>
          <div class="small muted">${({ bow: "Ranks tight funnels, crossings, and thick-cover edges where deer pass within 15–30 yd. Setups are trees to hang in, with shooting lanes to trim.", muzzle: "Ranks funnels you can cover out to about 150 yd, using openings within that range.", rifle: "Ranks funnels plus openings and cutovers out to about 350 yd for longer shots." })[curWeapon()]}</div></div>
        <div class="row"><span class="small muted">Terrain</span><b class="small">${TERRAIN_STYLES[P.terrainStyle]}</b><button class="btn small" id="toProp2">change</button></div>
        <div class="row small"><span class="muted">Cover data</span>${P.canopy ? '<span class="pill good">🌳 canopy height loaded</span>' : '<span class="pill warn">no canopy data</span>'}${P.overlays.filter((o) => o.analysis).length ? `<span class="pill good">📷 ${P.overlays.filter((o) => o.analysis).length} screenshot(s) analyzed</span>` : ""}<button class="btn small" id="toLayers">${P.canopy ? "view" : "add"}</button></div>
        ${P.canopy ? "" : '<p class="small muted">Without cover data, Auto-Scout uses terrain only. Add canopy height on the Layers tab to find thick bedding cover, edges, and rifle openings.</p>'}
        ${P.terrainStyle !== "hill" ? `<div class="row"><span class="small muted">Low/wet ground = lowest</span><input type="range" id="wetPct" min="15" max="60" step="5" value="${spotOpts.wetPct}"><span class="small" id="wetV">${spotOpts.wetPct}%</span></div>
        <label class="row small"><input type="checkbox" id="useFlood" ${spotOpts.useFlood ? "checked" : ""}> Use the Flood slider level instead (${P.terrain.floodFt.toFixed(1)} ft). Good when you know the river stage.</label>` : ""}
        <div class="row"><span class="small muted">How many spots</span><select id="spotMax">${[8, 12, 15, 20].map((n) => `<option ${spotOpts.max === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
        <div class="btn-row"><button class="btn accent" id="runSpots">🔎 Find spots in this view</button>${A ? '<button class="btn small" id="clearSpots">Clear</button>' : ""}</div>
        <div id="spotOut" class="small">${A && A.stats.weapon && A.stats.weapon !== curWeapon() ? `<p style="color:var(--warn)">These spots were ranked for ${WS.autoscout.WEAPONS[A.stats.weapon].icon} ${WS.autoscout.WEAPONS[A.stats.weapon].label}. Press <b>Find spots</b> to re-rank them for ${WS.autoscout.WEAPONS[curWeapon()].label}.</p>` : ""}${A ? `<p class="muted">${A.stats.weapon ? `Ranked for ${WS.autoscout.WEAPONS[A.stats.weapon].icon} ${WS.autoscout.WEAPONS[A.stats.weapon].label} · ` : ""}${A.stats.mode === "bottomland" ? `Bottomland mode · ground relief ${A.stats.reliefFt.toFixed(1)} ft · wet line ${A.stats.thrFt.toFixed(1)} ft` : `Hill mode · relief ${A.stats.reliefFt.toFixed(0)} ft`} · ${A.stats.found} features found, top ${A.candidates.length} kept · run ${new Date(A.ran).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>` : ""}</div>
      </div>
      ${live.length ? `
      <div class="card hl">
        <b>Turn these into a plan</b>
        <p class="small">${scoutDays.length ? `Adds the spots as 🔎 Scout Targets, split across your ${scoutDays.length} scouting day(s) by area so each day covers one part of the property. Spots with workable winds also become 🎯 stand candidates for the hunt. Then use <b>Plan → Plan route</b> for each day.` : "Adds the spots as 🔎 Scout Targets. Add scouting days to your hunt (Property tab) to have them split by day."}</p>
        <div class="btn-row"><button class="btn small accent" id="addAllSpots">➕ Add all ${live.filter((c) => !c.addedAs).length} to my plan</button><button class="btn small" id="exportSpots">⬇️ KML for onX</button></div>
      </div>
      ${A.candidates.map((c, i) => c.dismissed ? "" : `
      <div class="card" id="spot-${i}" style="${c.addedAs ? "opacity:.6" : ""}">
        <div class="row"><span style="background:${KIND_COLOR[c.kind]};color:#fff;border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${i + 1}</span>
          <strong style="flex:1">${KIND_ICON[c.kind] || ""} ${esc(c.title)}</strong><span class="score" style="font-size:16px">${c.score}</span></div>
        <ul class="small" style="padding-left:18px;margin:6px 0">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        ${c.setup ? `<p class="small"><b>${(WS.autoscout.WEAPONS[A.stats.weapon] || WS.autoscout.WEAPONS.rifle).icon} ${(WS.autoscout.WEAPONS[A.stats.weapon] || WS.autoscout.WEAPONS.rifle).label} setup:</b> ${esc(c.setup)}</p><p class="small"><b>Winds that work:</b> ${c.windNote ? esc(c.windNote) : (c.goodWinds || []).map((w) => `<span class="pill good">${w}</span>`).join("") || '<span class="pill bad">none clean. Scout it, then hunt the edges</span>'}</p>` : ""}
        <div class="btn-row">
          <button class="btn small" data-zoom="${i}">Zoom</button>
          ${c.addedAs ? `<span class="pill good">added as ${c.addedAs}</span>` : `<button class="btn small" data-add="${i}" data-as="target">＋ Scout target</button>${c.setup ? `<button class="btn small" data-add="${i}" data-as="stand">＋ Stand idea</button>` : ""}`}
          <button class="btn small ghost" data-dis="${i}">Dismiss</button>
        </div>
      </div>`).join("")}` : A ? '<p class="muted small">No strong terrain features found in this view. Try a different wet-ground %, zoom to a different part of the property, or switch terrain style.</p>' : ""}
      <details class="card small"><summary>How Auto-Scout decides</summary>
        <p><b>Bottomland:</b> the lowest X% of the ground in view is treated as wet/low. Blobs of ground well above their surroundings become bedding candidates. Dry necks under about 100 yd wide with low ground on both sides become pinch points. Low channels under about 50 yd wide become crossings. Pinch points and crossings near high ground score extra because they connect bedding to everything else.</p>
        <p><b>Hills:</b> saddles (a low gap with rise on both sides), benches (a flat shelf between steep ground), and ridge points.</p>
        <p><b>Your marks:</b> spots far from the roads, parking, and ATV trails you've marked score higher (less pressure). Nearby logged sign, food, or bedding adds points. Anything inside a ⛔ No-Go area is dropped.</p>
        <p><b>Cover (when loaded):</b> canopy height splits the ground into open (under 2 m), thick young growth (2–8 m: regen, cutovers, plantings, brush), pole timber (8–15 m), and mature timber (15 m+). Thick patches on dry ground become bedding candidates. High ground with thick growth scores up, and open high ground scores down. Funnels score up where thicket meets mature timber. For rifle setups, it searches 30–320 m around each funnel for the longest opening to shoot across. Your analyzed onX screenshots add newer openings and water.</p>
        <p><b>Limits:</b> it can't tell tree species or acorn crop, and canopy height is from about 2020 imagery, so recent cuts may be missing (analyze a current onX screenshot to catch them). Elevation is about 3–10 m resolution. Confirm everything on foot.</p>
      </details>`;
    $("#toProp2").onclick = () => showTab("prop");
    $("#toLayers").onclick = () => showTab("layers");
    $$("[data-wpn]", el).forEach((b) => (b.onclick = () => { setWeapon(b.dataset.wpn); renderSpots(); renderCountdown(); }));
    if ($("#wetPct")) { $("#wetPct").oninput = (e) => { spotOpts.wetPct = +e.target.value; $("#wetV").textContent = e.target.value + "%"; }; $("#useFlood").onchange = (e) => { spotOpts.useFlood = e.target.checked; }; }
    $("#spotMax").onchange = (e) => { spotOpts.max = +e.target.value; };
    $("#runSpots").onclick = runAutoScout;
    if ($("#clearSpots")) $("#clearSpots").onclick = () => { P.auto = null; save(); renderAutoMap(); renderSpots(); };
    $$("[data-zoom]", el).forEach((b) => (b.onclick = () => map.setView(A.candidates[+b.dataset.zoom].coords, Math.max(map.getZoom(), 16))));
    $$("[data-dis]", el).forEach((b) => (b.onclick = () => { A.candidates[+b.dataset.dis].dismissed = true; save(); renderAutoMap(); renderSpots(); }));
    $$("[data-add]", el).forEach((b) => (b.onclick = () => {
      const c = A.candidates[+b.dataset.add];
      spotToFeature(c, b.dataset.as); c.addedAs = b.dataset.as === "stand" ? "stand" : "scout target";
      save(); renderFeatures(); renderAutoMap(); renderSpots(); toast(`Added #${+b.dataset.add + 1} to your map`);
    }));
    if ($("#addAllSpots")) $("#addAllSpots").onclick = () => {
      const todo = A.candidates.filter((c) => !c.dismissed && !c.addedAs);
      const groups = WS.autoscout.groupByArea(todo, Math.max(1, scoutDays.length));
      // order groups so day 1 = the group with the highest-scoring spot
      const gScore = {}; todo.forEach((c, i) => (gScore[groups[i]] = Math.max(gScore[groups[i]] || 0, c.score)));
      const order = Object.keys(gScore).sort((a, b) => gScore[b] - gScore[a]).map(Number);
      let stands = 0;
      todo.forEach((c, i) => {
        const day = scoutDays.length ? scoutDays[order.indexOf(groups[i]) % scoutDays.length].date : "";
        spotToFeature(c, "target", day); c.addedAs = "scout target";
        if (c.hunt && stands < 8) { spotToFeature(c, "stand", ""); c.addedAs = "scout target + stand idea"; stands++; }
      });
      save(); renderFeatures(); renderAutoMap(); renderSpots();
      toast(`Added ${todo.length} scout targets${scoutDays.length ? ` across ${scoutDays.length} day(s)` : ""} and ${stands} stand ideas. See the Plan tab.`, 4500);
    };
    if ($("#exportSpots")) $("#exportSpots").onclick = () => {
      const fs = live.map((c, i) => ({ type: c.setup ? "funnel" : "target", name: `#${i + 1} ${c.title} (${c.score})`, notes: c.reasons.join(" | ") + (c.setup ? " | Setup: " + c.setup + " | Winds: " + (c.goodWinds || []).join(",") : ""), geom: { type: "Point", coords: c.coords } }));
      io.download(`${slug(P.name)}-auto-scout.kml`, io.toKML(fs, `Auto-Scout – ${P.name}`), "application/vnd.google-earth.kml+xml");
    };
  }

  // ================================================================== PROPERTY panel & switching
  const slug = (t) => String(t || "property").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "property";
  function renderPropSelect() {
    const el = $("#propSelect");
    el.innerHTML = S.properties.map((p) => `<option value="${p.id}" ${p.id === P.id ? "selected" : ""}>${esc(p.name)}</option>`).join("") + `<option value="__new">➕ New property…</option>`;
  }
  $("#propSelect").onchange = (e) => {
    if (e.target.value === "__new") { addProperty(); return; }
    switchProperty(e.target.value);
  };
  function addProperty() {
    const name = prompt("Name this property (e.g. Yazoo NWR, Dad's lease, Sunflower WMA):", "");
    if (!name) { renderPropSelect(); return; }
    const c = map.getCenter();
    const p = newProperty({ name, center: [c.lat, c.lng], zoom: map.getZoom(), tz: P.tz, state: P.state });
    S.properties.push(p); save();
    switchProperty(p.id);
    showTab("prop");
    toast("New property created at the current map view. Set land type, rut date and add a hunt.", 4500);
  }
  async function switchProperty(id) {
    cancelDraw(); sel = null; overlayEdit = null;
    S.activePropertyId = id; bindActive(); save();
    gRoute.clearLayers(); gEdit.clearLayers();
    map.setView(P.center || map.getCenter(), P.zoom || map.getZoom());
    syncTerrain(); redrawTerrain();
    renderImportsOnMap(); await renderOverlaysOnMap(); renderFeatures(); renderModel(); renderAutoMap(); renderCanopyOnMap();
    if (map.hasLayer(gHeat)) renderHeat();
    renderCountdown(); renderPropSelect();
    const active = $(".tabs button.active");
    showTab(active ? active.dataset.tab : "prop");
  }
  async function deleteProperty(p) {
    if (S.properties.length === 1) return toast("Keep at least one property. Rename this one instead.");
    if (!confirm(`Delete "${p.name}" and ALL its markers, overlays, photos and hunts? This can't be undone.`)) return;
    for (const o of p.overlays) { await store.delBlob(o.blobKey); if (o.analysis) await store.delBlob(o.analysis.blobKey); }
    if (p.canopy) await store.delBlob(p.canopy.blobKey);
    for (const f of p.features) for (const k of f.photos || []) await store.delBlob(k);
    S.properties = S.properties.filter((x) => x !== p);
    S.activePropertyId = S.properties[0].id; save();
    switchProperty(S.activePropertyId);
  }
  function renderProp() {
    const el = $("#panel-prop");
    el.innerHTML = `
      <h3>Your ground</h3>
      <ul class="list">${S.properties.map((p) => `<li data-pid="${p.id}" style="${p.id === P.id ? "background:#2a1c0e" : ""}"><span class="ic">${p.landType === "private" || p.landType === "lease" ? "🏡" : p.landType === "nwr" ? "🦆" : "🌳"}</span><div class="grow">${esc(p.name)}<div class="sub">${LAND_TYPES[p.landType] || ""}${p.state ? " · " + esc(p.state) : ""} · ${p.features.length} markers · ${p.hunts.length} hunt${p.hunts.length === 1 ? "" : "s"}</div></div>${p.id === P.id ? '<span class="pill good">active</span>' : ""}</li>`).join("")}</ul>
      <div class="btn-row"><button class="btn small accent" id="addProp">➕ New property</button></div>

      <h3>Property details</h3>
      <div class="card">
        <div class="field"><span>Name</span><input type="text" id="pName" value="${esc(P.name)}"></div>
        <div class="row">
          <div class="field" style="flex:1"><span>Land type</span><select id="pType">${Object.entries(LAND_TYPES).map(([k, v]) => `<option value="${k}" ${P.landType === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field" style="width:70px"><span>State</span><input type="text" id="pState" maxlength="2" value="${esc(P.state)}" placeholder="MS"></div>
        </div>
        <div class="row">
          <div class="field" style="flex:1"><span>Terrain</span><select id="pTerrain">${Object.entries(TERRAIN_STYLES).map(([k, v]) => `<option value="${k}" ${P.terrainStyle === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field" style="flex:1"><span>Time zone</span><select id="pTz">${TIMEZONES.map((z) => `<option ${P.tz === z ? "selected" : ""}>${z}</option>`).join("")}</select></div>
        </div>
        <div class="row">
          <div class="field" style="flex:1"><span>Legal light (min before sunrise / after sunset)</span><input type="number" id="pLegal" min="0" max="60" value="${P.legalMin ?? 30}"></div>
        </div>
        <div class="field"><span>River gauge link (optional, e.g. water.noaa.gov/gauges/…)</span><input type="text" id="pGauge" value="${esc(P.gaugeUrl)}" placeholder="https://water.noaa.gov/gauges/…"></div>
        <div class="field"><span>Notes: access, contacts, gate codes, emergency address</span><textarea id="pNotes">${esc(P.notes)}</textarea></div>
        <div class="btn-row"><button class="btn small" id="pHome">⌂ Set home view to current map</button>${P.homeSet ? '<span class="pill good">home locked</span>' : '<span class="pill warn">home not locked</span>'}</div>
        <div class="btn-row"><button class="btn small danger" id="pDel">Delete property</button></div>
      </div>

      <h3>Hunts on this property</h3>
      <div id="huntList">${P.hunts.map((h) => `
        <div class="card ${h.id === H.id ? "hl" : ""}" data-hid="${h.id}">
          <div class="row"><input type="text" class="hName" value="${esc(h.name)}"><select class="hWpn" style="width:130px">${Object.values(WS.autoscout.WEAPONS).map((wp) => `<option value="${wp.key}" ${(h.weapon || "rifle") === wp.key ? "selected" : ""}>${wp.icon} ${wp.label}</option>`).join("")}</select><button class="btn small hAct ${h.id === H.id ? "on" : ""}">${h.id === H.id ? "Active" : "Make active"}</button><button class="btn small danger hDel">✕</button></div>
          <div class="row">
            <div class="field" style="flex:1"><span>Scouting starts</span><input type="date" class="hScout" value="${h.scoutStart}"></div>
            <div class="field" style="flex:1"><span>Hunt starts</span><input type="date" class="hStart" value="${h.start}"></div>
            <div class="field" style="flex:1"><span>Hunt ends</span><input type="date" class="hEnd" value="${h.end}"></div>
          </div>
          <div class="small muted">${h.scoutStart ? `${Math.max(0, dayDiff(h.scoutStart, h.start))} scouting day(s) + ` : ""}${dayDiff(h.start, h.end) + 1} hunt day(s). Plan cards update when dates change; notes on days you keep are preserved.</div>
        </div>`).join("") || '<p class="muted small">No hunts yet.</p>'}</div>
      <div class="btn-row"><button class="btn small accent" id="addHunt">➕ Add hunt</button></div>

      <h3>Rules to verify: ${LAND_TYPES[P.landType] || ""}</h3>
      <div class="card">
        ${P.regs.map((t) => `<div class="check ${t.done ? "done" : ""}" data-r="${t.id}"><input type="checkbox" ${t.done ? "checked" : ""}><span>${esc(t.text)}</span><button class="x">✕</button></div>`).join("")}
        <div class="row"><input type="text" id="newReg" placeholder="Add a rule to check…"><button class="btn small" id="addReg">Add</button></div>
        <div class="btn-row"><button class="btn small" id="loadRegs">Add ${LAND_TYPES[P.landType]} template items</button></div>
      </div>`;
    $$("[data-pid]", el).forEach((li) => (li.onclick = () => li.dataset.pid !== P.id && switchProperty(li.dataset.pid)));
    $("#addProp").onclick = addProperty;
    const bind = (id, key, after, num) => ($("#" + id).onchange = (e) => { P[key] = num ? +e.target.value : e.target.value; save(); after && after(); });
    bind("pName", "name", () => { renderPropSelect(); renderCountdown(); renderProp(); });
    bind("pType", "landType", () => {
      // untouched checklist -> swap in the new land type's template
      if (!P.regs.some((r) => r.done)) P.regs = (REG_TEMPLATES[P.landType] || []).map((t) => ({ id: uid(), text: t, done: false }));
      save(); renderProp();
    });
    bind("pState", "state", null);
    bind("pTerrain", "terrainStyle", null);
    bind("pTz", "tz", () => { bindActive(); renderCountdown(); });
    bind("pLegal", "legalMin", null, true);
    bind("pGauge", "gaugeUrl", null);
    $("#pNotes").oninput = (e) => { P.notes = e.target.value; save(); };
    $("#pHome").onclick = () => { P.center = [map.getCenter().lat, map.getCenter().lng]; P.zoom = map.getZoom(); P.homeSet = true; save(); renderProp(); toast("Home view locked for " + P.name); };
    $("#pDel").onclick = () => deleteProperty(P);
    $$("[data-hid]", el).forEach((card) => {
      const h = P.hunts.find((x) => x.id === card.dataset.hid);
      $(".hName", card).onchange = (e) => { h.name = e.target.value; save(); renderCountdown(); };
      $(".hWpn", card).onchange = (e) => { h.weapon = e.target.value; bindActive(); save(); renderCountdown(); };
      const dates = () => {
        h.scoutStart = $(".hScout", card).value; h.start = $(".hStart", card).value || h.start; h.end = $(".hEnd", card).value || h.start;
        if (dayDiff(h.start, h.end) < 0) h.end = h.start;
        if (h.scoutStart && dayDiff(h.scoutStart, h.start) < 0) h.scoutStart = "";
        if (h.scoutStart && dayDiff(h.scoutStart, h.start) > 14) h.scoutStart = addDays(h.start, -14);
        rebuildDays(P, h); save(); renderCountdown(); renderProp();
      };
      $(".hScout", card).onchange = dates; $(".hStart", card).onchange = dates; $(".hEnd", card).onchange = dates;
      $(".hAct", card).onclick = () => { P.activeHuntId = h.id; bindActive(); save(); renderCountdown(); renderProp(); };
      $(".hDel", card).onclick = () => { if (!confirm(`Delete hunt "${h.name}" and its plan days?`)) return; P.hunts = P.hunts.filter((x) => x !== h); if (P.activeHuntId === h.id) P.activeHuntId = P.hunts[0] ? P.hunts[0].id : ""; bindActive(); save(); renderCountdown(); renderProp(); };
    });
    $("#addHunt").onclick = () => {
      const start = isoDay(new Date(Date.now() + 14 * 864e5));
      const h = newHunt(P, { name: "Hunt " + (P.hunts.length + 1), scoutStart: addDays(start, -2), start, end: addDays(start, 2), weapon: curWeapon() });
      P.hunts.push(h); P.activeHuntId = h.id; bindActive(); save(); renderCountdown(); renderProp();
    };
    $$("[data-r]", el).forEach((row) => {
      const t = P.regs.find((x) => x.id === row.dataset.r);
      $("input", row).onchange = (e) => { t.done = e.target.checked; save(); row.classList.toggle("done", t.done); };
      $(".x", row).onclick = () => { P.regs = P.regs.filter((x) => x !== t); save(); renderProp(); };
    });
    $("#addReg").onclick = () => { const v = $("#newReg").value.trim(); if (v) { P.regs.push({ id: uid(), text: v, done: false }); save(); renderProp(); } };
    $("#loadRegs").onclick = () => { const have = new Set(P.regs.map((r) => r.text)); (REG_TEMPLATES[P.landType] || []).filter((t) => !have.has(t)).forEach((t) => P.regs.push({ id: uid(), text: t, done: false })); save(); renderProp(); };
  }

  // ================================================================== boot
  renderPropSelect();
  renderCountdown();
  renderImportsOnMap();
  await renderOverlaysOnMap();
  renderFeatures();
  renderModel();
  renderAutoMap();
  renderCanopyOnMap();
  renderLayers();
  if (window.innerWidth < 760) $("#sidebar").classList.add("collapsed");
  setTimeout(() => map.invalidateSize(), 100);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!P.features.length && !P.imports.length) setTimeout(() => toast("Pick or add a property (top bar), then import your onX KML/GPX on the Data tab.", 5000), 800);
  window.WSApp = { S: () => S, P: () => P, map, select, renderIntel, runModel, switchProperty };
})();
