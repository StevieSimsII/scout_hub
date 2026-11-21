# Scout Hub

A local-first web app for scouting and hunt planning across **all your ground**: state WMAs, National Wildlife Refuges, National Forest, other public land, private land, and leases.

Each property keeps its own map, markers, onX imports, screenshot overlays, rules checklist, rut timing, and any number of hunts with scouting days and hunt days.

## Run it

**On a PC:** download or clone this repo, open the folder, and double-click `index.html`. For offline tile caching, serve it instead:

```powershell
py -m http.server 8000     # then open http://localhost:8000
```

**On your phone:** turn on GitHub Pages (Settings → Pages → Deploy from branch → `main` / root). Open `https://<username>.github.io/scout_hub/`, then **Add to Home Screen**.

All data stays in your browser (IndexedDB). Nothing is uploaded. Use **Data → Full backup** to move everything between devices; it includes all properties and photos.

## Tabs

| Tab | What's in it |
| --- | --- |
| 🏞️ **Property** | Your list of ground plus the active property's details: land type, state, terrain style, time zone, legal-light minutes, river gauge link, and notes (access, contacts, gate codes, emergency address). Also a home view, **hunts** (scouting start, hunt start/end), and a **rules-to-verify checklist** pre-filled for the land type (WMA, NWR, NF, state, private, lease). |
| 🎯 **Spots (Auto-Scout)** | Pick your weapon (🏹 Bow / 💥 Muzzleloader / 🎯 Rifle), frame the area, and press **Find spots**. Bow ranks tight funnels, crossings, and thick-cover edges within 15–30 yd and gives tree-and-shooting-lane setups. Rifle adds openings and cutovers out to about 350 yd. It reads the elevation and **cover**, **no marking needed**, and returns ranked spots to scout, each with reasons. Bottomland: high-ground bedding islands and ridges, land bridges/pinch points between wet ground, and the narrowest slough crossings. Hills: saddles, benches, and ridge points. Spots score higher when far from the access you've marked, near logged sign, or near food/bedding. Funnels get a **rifle setup idea and workable winds**. One click adds everything to your scouting days, grouped by area, and creates stand candidates for the hunt. |
| 🗺️ **Layers** | **Tree canopy height** cover layer (open / thick young growth / pole / mature timber). Satellite (Esri), USGS NAIP, USGS Topo/Imagery-Topo, Esri Topo, OpenTopoMap. **Micro-relief hillshade** (1–40× exaggeration). **Relative elevation** stretched to local range. **Flood / backwater simulator**. Imported onX layers and **onX screenshot overlays** you align by dragging corners. |
| ✏️ **Mark** | 30+ feature types: access, habitat, deer sign, and plan (stands, entry/exit routes, scout targets, no-go). Notes, photos, plan-day assignment, status, and a measure tool. |
| 🧠 **Deer Intel** | **Rut timeline** from your area's mean conception date. Sun, legal light, and moon in the property's time zone. **NWS forecast** pull. **Travel-corridor model** over real elevation, with funnel hotspots. **Stand scoring** with good/bad winds and a best-stand-per-wind table. A terrain-reading guide matched to the property's terrain style and land type. |
| 📅 **Plan** | Day cards generated from the hunt's dates: scouting days with task templates and an optimized walking route, hunt days with AM/PM sits per hunter that check the stand against the forecast wind. Gear checklist. |
| 📓 **Log** | Sign summary, filterable log, and sign heat map. **📍 Field Log** for one-tap GPS logging with photo and note. |
| 💾 **Data** | Import onX KML/KMZ/GPX, GeoJSON, images, and backups. Export KML/GPX back to onX. Offline tile caching. |

Switch properties from the dropdown in the top bar, or choose **➕ New property…**. A new property starts at the current map view.

## Cover data: what the trees look like

Auto-Scout gets much better with cover data. It finds **thick bedding cover**, **thicket/mature-timber edges**, and **openings for rifle lanes**.

**1. Canopy height (recommended).** This is tree height from the Meta & World Resources Institute *High Resolution Canopy Height Maps* (about 1 m source data, CC BY 4.0). The source files are huge and browsers can't read them directly, so a small script cuts out just your property:

```bash
pip install rasterio pillow numpy
python tools/canopy_pack.py --name "Dads Lease" --bbox 33.10 -90.55 33.18 -90.45 --res 8
#                                                     SOUTH  WEST   NORTH  EAST
```

Then import the resulting `.canopy.json` on the **Data** tab while that property is active. A Phil Bryant WMA area pack is included in `data/`. On the Layers tab, press **Load Phil Bryant WMA area**. That button needs the app opened via GitHub Pages or `localhost`; when you double-click `index.html`, import the file instead.

Cover classes: open (<2 m), **thick young growth** (2–8 m: regen, cutovers, plantings, brush), pole timber (8–15 m), mature timber (15 m+). The data is from about 2020 imagery, so recent cuts may be missing.

**2. Your onX screenshots.** Add an onX satellite or hybrid screenshot as an overlay, align it, and press **Analyze**. Color and texture analysis marks **openings** (fields, cutovers, roads) and **water**. Auto-Scout uses these as the newest information on openings, which helps catch cuts made after the canopy data. Take the screenshots yourself; automated scraping of onX isn't allowed by their terms.

Neither source can identify tree species or acorn crop. Confirm those on foot.

## Getting onX data in

1. In onX Web Map: My Content → select → **Export** (KML or GPX).
2. Data tab → **Import files**. Press **Convert** on the layer to make the features editable; types are guessed from names.
3. Screenshot onX north-up, import the PNG, and drag the corners to line it up.
4. Property tab → **Set home view to current map**.

## The corridor model

Least-cost paths over AWS Terrain Tiles (USGS 3DEP):

- High ground is cheap and low wet ground is expensive.
- Your logged deer trails, rub lines, ridges, crossings, and funnels pull routes toward them.
- Thick cover is cheaper. Roads and ATV trails are pricier. Open water is a barrier.

Overlapping lanes become hotspots. Every lane is a hypothesis to confirm or kill on foot.

## Always verify the rules

Rules differ by property type and change every year. The checklist on the Property tab is a starting point, not legal advice. Check the current brochure, refuge hunt plan, MVUM, or lease agreement.
