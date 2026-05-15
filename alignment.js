/* ════════════════════════════════════════════════════════════════
   Alignment view — Leaflet-based SVG ↔ map alignment.

   Ported from tools/geojson-alignment (Flask app). Key differences:
   - Browser-only: SVG comes from validator's loaded file, not a server.
   - Save = build modified SVG string in memory and trigger a download.

   Public API (exposed as window.AlignmentView):
     setSvg(text, filename)  – install a new SVG (parses anchors, primes view)
     clear()                 – drop the loaded SVG
     enter() / exit()        – show/hide the view
     hasSvg()                – bool
════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Parsing (anchors + scale lines) ─────────────────────────────
  // Mirrors parse_svg in geojson-alignment/app.py.

  function extractGpsBlock(svgText) {
    const open = /<g\s+id="GPS"[^>]*>/.exec(svgText);
    if (!open) return null;
    let depth = 1;
    let pos = open.index + open[0].length;
    while (depth > 0 && pos < svgText.length) {
      const restOpen = /<g[\s>]/.exec(svgText.slice(pos));
      const restClose = /<\/g>/.exec(svgText.slice(pos));
      if (!restClose) break;
      if (restOpen && restOpen.index < restClose.index) {
        depth += 1;
        pos += restOpen.index + 1;
      } else {
        depth -= 1;
        if (depth === 0) {
          return svgText.slice(open.index + open[0].length, pos + restClose.index);
        }
        pos += restClose.index + restClose[0].length;
      }
    }
    return null;
  }

  function parseSvgInfo(svgText) {
    const anchors = [];
    const scaleLines = [];

    const gpsBlock = extractGpsBlock(svgText);
    if (!gpsBlock) return { anchors, scaleLines };

    const anchorRe = /<g\s+id="([^"]+)">\s*<(?:circle|ellipse)\s+id="([^"]+)"\s+cx="([^"]+)"\s+cy="([^"]+)"/g;
    let m;
    while ((m = anchorRe.exec(gpsBlock)) !== null) {
      const parts = m[1].split(',').map(s => s.trim());
      if (parts.length !== 2) continue;
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      anchors.push({
        label: m[2],
        lat, lon,
        cx: parseFloat(m[3]),
        cy: parseFloat(m[4]),
      });
    }

    // Scale lines: parse the SVG as XML so attribute order and trailing
    // whitespace in ids don't matter, then delegate to the shared
    // findScaleShapes() helper defined in validator.js. Keeps the validator
    // check and the alignment view in lockstep.
    try {
      const xmlDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const gpsGroup = xmlDoc.querySelector('g#GPS, g[id="GPS"], g[id="gps"], g[id="Gps"]');
      if (gpsGroup && typeof findScaleShapes === 'function') {
        scaleLines.push(...findScaleShapes(gpsGroup));
      }
    } catch (e) {
      // If XML parsing fails, just return what we have for anchors.
    }
    return { anchors, scaleLines };
  }

  // Mirrors update_svg_anchors in geojson-alignment/app.py.
  // Returns the modified SVG text. Anchor matching is by inner circle/ellipse id (label).
  function rewriteSvgAnchors(svgText, anchors) {
    let out = svgText;
    for (const a of anchors) {
      const escapedLabel = a.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '(<g\\s+id=")([^"]+)(">\\s*<(?:circle|ellipse)\\s+id="' + escapedLabel + '"[^>]*?\\s+cx=")([^"]+)("\\s+cy=")([^"]+)(")'
      );
      const newCoord = `${a.lat},${a.lon}`;
      const newCx = `${a.cx ?? 0}`;
      const newCy = `${a.cy ?? 0}`;
      if (re.test(out)) {
        out = out.replace(re, `$1${newCoord}$3${newCx}$5${newCy}$7`);
        continue;
      }
      // New anchor — insert into GPS group.
      const insertion =
        `  <g id="${a.lat},${a.lon}">\n` +
        `    <circle id="${a.label}" cx="${a.cx || 0}" cy="${a.cy || 0}" r="10" fill="#D9D9D9"/>\n` +
        `  </g>\n`;
      const open = /<g\s+id="GPS"[^>]*>/.exec(out);
      if (!open) continue;
      let depth = 1;
      let pos = open.index + open[0].length;
      while (depth > 0 && pos < out.length) {
        const restOpen = /<g[\s>]/.exec(out.slice(pos));
        const restClose = /<\/g>/.exec(out.slice(pos));
        if (!restClose) break;
        if (restOpen && restOpen.index < restClose.index) {
          depth += 1;
          pos += restOpen.index + 1;
        } else {
          depth -= 1;
          if (depth === 0) {
            const insertPos = pos + restClose.index;
            out = out.slice(0, insertPos) + insertion + out.slice(insertPos);
            break;
          }
          pos += restClose.index + restClose[0].length;
        }
      }
    }
    return out;
  }

  // ── Math helpers ────────────────────────────────────────────────
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(2) + ' m'; }

  // ── State (initialized lazily on first enter()) ─────────────────
  let map = null;
  let currentBaseLayer = null;
  const baseLayers = {};

  let svgOverlayEl = null;
  let anchors = [];
  let markers = [];
  let scaleLines = [];
  let svgWidth = 0, svgHeight = 0;
  let svgOpacity = 0.7;
  let svgMoveMode = false;
  let addingAnchor = false;
  let lastMeasuredMeters = null;

  let originalSvgText = '';
  let cleanedSvgText = '';   // what we render (GPS group stripped, scale lines re-styled)
  let currentFilename = '';

  let measuring = false;
  let measurePoints = [], measureMarkers = [], measureLines = [], measureLabels = [];
  let previewLine = null, previewLabel = null;

  let overlayDragging = false;
  let overlayDragStartLatLng = null;
  let overlayDragStartAnchors = null;

  let initialized = false;

  // ── DOM refs (resolved on init) ─────────────────────────────────
  let viewEl, sidebarEl, statusEl, filenameEl, anchorTbody, scaleTbody, scaleInfoEl,
      addAnchorBtn, freeAnchorsBtn, fixScaleBtn, anchorEditStatusEl, opacitySlider,
      emptyEl;

  // Debounced push of anchor edits back into AppState so editor/Download
  // always see the current state. `suppressAppStatePush` is true while we're
  // re-loading the view in response to an external AppState change.
  let pushTimer = null;
  let suppressAppStatePush = false;
  function pushAnchorsToAppState() {
    if (suppressAppStatePush) return;
    if (!originalSvgText || !anchors.length) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const updated = rewriteSvgAnchors(originalSvgText, anchors);
      if (window.AppState) window.AppState.setSvgText(updated, 'align');
    }, 150);
  }

  // ── Lazy init ───────────────────────────────────────────────────
  function init() {
    if (initialized) return;
    initialized = true;

    viewEl = document.getElementById('alignView');
    sidebarEl = viewEl.querySelector('.align-sidebar');
    statusEl = document.getElementById('align-status');
    filenameEl = document.getElementById('align-filename');
    anchorTbody = document.getElementById('anchor-tbody');
    scaleTbody = document.getElementById('scale-tbody');
    scaleInfoEl = document.getElementById('scale-info');
    addAnchorBtn = document.getElementById('btn-add-anchor');
    freeAnchorsBtn = document.getElementById('btn-free-anchors');
    fixScaleBtn = document.getElementById('btn-fix-scale');
    anchorEditStatusEl = document.getElementById('anchor-edit-status');
    opacitySlider = document.getElementById('opacity-slider');
    emptyEl = document.getElementById('align-empty');

    map = L.map('alignMap', { zoomSnap: 0.25 }).setView([51.534, -0.1217], 18);

    baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    });
    baseLayers['google-roadmap'] = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      maxZoom: 22, maxNativeZoom: 21, attribution: '&copy; Google',
    });
    baseLayers['google-satellite'] = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
      maxZoom: 22, maxNativeZoom: 21, attribution: '&copy; Google',
    });
    baseLayers['google-hybrid'] = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      maxZoom: 22, maxNativeZoom: 21, attribution: '&copy; Google',
    });
    currentBaseLayer = baseLayers.osm;
    currentBaseLayer.addTo(map);

    map.createPane('svgPane');
    map.getPane('svgPane').style.zIndex = 450;
    map.getPane('svgPane').style.pointerEvents = 'auto';

    document.querySelectorAll('#basemap-switcher input[name="basemap"]').forEach(r => {
      r.addEventListener('change', () => {
        map.removeLayer(currentBaseLayer);
        currentBaseLayer = baseLayers[r.value];
        currentBaseLayer.addTo(map);
      });
    });

    opacitySlider.addEventListener('input', () => {
      svgOpacity = parseFloat(opacitySlider.value);
      if (svgOverlayEl) svgOverlayEl.style.opacity = svgOpacity;
    });

    addAnchorBtn.addEventListener('click', addAnchorMode);
    freeAnchorsBtn.addEventListener('click', toggleFreeAnchors);
    fixScaleBtn.addEventListener('click', fixScale);

    map.on('click', onMapClick);
    map.on('mousemove', onMapMouseMove);
    map.on('contextmenu', e => { if (measuring) { L.DomEvent.preventDefault(e); clearMeasure(); } });
    map.on('moveend zoomend zoom move viewreset', updateOverlayTransform);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && measuring) toggleMeasure();
    });
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);

    setupMapSearch();

    // Measure tool button
    const MeasureControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const btn = L.DomUtil.create('div', 'measure-control leaflet-bar');
        btn.innerHTML = '&#x1F4CF;';
        btn.title = 'Measure distance';
        L.DomEvent.disableClickPropagation(btn);
        btn.addEventListener('click', toggleMeasure);
        return btn;
      },
    });
    map.addControl(new MeasureControl());
  }

  // ── Map search (lat,lon or place name via Nominatim) ────────────
  function parseLatLon(s) {
    // Accept: "lat, lon" or "lat lon" with optional whitespace.
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  async function geocode(query) {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
                encodeURIComponent(query);
    const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!resp.ok) throw new Error('Search failed');
    const data = await resp.json();
    if (!data.length) throw new Error('No results');
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }

  function setupMapSearch() {
    const wrap = document.getElementById('map-search');
    const input = document.getElementById('map-search-input');
    const btn = document.getElementById('map-search-btn');
    const locateBtn = document.getElementById('map-locate-btn');
    if (!wrap || !input || !btn) return;

    if (locateBtn) {
      locateBtn.addEventListener('click', () => {
        if (anchors.length < 2 || !svgWidth || !svgHeight) return;
        // Build bounds from the four SVG corners (not anchors) so the zoom
        // depends on the SVG size, not on how close the anchors happen to
        // sit on it. pad(0.5) expands the bbox 2× → SVG covers 1/2 linearly
        // ≈ 1/4 of the viewport area.
        const corners = [
          svgCartToLatLng(0, 0),
          svgCartToLatLng(svgWidth, 0),
          svgCartToLatLng(0, svgHeight),
          svgCartToLatLng(svgWidth, svgHeight),
        ].filter(Boolean);
        if (corners.length < 2) return;
        const svgBounds = L.latLngBounds(corners);
        const zoom = map.getBoundsZoom(svgBounds.pad(0.5));
        const center = svgCartToLatLng(svgWidth / 2, svgHeight / 2);
        if (center) map.setView(center, zoom);
      });
    }

    async function run() {
      const q = input.value.trim();
      if (!q) return;
      wrap.classList.remove('error');
      const direct = parseLatLon(q);
      if (direct) {
        map.setView([direct.lat, direct.lon], Math.max(map.getZoom(), 17));
        return;
      }
      wrap.classList.add('searching');
      try {
        const r = await geocode(q);
        map.setView([r.lat, r.lon], 17);
      } catch (_) {
        wrap.classList.add('error');
        setTimeout(() => wrap.classList.remove('error'), 1500);
      } finally {
        wrap.classList.remove('searching');
      }
    }

    btn.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.disableScrollPropagation(wrap);
  }

  // ── Status / loading ────────────────────────────────────────────
  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.style.color = isError ? '#e74c3c' : '#aaa';
  }

  function updateLocateBtnVisibility() {
    const btn = document.getElementById('map-locate-btn');
    if (btn) btn.hidden = anchors.length < 2;
  }

  function clearOverlay() {
    if (svgOverlayEl && svgOverlayEl.parentNode) {
      svgOverlayEl.parentNode.removeChild(svgOverlayEl);
    }
    svgOverlayEl = null;
    markers.forEach(m => map.removeLayer(m));
    markers = [];
  }

  function loadIntoView() {
    if (!originalSvgText) return;
    const { anchors: parsedAnchors, scaleLines: parsedScales } = parseSvgInfo(originalSvgText);
    anchors = parsedAnchors;
    scaleLines = parsedScales;
    lastMeasuredMeters = null;

    if (filenameEl) filenameEl.textContent = currentFilename || '';
    if (scaleInfoEl) scaleInfoEl.innerHTML = '';
    fixScaleBtn.style.display = scaleLines.length > 0 ? '' : 'none';

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(originalSvgText, 'image/svg+xml');
    const svgEl = svgDoc.querySelector('svg');
    if (!svgEl) {
      setStatus('Could not parse SVG', true);
      return;
    }
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/\s+/);
      svgWidth = parseFloat(parts[2]);
      svgHeight = parseFloat(parts[3]);
    } else {
      svgWidth = parseFloat(svgEl.getAttribute('width')) || 0;
      svgHeight = parseFloat(svgEl.getAttribute('height')) || 0;
    }

    const gpsGroup = svgEl.querySelector('#GPS');
    if (gpsGroup) {
      const scaleEls = gpsGroup.querySelectorAll('[id$="m"]');
      scaleEls.forEach(el => {
        el.setAttribute('stroke', '#e74c3c');
        el.setAttribute('stroke-width', '3');
        gpsGroup.parentNode.appendChild(el);
      });
      gpsGroup.remove();
    }
    cleanedSvgText = new XMLSerializer().serializeToString(svgEl);

    clearOverlay();

    svgOverlayEl = document.createElement('div');
    svgOverlayEl.innerHTML = cleanedSvgText;
    svgOverlayEl.style.position = 'absolute';
    svgOverlayEl.style.transformOrigin = '0 0';
    svgOverlayEl.style.opacity = svgOpacity;
    svgOverlayEl.style.pointerEvents = 'auto';
    svgOverlayEl.style.cursor = 'grab';
    setupOverlayDrag(svgOverlayEl);

    const innerSvg = svgOverlayEl.querySelector('svg');
    innerSvg.style.display = 'block';
    innerSvg.removeAttribute('width');
    innerSvg.removeAttribute('height');
    innerSvg.setAttribute('width', svgWidth);
    innerSvg.setAttribute('height', svgHeight);

    map.getPane('svgPane').appendChild(svgOverlayEl);

    createMarkers();
    renderAnchorTable();
    renderScaleTable();

    const fitToAnchors = () => {
      if (anchors.length === 1) {
        map.setView([anchors[0].lat, anchors[0].lon], map.getZoom());
        return;
      }
      if (anchors.length < 2) return;
      const bounds = L.latLngBounds(anchors.map(a => [a.lat, a.lon]));
      map.fitBounds(bounds.pad(0.5));
    };
    fitToAnchors();
    // Re-fit on the next animation frame in case the map container's
    // measured size was stale (layout race after the view became visible).
    requestAnimationFrame(() => {
      map.invalidateSize();
      fitToAnchors();
      updateOverlayTransform();
    });

    updateOverlayTransform();
    updateLocateBtnVisibility();
    setStatus(`Loaded ${currentFilename}`);
    if (emptyEl) emptyEl.style.display = 'none';
  }

  function unloadView() {
    clearOverlay();
    anchors = [];
    updateLocateBtnVisibility();
    scaleLines = [];
    cleanedSvgText = '';
    svgWidth = svgHeight = 0;
    if (filenameEl) filenameEl.textContent = '';
    if (anchorTbody) anchorTbody.innerHTML = '';
    if (scaleTbody) scaleTbody.innerHTML = '';
    if (scaleInfoEl) scaleInfoEl.innerHTML = '';
    setStatus('');
    if (emptyEl) emptyEl.style.display = '';
  }

  // ── Markers ─────────────────────────────────────────────────────
  function createMarkers() {
    const colors = ['#e74c3c', '#2980b9', '#27ae60', '#f39c12'];
    anchors.forEach((anchor, i) => {
      const marker = L.marker([anchor.lat, anchor.lon], {
        draggable: true,
        icon: L.divIcon({
          className: '',
          html: `<div style="width:16px;height:16px;border-radius:50%;background:${colors[i % colors.length]};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5);transform:translate(-8px,-8px);"></div>`,
          iconSize: [0, 0],
        }),
      }).addTo(map);

      marker.bindTooltip(anchor.label, {
        permanent: true, direction: 'top', offset: [0, -12],
        className: 'anchor-label',
      });

      let dragTransformState = null;

      marker.on('dragstart', () => {
        if (svgMoveMode && anchors.length >= 2) {
          dragTransformState = computeTransformState();
        }
      });

      marker.on('drag', e => {
        const ll = e.target.getLatLng();
        if (svgMoveMode && dragTransformState) {
          anchors[i].lat = ll.lat;
          anchors[i].lon = ll.lng;
          const layerPt = map.latLngToLayerPoint(ll);
          const cart = pixelToCartWithState(layerPt.x, layerPt.y, dragTransformState);
          anchors[i].cx = Math.round(cart.x);
          anchors[i].cy = Math.round(cart.y);
          renderAnchorTable();
        } else {
          anchors[i].lat = ll.lat;
          anchors[i].lon = ll.lng;
          updateOverlayTransform();
          renderAnchorTable();
        }
      });

      marker.on('dragend', () => {
        dragTransformState = null;
        if (svgMoveMode) updateOverlayTransform();
      });

      markers.push(marker);
    });
  }

  // ── Anchor table ────────────────────────────────────────────────
  function renderAnchorTable() {
    anchorTbody.innerHTML = '';
    anchors.forEach((a, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>A-${i + 1}</td>
        <td><input type="number" step="any" data-i="${i}" data-f="lat" value="${a.lat.toFixed(7)}"></td>
        <td><input type="number" step="any" data-i="${i}" data-f="lon" value="${a.lon.toFixed(7)}"></td>
        <td><input type="number" step="1"   data-i="${i}" data-f="cx"  value="${Math.round(a.cx)}"></td>
        <td><input type="number" step="1"   data-i="${i}" data-f="cy"  value="${Math.round(a.cy)}"></td>
      `;
      anchorTbody.appendChild(tr);
    });
    anchorTbody.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const idx = +inp.dataset.i, field = inp.dataset.f;
        const v = parseFloat(inp.value);
        if (Number.isNaN(v)) return;
        anchors[idx][field] = v;
        if (field === 'lat' || field === 'lon') {
          markers[idx].setLatLng([anchors[idx].lat, anchors[idx].lon]);
        }
        updateOverlayTransform();
        pushAnchorsToAppState();
      });
    });
    pushAnchorsToAppState();
  }

  function renderScaleTable() {
    scaleTbody.innerHTML = '';
    scaleLines.forEach((sl, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${sl.id || sl.meters + 'm'}</td><td>${sl.meters}m</td><td id="scale-cur-${i}">-</td><td id="scale-diff-${i}">-</td>`;
      scaleTbody.appendChild(tr);
    });
  }

  // ── Add anchor ──────────────────────────────────────────────────
  function addAnchorMode() {
    if (!cleanedSvgText) return;
    if (anchors.length >= 2 && !confirm('You already have 2+ anchors. Add another?')) return;
    addingAnchor = true;
    anchorEditStatusEl.textContent = 'Click on the map to place the new anchor...';
    map.getContainer().style.cursor = 'crosshair';
  }

  function toggleFreeAnchors() {
    svgMoveMode = !svgMoveMode;
    if (svgMoveMode) {
      freeAnchorsBtn.textContent = 'Lock Anchors';
      freeAnchorsBtn.style.background = '#e74c3c';
      freeAnchorsBtn.style.borderColor = '#e74c3c';
      anchorEditStatusEl.textContent = 'Anchors free — drag to reposition on SVG';
    } else {
      freeAnchorsBtn.textContent = 'Free Anchors';
      freeAnchorsBtn.style.background = '';
      freeAnchorsBtn.style.borderColor = '';
      anchorEditStatusEl.textContent = '';
    }
  }

  // ── Affine transform ────────────────────────────────────────────
  // Forward affine: SVG cartesian (cx, cy) → geographic LatLng, using the
  // current two-anchor transform.
  function svgCartToLatLng(cx, cy) {
    if (anchors.length < 2) return null;
    const a0 = anchors[0], a1 = anchors[1];
    const p0 = map.latLngToLayerPoint([a0.lat, a0.lon]);
    const p1 = map.latLngToLayerPoint([a1.lat, a1.lon]);
    const dsx = a1.cx - a0.cx, dsy = a1.cy - a0.cy;
    const dtx = p1.x - p0.x, dty = p1.y - p0.y;
    const srcLen = Math.sqrt(dsx * dsx + dsy * dsy);
    const tgtLen = Math.sqrt(dtx * dtx + dty * dty);
    if (srcLen === 0 || tgtLen === 0) return null;
    const scale = tgtLen / srcLen;
    const rotation = Math.atan2(dty, dtx) - Math.atan2(dsy, dsx);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const dx = cx - a0.cx, dy = cy - a0.cy;
    const px = p0.x + scale * (cosR * dx - sinR * dy);
    const py = p0.y + scale * (sinR * dx + cosR * dy);
    return map.layerPointToLatLng([px, py]);
  }

  function pixelToCart(px, py) {
    if (anchors.length === 1) {
      // Single-anchor mode: invert the pin-to-anchor/25% display transform.
      if (!svgWidth || !svgHeight) return { x: px, y: py };
      const size = map.getSize();
      const pxScale = 0.5 * Math.min(size.x / svgWidth, size.y / svgHeight);
      const a = anchors[0];
      const p = map.latLngToLayerPoint([a.lat, a.lon]);
      const tx = p.x - pxScale * a.cx;
      const ty = p.y - pxScale * a.cy;
      return { x: (px - tx) / pxScale, y: (py - ty) / pxScale };
    }
    if (anchors.length < 2) {
      // SVG is in no-anchor mode: invert the centered/25% display transform.
      if (!svgWidth || !svgHeight) return { x: px, y: py };
      const t = noAnchorTransformParams();
      return { x: (px - t.tx) / t.pxScale, y: (py - t.ty) / t.pxScale };
    }
    const a0 = anchors[0], a1 = anchors[1];
    const dsx = a1.cx - a0.cx, dsy = a1.cy - a0.cy;
    const p0 = map.latLngToLayerPoint([a0.lat, a0.lon]);
    const p1 = map.latLngToLayerPoint([a1.lat, a1.lon]);
    const dtx = p1.x - p0.x, dty = p1.y - p0.y;
    const srcLen = Math.sqrt(dsx * dsx + dsy * dsy);
    const tgtLen = Math.sqrt(dtx * dtx + dty * dty);
    if (srcLen === 0 || tgtLen === 0) return { x: px, y: py };
    const scale = tgtLen / srcLen;
    const rotation = Math.atan2(dty, dtx) - Math.atan2(dsy, dsx);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const tx = p0.x - scale * (cosR * a0.cx - sinR * a0.cy);
    const ty = p0.y - scale * (sinR * a0.cx + cosR * a0.cy);
    const relX = px - tx, relY = py - ty;
    return {
      x: (cosR * relX + sinR * relY) / scale,
      y: (-sinR * relX + cosR * relY) / scale,
    };
  }

  function computeTransformState() {
    if (anchors.length < 2) return null;
    const a0 = anchors[0], a1 = anchors[1];
    const dsx = a1.cx - a0.cx, dsy = a1.cy - a0.cy;
    const p0 = map.latLngToLayerPoint([a0.lat, a0.lon]);
    const p1 = map.latLngToLayerPoint([a1.lat, a1.lon]);
    const dtx = p1.x - p0.x, dty = p1.y - p0.y;
    const srcLen = Math.sqrt(dsx * dsx + dsy * dsy);
    const tgtLen = Math.sqrt(dtx * dtx + dty * dty);
    if (srcLen === 0 || tgtLen === 0) return null;
    const scale = tgtLen / srcLen;
    const rotation = Math.atan2(dty, dtx) - Math.atan2(dsy, dsx);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const tx = p0.x - scale * (cosR * a0.cx - sinR * a0.cy);
    const ty = p0.y - scale * (sinR * a0.cx + cosR * a0.cy);
    return { scale, cosR, sinR, tx, ty };
  }

  function pixelToCartWithState(px, py, st) {
    const relX = px - st.tx, relY = py - st.ty;
    return {
      x: (st.cosR * relX + st.sinR * relY) / st.scale,
      y: (-st.sinR * relX + st.cosR * relY) / st.scale,
    };
  }

  function updateOverlayTransform() {
    if (!svgOverlayEl) return;
    if (anchors.length === 1) { updateOverlaySingleAnchor(); return; }
    if (anchors.length < 2) { updateOverlayNoAnchors(); return; }
    const a0 = anchors[0], a1 = anchors[1];
    const dsx = a1.cx - a0.cx, dsy = a1.cy - a0.cy;
    const p0 = map.latLngToLayerPoint([a0.lat, a0.lon]);
    const p1 = map.latLngToLayerPoint([a1.lat, a1.lon]);
    const dtx = p1.x - p0.x, dty = p1.y - p0.y;
    const srcLen = Math.sqrt(dsx * dsx + dsy * dsy);
    const tgtLen = Math.sqrt(dtx * dtx + dty * dty);
    if (srcLen === 0) return;
    const scale = tgtLen / srcLen;
    const rotation = Math.atan2(dty, dtx) - Math.atan2(dsy, dsx);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const tx = p0.x - scale * (cosR * a0.cx - sinR * a0.cy);
    const ty = p0.y - scale * (sinR * a0.cx + cosR * a0.cy);
    const a = scale * cosR, b = scale * sinR, c = -scale * sinR, d = scale * cosR;
    svgOverlayEl.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
    updateScaleInfo(scale, rotation);
  }

  // No anchors: SVG is pinned to the screen, not the map. Always centered,
  // sized to cover ~25% of the current viewport area. Reapplied on each
  // pan/zoom so it appears fixed while the map slides underneath.
  function noAnchorTransformParams() {
    const size = map.getSize();
    const pxScale = 0.5 * Math.min(size.x / svgWidth, size.y / svgHeight);
    const center = map.latLngToLayerPoint(map.getCenter());
    const tx = center.x - (svgWidth * pxScale) / 2;
    const ty = center.y - (svgHeight * pxScale) / 2;
    return { pxScale, tx, ty };
  }

  // One anchor: SVG is pinned to the map at that anchor's lat/lon, scaled
  // to ~25% of the viewport (same scale as the no-anchor case). The
  // anchor's cx/cy maps to its lat/lon layer point.
  function updateOverlaySingleAnchor() {
    if (!svgOverlayEl || !svgWidth || !svgHeight) return;
    const size = map.getSize();
    const pxScale = 0.5 * Math.min(size.x / svgWidth, size.y / svgHeight);
    const a = anchors[0];
    const p = map.latLngToLayerPoint([a.lat, a.lon]);
    const tx = p.x - pxScale * a.cx;
    const ty = p.y - pxScale * a.cy;
    svgOverlayEl.style.transform = `matrix(${pxScale}, 0, 0, ${pxScale}, ${tx}, ${ty})`;
  }

  function updateOverlayNoAnchors() {
    if (!svgOverlayEl || !svgWidth || !svgHeight) return;
    const t = noAnchorTransformParams();
    svgOverlayEl.style.transform = `matrix(${t.pxScale}, 0, 0, ${t.pxScale}, ${t.tx}, ${t.ty})`;
  }

  function updateScaleInfo(_pxScale, rotation) {
    if (scaleLines.length === 0) return;
    const a0 = anchors[0], a1 = anchors[1];
    const sx0 = a0.cx, sy0 = a0.cy;

    function cartToLatLng(cx, cy) {
      const relX = cx - sx0, relY = cy - sy0;
      const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
      const rotX = cosR * relX - sinR * relY;
      const rotY = sinR * relX + cosR * relY;
      const cdx = a1.cx - a0.cx, cdy = a1.cy - sy0;
      const cartDist = Math.sqrt(cdx * cdx + cdy * cdy);
      const geoDist = haversine(a0.lat, a0.lon, a1.lat, a1.lon);
      const metersPerCart = geoDist / cartDist;
      const mPerLat = 111320;
      const mPerLon = 111320 * Math.cos(a0.lat * Math.PI / 180);
      const dLat = (rotY * metersPerCart) / mPerLat;
      const dLon = (rotX * metersPerCart) / mPerLon;
      return [a0.lat - dLat, a0.lon + dLon];
    }

    let totalExpected = 0, totalMeasured = 0;
    scaleLines.forEach((sl, i) => {
      const p1 = cartToLatLng(sl.x1, sl.y1);
      const p2 = cartToLatLng(sl.x2, sl.y2);
      const currentMeters = haversine(p1[0], p1[1], p2[0], p2[1]);
      const rawDiff = currentMeters - sl.meters;
      let pct = ((rawDiff / sl.meters) * 100).toFixed(1);
      if (parseFloat(pct) === 0) pct = '0.0';
      const cls = Math.abs(rawDiff) < sl.meters * 0.01 ? 'match' : 'mismatch';
      const sign = pct === '0.0' ? '' : (rawDiff >= 0 ? '+' : '');
      const curEl = document.getElementById(`scale-cur-${i}`);
      const diffEl = document.getElementById(`scale-diff-${i}`);
      if (curEl) curEl.textContent = `${currentMeters.toFixed(2)}m`;
      if (diffEl) diffEl.innerHTML = `<span class="${cls}">${sign}${pct}%</span>`;
      totalExpected += sl.meters;
      totalMeasured += currentMeters;
    });

    lastMeasuredMeters = totalMeasured / scaleLines.length;
    const avgExpected = totalExpected / scaleLines.length;
    const avgRawDiff = lastMeasuredMeters - avgExpected;
    let avgPct = ((avgRawDiff / avgExpected) * 100).toFixed(1);
    if (parseFloat(avgPct) === 0) avgPct = '0.0';
    const avgCls = Math.abs(avgRawDiff) < avgExpected * 0.01 ? 'match' : 'mismatch';
    const avgSign = avgPct === '0.0' ? '' : (avgRawDiff >= 0 ? '+' : '');
    scaleInfoEl.innerHTML = scaleLines.length > 1
      ? `Avg: <b>${avgExpected.toFixed(1)}m</b> exp, <b>${lastMeasuredMeters.toFixed(2)}m</b> cur (<span class="${avgCls}">${avgSign}${avgPct}%</span>)`
      : '';
  }

  function fixScale() {
    if (scaleLines.length === 0 || anchors.length < 2 || !lastMeasuredMeters) {
      setStatus('Scale not available', true); return;
    }
    const avgExpected = scaleLines.reduce((s, l) => s + l.meters, 0) / scaleLines.length;
    const factor = avgExpected / lastMeasuredMeters;
    if (!isFinite(factor) || factor <= 0) return;
    const midLat = (anchors[0].lat + anchors[1].lat) / 2;
    const midLon = (anchors[0].lon + anchors[1].lon) / 2;
    for (let i = 0; i < anchors.length; i++) {
      anchors[i].lat = midLat + (anchors[i].lat - midLat) * factor;
      anchors[i].lon = midLon + (anchors[i].lon - midLon) * factor;
      markers[i].setLatLng([anchors[i].lat, anchors[i].lon]);
    }
    updateOverlayTransform();
    renderAnchorTable();
    setStatus(`Scale fixed (x${factor.toFixed(4)})`);
  }

  // ── Map click (add anchor + measure) ────────────────────────────
  function onMapClick(e) {
    if (addingAnchor) {
      const layerPt = map.latLngToLayerPoint(e.latlng);
      const cart = pixelToCart(layerPt.x, layerPt.y);
      const label = `Point ${String.fromCharCode(65 + anchors.length)}`;
      anchors.push({ label, lat: e.latlng.lat, lon: e.latlng.lng, cx: Math.round(cart.x), cy: Math.round(cart.y) });
      markers.forEach(m => map.removeLayer(m));
      markers = [];
      createMarkers();
      renderAnchorTable();
      updateOverlayTransform();
      addingAnchor = false;
      map.getContainer().style.cursor = '';
      anchorEditStatusEl.textContent = `Added "${label}"`;
      updateLocateBtnVisibility();
      return;
    }
    if (!measuring) return;
    const ll = e.latlng;
    clearPreview();
    measurePoints.push(ll);
    const dot = L.circleMarker(ll, {
      radius: 4, color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 1, weight: 2,
    }).addTo(map);
    measureMarkers.push(dot);
    if (measurePoints.length > 1) {
      const prev = measurePoints[measurePoints.length - 2];
      const curr = measurePoints[measurePoints.length - 1];
      const line = L.polyline([prev, curr], { color: '#e74c3c', weight: 2, dashArray: '6,4' }).addTo(map);
      measureLines.push(line);
      const dist = haversine(prev.lat, prev.lng, curr.lat, curr.lng);
      const midLat = (prev.lat + curr.lat) / 2;
      const midLng = (prev.lng + curr.lng) / 2;
      const label = L.marker([midLat, midLng], {
        icon: L.divIcon({ className: 'measure-label', html: formatDist(dist), iconSize: null }),
        interactive: false,
      }).addTo(map);
      measureLabels.push(label);
      if (measurePoints.length > 2) {
        let total = 0;
        for (let i = 1; i < measurePoints.length; i++) {
          total += haversine(measurePoints[i - 1].lat, measurePoints[i - 1].lng,
                             measurePoints[i].lat, measurePoints[i].lng);
        }
        setStatus(`Total: ${formatDist(total)}`);
      }
    }
  }

  function onMapMouseMove(e) {
    if (!measuring || measurePoints.length === 0) { clearPreview(); return; }
    const last = measurePoints[measurePoints.length - 1];
    const curr = e.latlng;
    if (!previewLine) {
      previewLine = L.polyline([last, curr], { color: '#e74c3c', weight: 2, dashArray: '4,4', opacity: 0.4 }).addTo(map);
    } else {
      previewLine.setLatLngs([last, curr]);
    }
    const dist = haversine(last.lat, last.lng, curr.lat, curr.lng);
    const midLat = (last.lat + curr.lat) / 2, midLng = (last.lng + curr.lng) / 2;
    if (!previewLabel) {
      previewLabel = L.marker([midLat, midLng], {
        icon: L.divIcon({ className: 'measure-label', html: formatDist(dist), iconSize: null }),
        interactive: false, opacity: 0.6,
      }).addTo(map);
    } else {
      previewLabel.setLatLng([midLat, midLng]);
      previewLabel.setIcon(L.divIcon({ className: 'measure-label', html: formatDist(dist), iconSize: null }));
    }
  }

  function toggleMeasure() {
    measuring = !measuring;
    const btn = document.querySelector('#alignView .measure-control');
    if (btn) btn.classList.toggle('active', measuring);
    map.getContainer().style.cursor = measuring ? 'crosshair' : '';
    clearMeasure();
  }

  function clearMeasure() {
    measureMarkers.forEach(m => map.removeLayer(m));
    measureLines.forEach(l => map.removeLayer(l));
    measureLabels.forEach(l => map.removeLayer(l));
    clearPreview();
    measurePoints = []; measureMarkers = []; measureLines = []; measureLabels = [];
  }

  function clearPreview() {
    if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
    if (previewLabel) { map.removeLayer(previewLabel); previewLabel = null; }
  }

  // ── SVG overlay drag (translate both anchors) ───────────────────
  function setupOverlayDrag(el) {
    el.addEventListener('mousedown', e => {
      if (measuring || addingAnchor) return;
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      overlayDragging = true;
      overlayDragStartLatLng = map.mouseEventToLatLng(e);
      overlayDragStartAnchors = anchors.map(a => ({ lat: a.lat, lon: a.lon }));
      map.dragging.disable();
      el.style.cursor = 'grabbing';
      document.body.style.cursor = 'grabbing';
    });
  }

  function onDocMouseMove(e) {
    if (!overlayDragging) return;
    const currentLatLng = map.mouseEventToLatLng(e);
    const dLat = currentLatLng.lat - overlayDragStartLatLng.lat;
    const dLon = currentLatLng.lng - overlayDragStartLatLng.lng;
    for (let i = 0; i < anchors.length; i++) {
      anchors[i].lat = overlayDragStartAnchors[i].lat + dLat;
      anchors[i].lon = overlayDragStartAnchors[i].lon + dLon;
      markers[i].setLatLng([anchors[i].lat, anchors[i].lon]);
    }
    updateOverlayTransform();
  }

  function onDocMouseUp() {
    if (!overlayDragging) return;
    overlayDragging = false;
    map.dragging.enable();
    if (svgOverlayEl) svgOverlayEl.style.cursor = 'grab';
    document.body.style.cursor = '';
    renderAnchorTable();
  }

  // ── AppState sync: pick up external SVG changes (editor / revert) ─
  if (window.AppState) {
    window.AppState.subscribe(({ source }) => {
      if (source === 'align') return; // our own push, ignore
      const text = window.AppState.svgText || '';
      suppressAppStatePush = true;
      try {
        originalSvgText = text;
        currentFilename = window.AppState.fileName || currentFilename;
        cleanedSvgText = '';
        const view = document.getElementById('alignmentView');
        if (initialized && view && !view.hidden) {
          map.invalidateSize();
          loadIntoView();
        }
      } finally {
        suppressAppStatePush = false;
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────
  window.AlignmentView = {
    setSvg(text, filename) {
      originalSvgText = text || '';
      currentFilename = filename || 'aligned.svg';
      cleanedSvgText = '';
      // If the alignment view is currently visible, re-hydrate immediately;
      // otherwise defer until enter().
      const view = document.getElementById('alignmentView');
      if (initialized && view && !view.hidden) {
        suppressAppStatePush = true;
        try { map.invalidateSize(); loadIntoView(); }
        finally { suppressAppStatePush = false; }
      }
    },
    clear() {
      originalSvgText = '';
      currentFilename = '';
      if (initialized) unloadView();
    },
    enter() {
      init();
      // Wait for the browser to apply the layout change (view became visible)
      // before measuring/drawing — otherwise fitBounds runs on a 0-sized map.
      requestAnimationFrame(() => {
        map.invalidateSize();
        if (originalSvgText && !cleanedSvgText) {
          suppressAppStatePush = true;
          try { loadIntoView(); }
          finally { suppressAppStatePush = false; }
        }
      });
    },
    exit() { /* tab visibility is handled by the tab controller */ },
    hasSvg() { return !!originalSvgText; },
  };
})();
