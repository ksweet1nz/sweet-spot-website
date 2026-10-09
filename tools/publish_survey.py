#!/usr/bin/env python3
"""
Publish a DJI Terra survey to the web survey viewer.

Takes a DJI Terra project output folder, converts the results into
web-friendly formats, writes project.json and (optionally) uploads the
lot to object storage. Prints the client's personal link.

  2D  map/result.tif  (orthomosaic)  -> XYZ map tiles
      map/dsm.tif     (DSM)          -> colour-relief XYZ tiles + legend
  3D  .../terra_b3dms/tileset.json   (mesh, 3D Tiles)  -> copied as-is
      .../terra_pnts/tileset.json    (point cloud)     -> copied as-is

Requires GDAL command-line tools (gdalinfo, gdaldem, gdal2tiles.py) and,
for --upload, rclone. Run with --help for options.
"""

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

DSM_COLOURS = ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]
GDAL_ENV = dict(os.environ, GDAL_PAM_ENABLED="NO")  # never write .aux.xml into the Terra folder


# ---------- helpers ----------

def log(msg):
    print(msg, flush=True)


def run(cmd):
    log("  $ " + " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, env=GDAL_ENV)


def gdalinfo(path, stats=False):
    cmd = ["gdalinfo", "-json"]
    if stats:
        cmd.append("-approx_stats")
    out = subprocess.run(cmd + [str(path)], check=True, capture_output=True, text=True, env=GDAL_ENV)
    return json.loads(out.stdout)


def find_gdal2tiles():
    for name in ("gdal2tiles.py", "gdal2tiles"):
        if shutil.which(name):
            return name
    sys.exit("gdal2tiles not found. Install GDAL (e.g. `conda install -c conda-forge gdal`).")


def human_size(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def path_size(p):
    p = Path(p)
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


# ---------- DJI Terra output discovery ----------

def first(paths):
    paths = sorted(paths, key=lambda p: (len(p.parts), str(p)))
    return paths[0] if paths else None


def discover(terra_dir):
    """Locate the standard DJI Terra outputs inside a project folder."""
    d = Path(terra_dir)
    tifs = list(d.rglob("*.tif")) + list(d.rglob("*.tiff"))
    tilesets = list(d.rglob("tileset.json"))

    def named(pattern):
        return [p for p in tifs if re.search(pattern, p.name, re.I)]

    found = {
        "ortho": first(named(r"^result\.tiff?$")) or first(named(r"(ortho|dom)")),
        "dsm": first(named(r"^dsm\.tiff?$")) or first(named(r"dsm")),
        "mesh": first([t for t in tilesets if re.search(r"b3dm", str(t), re.I)]),
        "pointcloud": first([t for t in tilesets if re.search(r"pnts", str(t), re.I)]),
        "las": first(list(d.rglob("*.las")) + list(d.rglob("*.laz"))),
    }
    # A lone tileset with no recognisable folder name is treated as the mesh.
    if not found["mesh"] and not found["pointcloud"] and len(tilesets) == 1:
        found["mesh"] = tilesets[0]
    return found


# ---------- raster processing ----------

def raster_summary(info):
    """Bounds [w,s,e,n] in WGS84, GSD in cm, CRS name."""
    ring = info["wgs84Extent"]["coordinates"][0]
    lons = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    bounds = [round(min(lons), 8), round(min(lats), 8), round(max(lons), 8), round(max(lats), 8)]

    gsd = crs = None
    wkt = info.get("coordinateSystem", {}).get("wkt", "")
    m = re.match(r'\s*(?:PROJCRS|PROJCS|GEOGCRS|GEOGCS)\["([^"]+)"', wkt)
    if m:
        crs = m.group(1)
    if wkt.startswith(("PROJCRS", "PROJCS")) and "geoTransform" in info:
        gsd = round(abs(info["geoTransform"][1]) * 100, 2)
    return bounds, gsd, crs


def covered_area_ha(info):
    """Area of valid (non-transparent) pixels, from the alpha band's mean."""
    bands = info.get("bands", [])
    alpha = next((b for b in bands if b.get("colorInterpretation") == "Alpha"), None)
    wkt = info.get("coordinateSystem", {}).get("wkt", "")
    if not alpha or "mean" not in alpha or not wkt.startswith(("PROJCRS", "PROJCS")):
        return None
    w, h = info["size"]
    px = abs(info["geoTransform"][1] * info["geoTransform"][5])
    return round(w * h * px * (alpha["mean"] / 255) / 10000, 2)


def tile(src, dest, args, zoom=None):
    cmd = [find_gdal2tiles(), "--xyz", "-w", "none", "-r", "average", f"--processes={args.processes}"]
    ext = "png"
    if args.webp:
        cmd += ["--tiledriver=WEBP", "--webp-quality=85"]
        ext = "webp"
    if zoom:
        cmd += ["-z", zoom]
    run(cmd + [src, dest])

    levels = sorted(int(p.name) for p in Path(dest).iterdir() if p.is_dir() and p.name.isdigit())
    if not levels:
        sys.exit(f"gdal2tiles produced no tiles for {src}")
    # gdal2tiles also writes viewer HTML we don't need.
    for extra in ("leaflet.html", "openlayers.html", "googlemaps.html", "tilemapresource.xml"):
        (Path(dest) / extra).unlink(missing_ok=True)
    return levels[0], levels[-1], ext


def dsm_colour_relief(dsm, work):
    info = gdalinfo(dsm, stats=True)
    band = info["bands"][0]
    lo, hi = band["minimum"], band["maximum"]
    if "mean" in band and "stdDev" in band:
        lo = max(lo, band["mean"] - 2.5 * band["stdDev"])
        hi = min(hi, band["mean"] + 2.5 * band["stdDev"])
    if hi - lo < 0.01:
        hi = lo + 1

    ramp = work / "dsm_ramp.txt"
    lines = ["nv 0 0 0 0"]
    for i, hexc in enumerate(DSM_COLOURS):
        v = lo + (hi - lo) * i / (len(DSM_COLOURS) - 1)
        r, g, b = (int(hexc[k:k + 2], 16) for k in (1, 3, 5))
        lines.append(f"{v:.3f} {r} {g} {b} 255")
    ramp.write_text("\n".join(lines) + "\n")

    out = work / "dsm_colour.tif"
    run(["gdaldem", "color-relief", dsm, ramp, out, "-alpha", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES"])
    return out, round(lo, 1), round(hi, 1)


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("terra_dir", nargs="?", help="DJI Terra project output folder")
    ap.add_argument("--title", required=True, help='Project title, e.g. "Stockpile survey - Lot 12"')
    ap.add_argument("--client", default="", help="Client name shown above the title")
    ap.add_argument("--date", default=date.today().isoformat(), help="Capture date (YYYY-MM-DD)")
    ap.add_argument("--location", default="", help="Site location text")
    ap.add_argument("--description", default="", help="Short notes shown in the panel")
    ap.add_argument("--expires", help="Link expiry date (YYYY-MM-DD); the viewer refuses to open after it")

    ap.add_argument("--ortho", help="Orthomosaic GeoTIFF (overrides auto-detection)")
    ap.add_argument("--dsm", help="DSM GeoTIFF (overrides auto-detection)")
    ap.add_argument("--mesh", help="Mesh tileset.json (overrides auto-detection)")
    ap.add_argument("--pointcloud", help="Point cloud tileset.json (overrides auto-detection)")
    ap.add_argument("--no-dsm", action="store_true", help="Skip the DSM layer")
    ap.add_argument("--no-pointcloud", action="store_true", help="Skip the point cloud layer")
    ap.add_argument("--downloads", action="store_true",
                    help="Also offer the original GeoTIFFs / LAS as downloads")

    ap.add_argument("--ortho-zoom", help='Zoom range for ortho tiles, e.g. "15-22" (default: auto)')
    ap.add_argument("--webp", action="store_true", help="Write WebP tiles (smaller; needs GDAL >= 3.6)")
    ap.add_argument("--processes", type=int, default=os.cpu_count() or 2, help="Parallel tiling processes")

    ap.add_argument("--token", help="Reuse an existing token to update a published project")
    ap.add_argument("--out", default="published", help="Local staging folder (default: ./published)")
    ap.add_argument("--upload", metavar="REMOTE",
                    help='rclone destination for the data bucket, e.g. "r2:surveys"')
    ap.add_argument("--site-url", default="https://sweetspotadvisory.com.au/survey/",
                    help="Public URL of the viewer page")
    args = ap.parse_args()

    found = discover(args.terra_dir) if args.terra_dir else {}
    for key in ("ortho", "dsm", "mesh", "pointcloud"):
        if getattr(args, key):
            found[key] = Path(getattr(args, key))
    if args.no_dsm:
        found["dsm"] = None
    if args.no_pointcloud:
        found["pointcloud"] = None

    log("Found:")
    for key in ("ortho", "dsm", "mesh", "pointcloud", "las"):
        log(f"  {key:<11} {found.get(key) or '-'}")
    if not any(found.get(k) for k in ("ortho", "mesh", "pointcloud")):
        sys.exit("Nothing to publish: no orthomosaic or 3D tiles found.")

    token = args.token or secrets.token_urlsafe(16)
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,128}", token):
        sys.exit("Token must be 6-128 characters of A-Z, a-z, 0-9, _ or -")
    out = Path(args.out) / token
    work = Path(args.out) / f".work-{token}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    work.mkdir(parents=True, exist_ok=True)

    project = {
        "version": 1,
        "title": args.title,
        "client": args.client,
        "date": args.date,
        "location": args.location,
        "description": args.description,
        "layers": [],
        "downloads": [],
    }
    if args.expires:
        project["expires"] = args.expires

    try:
        if found.get("ortho"):
            log("\nOrthomosaic -> tiles")
            info = gdalinfo(found["ortho"], stats=True)
            bounds, gsd, crs = raster_summary(info)
            zmin, zmax, ext = tile(found["ortho"], out / "ortho", args, args.ortho_zoom)
            project.update({"bounds": bounds, "gsd": gsd, "crs": crs, "areaHa": covered_area_ha(info)})
            project["layers"].append({
                "id": "ortho", "name": "Orthomosaic", "type": "imagery",
                "url": f"ortho/{{z}}/{{x}}/{{y}}.{ext}",
                "minZoom": zmin, "maxZoom": zmax, "bounds": bounds,
            })

        if found.get("dsm"):
            log("\nDSM -> colour-relief tiles")
            info = gdalinfo(found["dsm"])
            bounds, _, crs = raster_summary(info)
            coloured, lo, hi = dsm_colour_relief(found["dsm"], work)
            zmin, zmax, ext = tile(coloured, out / "dsm", args)
            project.setdefault("bounds", bounds)
            project["crs"] = project.get("crs") or crs
            project["layers"].append({
                "id": "dsm", "name": "Elevation (DSM)", "type": "imagery",
                "url": f"dsm/{{z}}/{{x}}/{{y}}.{ext}",
                "minZoom": zmin, "maxZoom": zmax, "bounds": bounds,
                "visible": False, "opacity": 0.8,
                "legend": {"min": lo, "max": hi, "unit": "m", "colors": DSM_COLOURS},
            })

        for key, name, extra in (("mesh", "3D model", {}), ("pointcloud", "Point cloud", {"pointSize": 2})):
            if not found.get(key):
                continue
            log(f"\n{name} -> copy 3D Tiles")
            src = Path(found[key]).parent
            shutil.copytree(src, out / key)
            layer = {"id": key, "name": name, "type": "3dtiles", "url": f"{key}/{Path(found[key]).name}"}
            layer.update(extra)
            if key == "pointcloud" and found.get("mesh"):
                layer["visible"] = False
            project["layers"].append(layer)

        if args.downloads:
            log("\nDownloads")
            dl = out / "downloads"
            dl.mkdir()
            for key, label in (("ortho", "Orthomosaic (GeoTIFF)"), ("dsm", "DSM (GeoTIFF)"),
                               ("las", "Point cloud (LAS)")):
                src = found.get(key)
                if not src or (key == "las" and args.no_pointcloud):
                    continue
                dest = dl / f"{key}{Path(src).suffix.lower()}"
                shutil.copy2(src, dest)
                project["downloads"].append({
                    "name": label, "url": f"downloads/{dest.name}", "size": human_size(dest.stat().st_size),
                })

        project = {k: v for k, v in project.items() if v not in (None, "", [])}
        (out / "project.json").write_text(json.dumps(project, indent=2) + "\n")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    log(f"\nStaged {human_size(path_size(out))} in {out}")

    if args.upload:
        if not shutil.which("rclone"):
            sys.exit("rclone not found. Install it from https://rclone.org/install/")
        dest = args.upload.rstrip("/") + "/" + token
        log(f"\nUploading to {dest}")
        run(["rclone", "sync", out, dest, "--transfers", "32", "--checkers", "32", "--progress"])

    link = args.site_url.rstrip("#") + "#" + token
    log("\nClient link:\n  " + link)
    if not args.upload:
        log("(Not uploaded. Re-run with --upload, or copy the folder to your data bucket.)")


if __name__ == "__main__":
    main()
