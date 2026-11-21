#!/usr/bin/env python3
"""
Build a Scout Hub "canopy pack" for one property: tree canopy height (meters) for a lat/lng box,
from the Meta / World Resources Institute 1 m Global Canopy Height map (CC BY 4.0), hosted on AWS
Open Data. The browser can't read those files directly (they're huge, and the server doesn't allow
browser access), so this script pulls just the rows it needs and writes a small file you import in
Scout Hub (Data tab -> Import files).

Usage:
    pip install rasterio pillow numpy
    python tools/canopy_pack.py --name "Ten Point" --bbox 32.36 -91.12 32.68 -90.78 --res 8

    --bbox  SOUTH WEST NORTH EAST   (decimal degrees)
    --res   output cell size in meters (default 8; 4-6 = sharper but bigger file)

Output: <name>.canopy.json (bounds + an 8-bit PNG where pixel value = canopy height in meters).
"""
import argparse, base64, io, json, math, sys, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from rasterio.windows import Window
from PIL import Image

BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/"
Z = 9                       # source files are web-mercator quadkey tiles at zoom 9
R = 6378137.0
HALF = math.pi * R          # 20037508.34


def merc(lat, lng):
    x = math.radians(lng) * R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R
    return x, y


def quadkey(tx, ty, z):
    q = ""
    for i in range(z, 0, -1):
        d, m = 0, 1 << (i - 1)
        if tx & m: d += 1
        if ty & m: d += 2
        q += str(d)
    return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"), required=True)
    ap.add_argument("--res", type=float, default=8.0)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    s, w, n, e = a.bbox
    x0, y0 = merc(s, w)
    x1, y1 = merc(n, e)
    scale = 1 / math.cos(math.radians((s + n) / 2))     # mercator meters per ground meter
    step_m = a.res * scale                               # output cell size in mercator meters
    W = int(math.ceil((x1 - x0) / step_m))
    H = int(math.ceil((y1 - y0) / step_m))
    print(f"{a.name}: {W}x{H} cells at {a.res} m", file=sys.stderr)
    out = np.zeros((H, W), dtype=np.uint8)

    tile_m = 2 * HALF / (1 << Z)
    datasets = {}

    def ds_for(tx, ty):
        k = (tx, ty)
        if k not in datasets:
            try:
                datasets[k] = rasterio.open("/vsicurl/" + BASE + quadkey(tx, ty, Z) + ".tif")
            except Exception as ex:  # ocean / missing tile
                print("  missing tile", quadkey(tx, ty, Z), ex, file=sys.stderr)
                datasets[k] = None
        return datasets[k]

    # output row j covers mercator y = y1 - (j+0.5)*step
    xs = x0 + (np.arange(W) + 0.5) * step_m
    txs = np.floor((xs + HALF) / tile_m).astype(int)

    # open datasets serially first (rasterio handles aren't safe to create concurrently)
    for j in (0, H - 1):
        y = y1 - (j + 0.5) * step_m
        for tx in np.unique(txs):
            ds_for(int(tx), int((HALF - y) // tile_m))
    t0, done = time.time(), 0
    # GDAL dataset handles aren't thread-safe; use one handle set per worker
    import threading
    local = threading.local()

    def worker(j):
        if not hasattr(local, "ds"):
            local.ds = {}
        y = y1 - (j + 0.5) * step_m
        ty = int((HALF - y) // tile_m)
        row = np.zeros(W, dtype=np.uint8)
        for tx in np.unique(txs):
            k = (int(tx), ty)
            if datasets.get(k, 1) is None:
                continue
            if k not in local.ds:
                try:
                    local.ds[k] = rasterio.open("/vsicurl/" + BASE + quadkey(k[0], k[1], Z) + ".tif")
                except Exception:
                    local.ds[k] = None
            ds = local.ds[k]
            if ds is None:
                continue
            sel = np.where(txs == tx)[0]
            px = ((xs[sel] - ds.bounds.left) / ds.res[0]).astype(int).clip(0, ds.width - 1)
            py = min(max(int((ds.bounds.top - y) / ds.res[1]), 0), ds.height - 1)
            c0, c1 = int(px.min()), int(px.max()) + 1
            for attempt in range(3):
                try:
                    data = ds.read(1, window=Window(c0, py, c1 - c0, 1))[0]
                    row[sel] = data[px - c0]
                    break
                except Exception:
                    time.sleep(1 + attempt)
        return j, row

    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES", VSI_CACHE="TRUE", GDAL_CACHEMAX=512):
        with ThreadPoolExecutor(max_workers=12) as ex:
            for j, row in ex.map(worker, range(H)):
                out[j] = row
                done += 1
                if done % 200 == 0:
                    el = time.time() - t0
                    print(f"  {done}/{H} rows  ({el:.0f}s, ~{el / done * (H - done):.0f}s left)", file=sys.stderr)

    buf = io.BytesIO()
    Image.fromarray(out, mode="L").save(buf, format="PNG", optimize=True)
    pack = {
        "type": "scouthub-canopy", "version": 1, "name": a.name,
        "bounds": [[s, w], [n, e]], "width": W, "height": H, "resM": a.res, "units": "m",
        "source": "Meta & World Resources Institute, High Resolution Canopy Height Maps (2024), CC BY 4.0",
        "png": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
    }
    fn = a.out or (a.name.lower().replace(" ", "-") + ".canopy.json")
    with open(fn, "w") as f:
        json.dump(pack, f)
    nz = out[out > 0]
    print(f"wrote {fn} ({len(buf.getvalue()) / 1e6:.1f} MB PNG); canopy>0 in {100 * nz.size / out.size:.0f}% of cells, "
          f"median {np.median(nz) if nz.size else 0:.0f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
