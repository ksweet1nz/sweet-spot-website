# Survey Viewer

Client-facing viewer for DJI Terra drone surveys: orthomosaic and DSM in 2D, mesh and point cloud in 3D, with measurement tools. Each client gets a private link:

```
https://sweetspotadvisory.com.au/survey/#<token>
```

The token is a random 22-character string (128 bits). It names the project's folder in the data bucket, so the link is the key. Anyone holding the link can view the survey, and nobody can find a survey without it.

## How it fits together

```
survey/index.html, viewer.js, viewer.css, config.js   ← served by the website (GitHub Pages)
        │  reads  <dataBaseUrl>/<token>/project.json
        ▼
Data bucket (Cloudflare R2, public via custom domain)  ← survey files, can be many GB
  <token>/project.json
  <token>/ortho/{z}/{x}/{y}.png     orthomosaic tiles
  <token>/dsm/{z}/{x}/{y}.png       DSM colour-relief tiles
  <token>/mesh/tileset.json + …     DJI Terra B3DM (3D Tiles), copied as-is
  <token>/pointcloud/tileset.json   DJI Terra PNTS (3D Tiles), copied as-is
  <token>/downloads/…               optional GeoTIFF / LAS downloads
```

Survey data lives outside the website repo because GitHub Pages caps sites at 1 GB. R2 is recommended because it charges nothing for downloads (egress), and 3D models generate a lot of downloads. Any static host with CORS works: S3, Backblaze B2, Bunny, or a folder on your own server.

The viewer uses [CesiumJS](https://cesium.com/platform/cesiumjs/) (open source, loaded from a CDN) with an Esri satellite basemap. No Cesium ion account is needed.

## One-time setup

1. **Create an R2 bucket** (Cloudflare dashboard → R2), e.g. `surveys`.
2. **Connect a custom domain** to the bucket (Bucket → Settings → Public access → Custom domains), e.g. `surveys.sweetspotadvisory.com.au`. Leave the `r2.dev` URL disabled. A public bucket does not list its contents, so a project can only be reached by its token.
3. **Add a CORS policy** (Bucket → Settings → CORS policy):
   ```json
   [
     {
       "AllowedOrigins": ["https://sweetspotadvisory.com.au", "http://localhost:8765"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
4. **Set `dataBaseUrl`** in `survey/config.js` to your bucket domain if it differs from `https://surveys.sweetspotadvisory.com.au/`.
5. **On the processing PC, install:**
   - GDAL, e.g. via [OSGeo4W](https://trac.osgeo.org/osgeo4w/) on Windows, or `conda install -c conda-forge gdal`
   - Python 3.8+
   - [rclone](https://rclone.org/install/), configured with an R2 remote: run `rclone config` and choose *Amazon S3 → Cloudflare R2*, using an R2 API token with read/write access to the bucket. The examples below assume the remote is named `r2`.

## Exporting from DJI Terra

| Output | Terra setting | Used for |
|---|---|---|
| Orthomosaic | 2D reconstruction (GeoTIFF, `map/result.tif`) | 2D layer |
| DSM | 2D reconstruction (`map/dsm.tif`) | Elevation layer + legend |
| Mesh | 3D reconstruction → output format **B3DM** | 3D model |
| Point cloud | Point cloud output format **PNTS** (add **LAS** for downloads) | 3D point cloud |

The publish script finds these automatically inside the Terra project folder. Use `--ortho/--dsm/--mesh/--pointcloud` to point at files directly if your folder layout differs.

## Publishing a survey

```bash
python tools/publish_survey.py "D:/DJI Terra/Lot12_Stockpile" \
  --title "Stockpile survey – Lot 12" \
  --client "Acme Quarries" \
  --location "Mittagong NSW" \
  --date 2026-09-30 \
  --downloads \
  --upload r2:surveys
```

This tiles the orthomosaic and DSM, copies the 3D Tiles, writes `project.json`, uploads everything, and prints the client link:

```
Client link:
  https://sweetspotadvisory.com.au/survey/#Xq3v9Lk2…
```

Useful options:

| Option | Effect |
|---|---|
| `--token <token>` | Re-publish over an existing project (same link) |
| `--expires 2027-03-31` | The viewer shows "link expired" after this date |
| `--downloads` | Offer the original files for download: orthomosaic and DSM GeoTIFFs, every LAS block, and a ZIP of the contour, TIN and spot-height files (DXF, SHP, LandXML) |
| `--webp` | Smaller tiles (GDAL 3.6+) |
| `--ortho-zoom 16-22` | Override the tile zoom range |
| `--no-dsm`, `--no-pointcloud` | Leave those layers out |

**Revoking access:** delete the token's folder from the bucket (`rclone purge r2:surveys/<token>`). `--expires` is a courtesy message only; the files stay reachable until you delete them.

## Admin page

`tools/survey_admin.bat` starts a local admin page and opens it in your browser. It lists every survey in the bucket and lets you:

- **Add** a survey from a DJI Terra folder (runs `publish_survey.py` and uploads).
- **Edit details:** title, client, location, date, notes and link expiry.
- **Replace data:** re-publish from a Terra folder and keep the same link.
- **New link:** move the survey to a fresh token, which cuts off everyone holding the old link.
- **Delete** the survey and all its files.
- **Copy link** to send to the client and their consultants.

The page is served only to this PC and needs the key in the address it opens with, so it has no login. It uses the `r2` rclone remote and the GDAL that ships with QGIS or OSGeo4W. Pass `--remote` or `--site-url` to the `.bat` if yours differ.

## Access log

The `worker/` folder holds a Cloudflare Worker on `surveys.sweetspotadvisory.com.au/_api/*` that records each time a client link is opened and each file downloaded (downloads are served through it). Events go into a D1 database, `survey-log`. The admin page shows a summary on each survey card and an **Activity** list with time, file, approximate location, device and a short visitor code. No raw IP addresses are stored. Links opened with `?nolog`, which the admin page's **Open** button adds, are not logged, and neither is anything on `localhost`.

Setup (once, from `worker/`, logged in to the Sweet Spot Cloudflare account with `npx wrangler login`):

```bash
npx wrangler d1 execute survey-log --remote --file schema.sql
npx wrangler secret put ADMIN_KEY        # any long random string
npx wrangler deploy
```

Then save the same key for the admin page in `%APPDATA%\SweetSpot\survey-admin.json`:

```json
{ "logUrl": "https://surveys.sweetspotadvisory.com.au/_api/", "logKey": "<the ADMIN_KEY>" }
```

If a `CLOUDFLARE_API_TOKEN` environment variable for another account is set on the PC, clear it for these commands; `wrangler.toml` pins the Sweet Spot account ID, so a deploy to the wrong account fails instead of landing there.

## Previewing locally

```bash
python tools/publish_survey.py <terra folder> --title "Test" --out survey/data --token test-project
npx http-server -p 8765          # from the repo root
# open http://localhost:8765/survey/#test-project
```

On `localhost`, `config.js` reads projects from `survey/data/`. That folder is git-ignored.

## project.json reference

The publish script writes this file. You can edit it by hand, e.g. to rename layers or fix the description.

```jsonc
{
  "version": 1,
  "title": "Stockpile survey – Lot 12",
  "client": "Acme Quarries",
  "date": "2026-09-30",
  "location": "Mittagong NSW",
  "description": "Optional notes shown in the panel.",
  "expires": "2027-03-31",            // optional
  "bounds": [w, s, e, n],             // WGS84 degrees, used for "Zoom to survey"
  "gsd": 2.1, "areaHa": 4.82, "crs": "GDA2020 / MGA zone 56",
  "defaultView": "2d",                // or "3d"
  "heightOffset": "auto",             // or metres; see below
  "layers": [
    { "id": "ortho", "name": "Orthomosaic", "type": "imagery",
      "url": "ortho/{z}/{x}/{y}.png", "minZoom": 15, "maxZoom": 22, "bounds": [w, s, e, n] },
    { "id": "mesh", "name": "3D model", "type": "3dtiles", "url": "mesh/tileset.json" }
  ],
  "downloads": [ { "name": "Orthomosaic (GeoTIFF)", "url": "downloads/ortho.tif", "size": "1.2 GB" } ]
}
```

Layer URLs are relative to `project.json`. Imagery layers accept `visible`, `opacity` and `legend`. 3D Tiles layers accept `visible`, `pointSize` and `maximumScreenSpaceError`.

**Heights:** the basemap has no terrain, so a model at its real elevation would float above it. The viewer lowers the 3D layers so the ground at the model's centre meets the basemap. Measured elevations add that shift back, so they still read in the model's own height system. If the auto value is off (e.g. the centre of the model is a rooftop), set `heightOffset` to a fixed number of metres.

## Measurement tools

- **Point:** latitude and longitude, plus elevation when you click the 3D model.
- **Distance:** horizontal in 2D; 3D, horizontal and elevation change on the model.
- **Area:** horizontal area and perimeter.
- **Height:** vertical difference between two points on the 3D model (3D view only).

You can export measurements as GeoJSON. Accuracy is limited by the survey itself.
