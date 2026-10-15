/* =============================================================
   SURVEY VIEWER
   Loads <dataBaseUrl>/<token>/project.json, where the token comes
   from the link: /survey/#<token>. Renders orthomosaic / DSM tiles
   (2D + 3D) and DJI Terra 3D Tiles (mesh / point cloud) in Cesium,
   with point, distance, area and height measurement tools.
   ============================================================= */

(function () {
  "use strict";

  var cfg = window.SURVEY_CONFIG || {};
  var C = window.Cesium;

  var TOKEN_RE = /^[A-Za-z0-9_-]{6,128}$/;
  var AMBER = C.Color.fromCssColorString("#F59C29");
  var NAVY = C.Color.fromCssColorString("#1A2B45");

  var state = {
    project: null,
    projectUrl: null,
    viewer: null,
    mode: "2d",
    layers: [],          // { def, kind: "imagery"|"3dtiles", handle, visible, el }
    heightOffset: 0,     // metres applied to 3D tiles so they sit on the basemap
    tool: null,
    draft: null,
    measures: [],
    nextId: 1
  };

  // ---------- DOM helpers ----------

  function $(sel) { return document.querySelector(sel); }
  function bind(name) { return document.querySelector('[data-bind="' + name + '"]'); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showOverlay(title, text, html) {
    var o = bind("overlay");
    bind("overlay-title").textContent = title;
    var t = bind("overlay-text");
    if (html) t.innerHTML = html; else t.textContent = text || "";
    o.classList.remove("is-hidden");
  }

  function hideOverlay() { bind("overlay").classList.add("is-hidden"); }

  function contactHtml(msg) {
    var safe = document.createElement("div");
    safe.textContent = msg;
    if (!cfg.contactEmail) return safe.innerHTML;
    return safe.innerHTML + ' Contact <a href="mailto:' + encodeURI(cfg.contactEmail) + '">' +
      cfg.contactEmail.replace(/</g, "&lt;") + "</a> for a new link.";
  }

  // ---------- Formatting ----------

  function fmtLen(m) {
    if (Math.abs(m) >= 1000) return (m / 1000).toFixed(3) + " km";
    return m.toFixed(2) + " m";
  }

  function fmtArea(m2) {
    if (m2 >= 10000) return (m2 / 10000).toFixed(3) + " ha";
    return m2.toFixed(1) + " m²";
  }

  function fmtDate(s) {
    var d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  }

  // ---------- Project loading ----------

  function readToken() {
    var h = decodeURIComponent(location.hash.replace(/^#\/?/, "").replace(/^p=/, ""));
    if (h) return h;
    return new URLSearchParams(location.search).get("p") || "";
  }

  function resolve(url) { return new URL(url, state.projectUrl).href; }

  function loadProject() {
    var token = readToken();
    if (!token) {
      showOverlay("No survey selected", null,
        contactHtml("Open the personal link you were sent to view your survey."));
      return;
    }
    if (!TOKEN_RE.test(token)) {
      showOverlay("Survey not found", null, contactHtml("This link doesn't look right."));
      return;
    }

    var base = new URL(cfg.dataBaseUrl || "data/", location.href).href.replace(/\/?$/, "/");
    state.token = token;
    state.projectUrl = base + token + "/project.json";

    fetch(state.projectUrl, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (p) {
        if (p.expires && new Date(p.expires) < new Date()) {
          showOverlay("This link has expired", null, contactHtml("Access to this survey has ended."));
          return;
        }
        state.project = p;
        start();
        logView();
      })
      .catch(function (err) {
        console.error(err);
        showOverlay("Survey not found", null,
          contactHtml("We couldn't find a survey for this link."));
      });
  }

  function logView() {
    if (!cfg.logUrl) return;
    // text/plain keeps this a simple request, so no CORS preflight.
    fetch(cfg.logUrl + "view", {
      method: "POST", mode: "no-cors", keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token: state.token })
    }).catch(function () {});
  }

  // ---------- Viewer ----------

  function start() {
    var p = state.project;
    document.title = (p.title || "Survey") + " — Survey Viewer";
    renderInfo(p);

    var bm = cfg.basemap || {};
    var baseLayer = bm.url
      ? new C.ImageryLayer(new C.UrlTemplateImageryProvider({
          url: bm.url,
          maximumLevel: bm.maximumLevel || 19,
          credit: new C.Credit(bm.credit || "")
        }))
      : false;

    var layerDefs = p.layers || [];
    var hasImagery = layerDefs.some(function (l) { return l.type === "imagery"; });
    state.mode = p.defaultView || (hasImagery ? "2d" : "3d");

    var viewer = new C.Viewer("map", {
      baseLayer: baseLayer,
      terrainProvider: new C.EllipsoidTerrainProvider(),
      mapProjection: new C.WebMercatorProjection(),
      sceneMode: state.mode === "2d" ? C.SceneMode.SCENE2D : C.SceneMode.SCENE3D,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity
    });
    state.viewer = viewer;

    viewer.scene.globe.baseColor = NAVY;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);

    var tilesetPromises = [];
    layerDefs.forEach(function (def) {
      if (def.type === "imagery") addImageryLayer(def);
      else if (def.type === "3dtiles") tilesetPromises.push(add3DTilesLayer(def));
    });

    renderLayers();
    renderDownloads(p);
    setupModeButtons();
    setupTools();
    setupPanel();
    setupNav();
    loadElevation();
    updateLayerVisibility();

    flyHome(0);
    hideOverlay();

    Promise.all(tilesetPromises).then(function () {
      if (state.mode === "3d") applyHeightOffset().then(function () { flyHome(1.2); });
    });
  }

  function projectRectangle() {
    var p = state.project;
    var b = p.bounds;
    if (!b) {
      var img = (p.layers || []).filter(function (l) { return l.bounds; })[0];
      if (img) b = img.bounds;
    }
    return b ? C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]) : null;
  }

  function visibleTileset() {
    for (var i = 0; i < state.layers.length; i++) {
      var l = state.layers[i];
      if (l.kind === "3dtiles" && l.visible && l.handle) return l.handle;
    }
    return null;
  }

  function flyHome(duration) {
    var viewer = state.viewer;
    var ts = state.mode === "3d" ? visibleTileset() : null;
    if (ts) {
      var r = ts.boundingSphere.radius;
      viewer.flyTo(ts, {
        duration: duration,
        offset: new C.HeadingPitchRange(0, C.Math.toRadians(-40), Math.max(r * 2.4, 50))
      });
      return;
    }
    var rect = projectRectangle();
    if (rect) {
      // Pad the rectangle a little so the survey edge isn't flush with the screen.
      var padX = (rect.east - rect.west) * 0.15, padY = (rect.north - rect.south) * 0.15;
      var dest = new C.Rectangle(rect.west - padX, rect.south - padY, rect.east + padX, rect.north + padY);
      viewer.camera.flyTo({ destination: dest, duration: duration });
    } else if (state.project.centre) {
      var c = state.project.centre;
      viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(c[0], c[1], 800), duration: duration });
    }
  }

  // ---------- Layers ----------

  function addImageryLayer(def) {
    var opts = {
      url: resolve(def.url),
      minimumLevel: def.minZoom || 0,
      maximumLevel: def.maxZoom || 22
    };
    if (def.bounds) opts.rectangle = C.Rectangle.fromDegrees(def.bounds[0], def.bounds[1], def.bounds[2], def.bounds[3]);
    var provider = new C.UrlTemplateImageryProvider(opts);
    provider.errorEvent.addEventListener(function (e) { e.retry = false; });

    var layer = state.viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = def.opacity != null ? def.opacity : 1;
    state.layers.push({ def: def, kind: "imagery", handle: layer, visible: def.visible !== false });
  }

  function add3DTilesLayer(def) {
    var entry = { def: def, kind: "3dtiles", handle: null, visible: def.visible !== false };
    state.layers.push(entry);

    return C.Cesium3DTileset.fromUrl(resolve(def.url), {
      maximumScreenSpaceError: def.maximumScreenSpaceError || 8,
      skipLevelOfDetail: true
    }).then(function (ts) {
      if (def.pointSize) ts.style = new C.Cesium3DTileStyle({ pointSize: def.pointSize });
      state.viewer.scene.primitives.add(ts);
      entry.handle = ts;
      updateLayerVisibility();
      renderLayers();
    }).catch(function (err) {
      console.error("Failed to load " + def.name, err);
      entry.failed = true;
      renderLayers();
    });
  }

  // DJI Terra models carry real-world heights, but the basemap sits on the
  // bare ellipsoid. Shift the models down so the survey ground meets the
  // basemap; measured elevations add the offset back so they stay true.
  var offsetPromise = null;
  function applyHeightOffset() {
    if (offsetPromise) return offsetPromise;
    var tilesets = state.layers.filter(function (l) { return l.kind === "3dtiles" && l.handle; })
      .map(function (l) { return l.handle; });
    if (!tilesets.length) return Promise.resolve();

    var setting = state.project.heightOffset;
    var compute;
    if (typeof setting === "number") {
      compute = Promise.resolve(setting);
    } else {
      var centre = C.Cartographic.fromCartesian(tilesets[0].boundingSphere.center);
      compute = state.viewer.scene.sampleHeightMostDetailed([centre])
        .then(function (res) {
          var h = res[0].height;
          return (h == null || isNaN(h)) ? -centre.height : -h;
        })
        .catch(function () { return -centre.height; });
    }

    offsetPromise = compute.then(function (offset) {
      state.heightOffset = offset;
      tilesets.forEach(function (ts) {
        var carto = C.Cartographic.fromCartesian(ts.boundingSphere.center);
        var surface = C.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
        var moved = C.Cartesian3.fromRadians(carto.longitude, carto.latitude, offset);
        ts.modelMatrix = C.Matrix4.fromTranslation(C.Cartesian3.subtract(moved, surface, new C.Cartesian3()));
      });
      state.viewer.scene.requestRender();
    });
    return offsetPromise;
  }

  function updateLayerVisibility() {
    var is3d = state.mode === "3d";
    state.layers.forEach(function (l) {
      if (!l.handle) return;
      l.handle.show = l.visible && (l.kind === "imagery" || is3d);
    });
    if (state.viewer) state.viewer.scene.requestRender();
  }

  // ---------- Panel rendering ----------

  function renderInfo(p) {
    bind("title").textContent = p.title || "Survey";
    bind("client").textContent = p.client || "";
    bind("description").textContent = p.description || "";

    var meta = bind("meta");
    meta.innerHTML = "";
    [
      ["Captured", p.date && fmtDate(p.date)],
      ["Location", p.location],
      ["Resolution", p.gsd && p.gsd + " cm/px"],
      ["Area", p.areaHa && p.areaHa + " ha"],
      ["Coordinate system", p.crs]
    ].forEach(function (row) {
      if (!row[1]) return;
      meta.appendChild(el("dt", null, row[0]));
      meta.appendChild(el("dd", null, row[1]));
    });
  }

  function renderLayers() {
    var list = bind("layers");
    list.innerHTML = "";
    var is3d = state.mode === "3d";

    state.layers.forEach(function (l) {
      var li = el("li", "sv-layer");
      var unavailable = l.failed || (l.kind === "3dtiles" && !is3d);
      if (unavailable) li.classList.add("is-unavailable");

      var label = el("label", "sv-layer__row");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = l.visible;
      cb.disabled = unavailable;
      cb.addEventListener("change", function () {
        l.visible = cb.checked;
        updateLayerVisibility();
      });
      label.appendChild(cb);
      label.appendChild(el("span", null, l.def.name || l.def.id));
      var kind = l.failed ? "unavailable" : l.kind === "3dtiles" ? (is3d ? "3D" : "3D view only") : "2D + 3D";
      label.appendChild(el("span", "sv-layer__kind", kind));
      li.appendChild(label);

      if (l.kind === "imagery") {
        var slider = document.createElement("input");
        slider.type = "range";
        slider.min = 0; slider.max = 100;
        slider.value = Math.round(l.handle.alpha * 100);
        slider.className = "sv-layer__opacity";
        slider.setAttribute("aria-label", (l.def.name || "Layer") + " opacity");
        slider.addEventListener("input", function () {
          l.handle.alpha = slider.value / 100;
          state.viewer.scene.requestRender();
        });
        li.appendChild(slider);
      }

      var lg = l.def.legend;
      if (lg && lg.colors && lg.colors.length > 1) {
        var legend = el("div", "sv-legend");
        var ramp = el("div", "sv-legend__ramp");
        ramp.style.background = "linear-gradient(to right, " + lg.colors.join(", ") + ")";
        var labels = el("div", "sv-legend__labels");
        var unit = lg.unit ? " " + lg.unit : "";
        labels.appendChild(el("span", null, lg.min + unit));
        labels.appendChild(el("span", null, lg.max + unit));
        legend.appendChild(ramp);
        legend.appendChild(labels);
        li.appendChild(legend);
      }

      list.appendChild(li);
    });
  }

  function renderDownloads(p) {
    var items = p.downloads || [];
    if (!items.length) return;
    bind("downloads-section").hidden = false;
    var list = bind("downloads");
    items.forEach(function (d) {
      var li = el("li");
      var a = el("a");
      // Through the access log when it's on, so downloads are recorded.
      a.href = cfg.logUrl && /^downloads\/[^/]+$/.test(d.url)
        ? cfg.logUrl + "dl/" + state.token + "/" + d.url
        : resolve(d.url);
      a.setAttribute("download", "");
      a.appendChild(el("strong", null, d.name));
      if (d.size) a.appendChild(el("span", null, d.size));
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  // ---------- Mode switching ----------

  function setupModeButtons() {
    var btns = document.querySelectorAll(".sv-mode__btn");
    function sync() {
      btns.forEach(function (b) { b.classList.toggle("is-active", b.dataset.mode === state.mode); });
    }
    sync();

    btns.forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.mode === state.mode) return;
        cancelDraft();
        state.mode = b.dataset.mode;
        sync();
        renderNav();
        updateStatus(null);

        var scene = state.viewer.scene;
        var done = scene.morphComplete.addEventListener(function () {
          done();
          updateLayerVisibility();
          renderLayers();
          syncToolAvailability();
          if (state.mode === "3d") applyHeightOffset().then(function () { flyHome(1.2); });
          // Cesium resets the 2D camera to the whole globe right after this
          // event, so wait a frame before zooming back to the survey.
          else requestAnimationFrame(function () { flyHome(0.8); });
        });
        if (state.mode === "3d") scene.morphTo3D(0.6); else scene.morphTo2D(0.6);
      });
    });
  }

  // ---------- Navigation help ----------

  var NAV_HELP = {
    mouse: {
      "2d": [["Left-click + drag", "Move the map"], ["Scroll wheel", "Zoom in and out"],
             ["Right-click + drag", "Zoom smoothly"]],
      "3d": [["Left-click + drag", "Move across the site"], ["Scroll wheel", "Zoom in and out"],
             ["Ctrl + left-drag", "Tilt and orbit"], ["Middle-click + drag", "Tilt and orbit"],
             ["Right-click + drag", "Zoom smoothly"]]
    },
    touch: {
      "2d": [["One-finger drag", "Move the map"], ["Pinch", "Zoom in and out"]],
      "3d": [["One-finger drag", "Move across the site"], ["Pinch", "Zoom in and out"],
             ["Two-finger drag", "Tilt"], ["Two-finger twist", "Rotate"]]
    }
  };

  function setupNav() {
    var box = bind("nav"), toggle = document.querySelector('[data-action="nav-toggle"]');
    var collapsed = window.matchMedia("(max-width: 760px)").matches;
    try { collapsed = (localStorage.getItem("sv-nav") || (collapsed ? "closed" : "open")) === "closed"; } catch (e) {}

    function apply() {
      box.classList.toggle("is-collapsed", collapsed);
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
    toggle.addEventListener("click", function () {
      collapsed = !collapsed;
      try { localStorage.setItem("sv-nav", collapsed ? "closed" : "open"); } catch (e) {}
      apply();
    });
    apply();
    renderNav();
  }

  function renderNav() {
    var input = window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
    var list = bind("nav-list");
    list.innerHTML = "";
    NAV_HELP[input][state.mode].forEach(function (row) {
      list.appendChild(el("dt", null, row[0]));
      list.appendChild(el("dd", null, row[1]));
    });
  }

  // ---------- Hover readout (2D) ----------

  var elevation = null;   // { def, data } once the grid has loaded

  function loadElevation() {
    var def = state.project.elevation;
    if (!def) return;
    fetch(resolve(def.url))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { elevation = { def: def, data: new Int16Array(buf) }; })
      .catch(function (err) { console.error("Failed to load elevation grid", err); });
  }

  function elevationAt(lon, lat) {
    if (!elevation) return null;
    var d = elevation.def, b = d.bounds;
    var x = Math.floor((lon - b[0]) / (b[2] - b[0]) * d.width);
    var y = Math.floor((b[3] - lat) / (b[3] - b[1]) * d.height);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    var v = elevation.data[y * d.width + x];
    return v === d.nodata ? null : d.offset + v * d.scale;
  }

  function updateStatus(pos) {
    var bar = bind("status"), scene = state.viewer.scene;
    var cart = pos && scene.mode === C.SceneMode.SCENE2D
      ? state.viewer.camera.pickEllipsoid(pos, scene.globe.ellipsoid) : null;
    if (!cart) { bar.hidden = true; return; }

    var c = C.Cartographic.fromCartesian(cart);
    var lon = C.Math.toDegrees(c.longitude), lat = C.Math.toDegrees(c.latitude);
    var elev = elevationAt(lon, lat);
    bar.innerHTML = "";
    bar.appendChild(el("span", null, "Lat " + lat.toFixed(6) + "°"));
    bar.appendChild(el("span", null, "Lon " + lon.toFixed(6) + "°"));
    if (elevation) bar.appendChild(el("span", null, "Elevation " + (elev == null ? "–" : elev.toFixed(2) + " m")));
    bar.hidden = false;
  }

  // ---------- Measurement ----------

  var TOOL_HINTS = {
    point: "Click a location to read its coordinates and elevation.",
    distance: "Click to add points. Double-click to finish.",
    area: "Click to outline an area. Double-click to finish.",
    height: "Click a base point, then a top point."
  };

  function setupTools() {
    var buttons = document.querySelectorAll(".sv-tool");
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        setTool(state.tool === b.dataset.tool ? null : b.dataset.tool);
      });
    });

    var handler = new C.ScreenSpaceEventHandler(state.viewer.scene.canvas);
    handler.setInputAction(function (e) { onClick(e.position); }, C.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(function () { finishDraft(); }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    handler.setInputAction(function () { finishDraft(); }, C.ScreenSpaceEventType.RIGHT_CLICK);
    handler.setInputAction(function (e) {
      onMove(e.endPosition);
      updateStatus(e.endPosition);
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    state.viewer.scene.canvas.addEventListener("mouseleave", function () { updateStatus(null); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { cancelDraft(); setTool(null); }
      if (e.key === "Enter") finishDraft();
    });

    document.querySelector('[data-action="clear"]').addEventListener("click", clearMeasures);
    document.querySelector('[data-action="export"]').addEventListener("click", exportGeoJSON);
    syncToolAvailability();
  }

  function syncToolAvailability() {
    // Height needs a 3D model to pick against.
    var heightBtn = document.querySelector('[data-tool="height"]');
    var ok = state.mode === "3d";
    heightBtn.disabled = !ok;
    heightBtn.title = ok ? "" : "Switch to 3D to measure heights";
    if (!ok && state.tool === "height") setTool(null);
  }

  function setTool(tool) {
    cancelDraft();
    state.tool = tool;
    document.querySelectorAll(".sv-tool").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.tool === tool);
    });
    $("#map").classList.toggle("is-measuring", !!tool);
    bind("hint").textContent = tool ? TOOL_HINTS[tool] : "Pick a tool, then click on the map.";
  }

  function pickPoint(pos) {
    var viewer = state.viewer, scene = viewer.scene;
    if (scene.mode === C.SceneMode.SCENE3D) {
      var picked = scene.pick(pos);
      var onModel = picked && (picked instanceof C.Cesium3DTileFeature || picked.primitive instanceof C.Cesium3DTileset);
      if (onModel && scene.pickPositionSupported) {
        var c = scene.pickPosition(pos);
        if (c) return { cart: c, onModel: true };
      }
      var ray = viewer.camera.getPickRay(pos);
      var g = ray && scene.globe.pick(ray, scene);
      if (g) return { cart: g, onModel: false };
    }
    var e = viewer.camera.pickEllipsoid(pos, scene.globe.ellipsoid);
    return e ? { cart: e, onModel: false } : null;
  }

  function toCarto(p) {
    var c = C.Cartographic.fromCartesian(p.cart);
    return {
      lon: C.Math.toDegrees(c.longitude),
      lat: C.Math.toDegrees(c.latitude),
      elev: p.onModel ? c.height - state.heightOffset : null,
      rad: c
    };
  }

  function onClick(pos) {
    if (!state.tool) return;
    var p = pickPoint(pos);
    if (!p) return;

    if (!state.draft) state.draft = newDraft(state.tool);
    var d = state.draft;

    // A double-click also fires two clicks; ignore a repeat of the last point.
    var last = d.points[d.points.length - 1];
    if (last && C.Cartesian3.distance(last.cart, p.cart) < 0.01) return;

    d.points.push(p);
    d.entities.push(state.viewer.entities.add({
      position: p.cart,
      point: {
        pixelSize: 8,
        color: AMBER,
        outlineColor: NAVY,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    }));

    if (d.type === "point" || (d.type === "height" && d.points.length === 2)) finishDraft();
    state.viewer.scene.requestRender();
  }

  function onMove(pos) {
    var d = state.draft;
    if (!d || !d.points.length) return;
    var p = pickPoint(pos);
    if (p) { d.cursor = p.cart; state.viewer.scene.requestRender(); }
  }

  function newDraft(type) {
    var d = { id: state.nextId++, type: type, points: [], entities: [], cursor: null };
    var viewer = state.viewer;

    function positions(closed) {
      var pts = d.points.map(function (p) { return p.cart; });
      if (d.cursor && !d.done) pts.push(d.cursor);
      if (closed && pts.length > 2) pts.push(pts[0]);
      return pts;
    }

    if (type === "distance" || type === "height" || type === "area") {
      d.entities.push(viewer.entities.add({
        polyline: {
          positions: new C.CallbackProperty(function () { return positions(type === "area"); }, false),
          width: 3,
          material: AMBER,
          depthFailMaterial: AMBER.withAlpha(0.5),
          arcType: C.ArcType.NONE
        }
      }));
    }
    if (type === "area") {
      d.entities.push(viewer.entities.add({
        polygon: {
          hierarchy: new C.CallbackProperty(function () {
            return new C.PolygonHierarchy(positions(false));
          }, false),
          perPositionHeight: true,
          material: AMBER.withAlpha(0.25)
        }
      }));
    }
    return d;
  }

  function cancelDraft() {
    var d = state.draft;
    if (!d) return;
    d.entities.forEach(function (e) { state.viewer.entities.remove(e); });
    state.draft = null;
    state.viewer.scene.requestRender();
  }

  function finishDraft() {
    var d = state.draft;
    if (!d) return;
    var need = { point: 1, distance: 2, height: 2, area: 3 }[d.type];
    if (d.points.length < need) return;

    d.done = true;
    d.cursor = null;
    d.result = compute(d);
    state.draft = null;

    var lastPos = d.type === "area" ? centroid(d.points) : d.points[d.points.length - 1].cart;
    d.entities.push(state.viewer.entities.add({
      position: lastPos,
      label: {
        text: d.result.label,
        font: "500 13px 'DM Sans', Arial, sans-serif",
        fillColor: C.Color.WHITE,
        showBackground: true,
        backgroundColor: NAVY.withAlpha(0.9),
        backgroundPadding: new C.Cartesian2(8, 5),
        pixelOffset: new C.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    }));

    state.measures.push(d);
    renderMeasures();
    state.viewer.scene.requestRender();
  }

  function centroid(points) {
    var sum = new C.Cartesian3();
    points.forEach(function (p) { C.Cartesian3.add(sum, p.cart, sum); });
    return C.Cartesian3.divideByScalar(sum, points.length, sum);
  }

  function horizontal(a, b) {
    var g = new C.EllipsoidGeodesic(a.rad, b.rad);
    return g.surfaceDistance;
  }

  function compute(d) {
    var pts = d.points.map(toCarto);
    var has3d = pts.every(function (p) { return p.elev != null; });
    var i, r = { coords: pts };

    if (d.type === "point") {
      var p = pts[0];
      r.label = p.elev != null ? p.elev.toFixed(2) + " m" : p.lat.toFixed(6) + ", " + p.lon.toFixed(6);
      r.value = p.lat.toFixed(7) + ", " + p.lon.toFixed(7);
      r.sub = p.elev != null ? "Elevation " + p.elev.toFixed(2) + " m" : "Switch to 3D for elevation";
    }

    if (d.type === "distance") {
      var h = 0, slope = 0;
      for (i = 1; i < pts.length; i++) {
        h += horizontal(pts[i - 1], pts[i]);
        slope += C.Cartesian3.distance(d.points[i - 1].cart, d.points[i].cart);
      }
      r.label = fmtLen(has3d ? slope : h);
      if (has3d) {
        r.value = fmtLen(slope) + " (3D)";
        r.sub = "Horizontal " + fmtLen(h) + " · Δ elev " + fmtLen(pts[pts.length - 1].elev - pts[0].elev);
      } else {
        r.value = fmtLen(h);
        r.sub = "Horizontal · " + pts.length + " points";
      }
    }

    if (d.type === "height") {
      var dz = has3d ? pts[1].elev - pts[0].elev : 0;
      r.label = (dz >= 0 ? "+" : "") + fmtLen(dz);
      r.value = r.label + " vertical";
      r.sub = has3d ? "Horizontal " + fmtLen(horizontal(pts[0], pts[1])) : "Click on the 3D model for heights";
    }

    if (d.type === "area") {
      // Project onto a local east-north plane at the first point, then shoelace.
      var frame = C.Transforms.eastNorthUpToFixedFrame(d.points[0].cart);
      var inv = C.Matrix4.inverseTransformation(frame, new C.Matrix4());
      var local = d.points.map(function (p) {
        return C.Matrix4.multiplyByPoint(inv, p.cart, new C.Cartesian3());
      });
      var a = 0, per = 0;
      for (i = 0; i < local.length; i++) {
        var j = (i + 1) % local.length;
        a += local[i].x * local[j].y - local[j].x * local[i].y;
        per += horizontal(pts[i], pts[j]);
      }
      a = Math.abs(a) / 2;
      r.label = fmtArea(a);
      r.value = fmtArea(a);
      r.sub = "Perimeter " + fmtLen(per);
    }
    return r;
  }

  function renderMeasures() {
    var list = bind("measures");
    list.innerHTML = "";
    state.measures.forEach(function (m) {
      var li = el("li", "sv-measure");
      li.appendChild(el("span", "sv-measure__swatch"));
      var body = el("div", "sv-measure__body");
      body.appendChild(el("div", "sv-measure__type", m.type + " " + m.id));
      body.appendChild(el("div", "sv-measure__value", m.result.value));
      body.appendChild(el("div", "sv-measure__sub", m.result.sub));
      li.appendChild(body);
      var rm = el("button", "sv-measure__remove", "×");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove measurement");
      rm.addEventListener("click", function () { removeMeasure(m); });
      li.appendChild(rm);
      list.appendChild(li);
    });
  }

  function removeMeasure(m) {
    m.entities.forEach(function (e) { state.viewer.entities.remove(e); });
    state.measures = state.measures.filter(function (x) { return x !== m; });
    renderMeasures();
    state.viewer.scene.requestRender();
  }

  function clearMeasures() {
    state.measures.slice().forEach(removeMeasure);
  }

  function exportGeoJSON() {
    var features = state.measures.map(function (m) {
      var coords = m.result.coords.map(function (c) {
        return c.elev != null ? [c.lon, c.lat, +c.elev.toFixed(3)] : [c.lon, c.lat];
      });
      var geom = m.type === "point" ? { type: "Point", coordinates: coords[0] }
        : m.type === "area" ? { type: "Polygon", coordinates: [coords.concat([coords[0]])] }
        : { type: "LineString", coordinates: coords };
      return {
        type: "Feature",
        geometry: geom,
        properties: { id: m.id, type: m.type, value: m.result.value, detail: m.result.sub }
      };
    });
    var blob = new Blob([JSON.stringify({ type: "FeatureCollection", features: features }, null, 2)],
      { type: "application/geo+json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.project.title || "survey").replace(/[^\w-]+/g, "_") + "_measurements.geojson";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- Panel controls ----------

  function setupPanel() {
    var panel = $(".sv-panel");
    var toggle = $(".sv-bar__panel-toggle");
    // On phones the panel overlays the map, so start with it tucked away.
    if (window.matchMedia("(max-width: 760px)").matches) {
      panel.classList.add("is-collapsed");
      toggle.setAttribute("aria-expanded", "false");
    }
    toggle.addEventListener("click", function () {
      var collapsed = panel.classList.toggle("is-collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
    });

    document.querySelector('[data-action="home"]').addEventListener("click", function () { flyHome(1); });

    var share = document.querySelector('[data-action="share"]');
    share.addEventListener("click", function () {
      var done = function () {
        share.textContent = "Link copied";
        setTimeout(function () { share.textContent = "Copy link"; }, 2000);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () {});
    });
  }

  if (!C) {
    showOverlay("Viewer failed to load", "Please check your connection and refresh the page.");
    return;
  }
  loadProject();
})();
