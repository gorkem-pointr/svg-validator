/* ════════════════════════════════════════════════════════════════
   Check Registry
   To add a new check: push an object into CheckRegistry.SVG_CHECKS
   or CheckRegistry.API_CHECKS following the schema below.

   Schema:
   {
     id:          string   – unique identifier
     name:        string   – display name
     description: string   – one-line description of what is tested
     severity:    'error' | 'warning'
     run:         async (cfg, ctx) => { pass: bool, message: string }
                  cfg for SVG checks  = parsed XMLDocument
                  cfg for API checks  = { geoApiUrl, apiKey, siteId, svgDoc }
                  ctx                 = shared object passed to every API check in sequence
   }
════════════════════════════════════════════════════════════════ */

/**
 * Extract modular definitions from the SVG's <g id="geolocation"> section.
 * Structure: <g id="geolocation"> → <g id="AisleName"> → <rect id="ModularName">
 * Mirrors _get_rect_and_path / _get_modulars in helpers/svg_helper.py.
 *
 * @param {Element} geolocation – <g id="geolocation"> element from the SVG document
 * @returns {{ aisleName: string, modularName: string, key: string }[]}
 */
/**
 * Haversine distance between two lat/lon points, in meters.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Axis-aligned bounding box (in viewport space) of an element's local bbox
 * transformed through its CTM. Used as a cheap pre-filter before raster IoU.
 */
function transformedAABB(bbox, ctm) {
  if (!ctm) return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
  const corners = [
    { x: bbox.x,              y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    { x: bbox.x,              y: bbox.y + bbox.height },
  ];
  const xs = corners.map(p => ctm.a * p.x + ctm.c * p.y + ctm.e);
  const ys = corners.map(p => ctm.b * p.x + ctm.d * p.y + ctm.f);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function aabbsOverlap(a, b) {
  return !(a.x + a.width  <= b.x || b.x + b.width  <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

/**
 * Serialize a shape as a standalone SVG with viewBox = its transformed AABB,
 * so an <img> loading the result renders the shape in viewport space. The
 * element's own transform is replaced with its CTM (already includes the
 * element's local transform) on a wrapper <g>.
 */
function shapeToSvgString(shape, aabb, ctm) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(svgNS, 'svg');
  root.setAttribute('xmlns', svgNS);
  root.setAttribute('viewBox', `${aabb.x} ${aabb.y} ${aabb.width} ${aabb.height}`);
  root.setAttribute('width',  String(Math.max(1, aabb.width)));
  root.setAttribute('height', String(Math.max(1, aabb.height)));

  const inner = shape.cloneNode(true);
  inner.removeAttribute('transform');  // CTM already includes the element's own transform
  inner.setAttribute('fill', 'black');
  inner.setAttribute('stroke', 'none');
  inner.removeAttribute('style');

  if (ctm) {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('transform', `matrix(${ctm.a} ${ctm.b} ${ctm.c} ${ctm.d} ${ctm.e} ${ctm.f})`);
    g.appendChild(inner);
    root.appendChild(g);
  } else {
    root.appendChild(inner);
  }

  return new XMLSerializer().serializeToString(root);
}

function loadSvgImage(svgString) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function countOpaquePixels(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
}

/**
 * Pixel-based IoU between two prerendered shapes. Each `shape` is
 * { img, aabb } where img is an <img> loaded from shapeToSvgString and
 * aabb is the viewport-space AABB. Renders both into a tight joint canvas
 * and counts pixels.
 */
function rasterIoU(shapeA, shapeB, resolution = 256) {
  const a = shapeA.aabb, b = shapeB.aabb;
  if (!aabbsOverlap(a, b)) return 0;

  const ux = Math.min(a.x, b.x);
  const uy = Math.min(a.y, b.y);
  const uw = Math.max(a.x + a.width,  b.x + b.width)  - ux;
  const uh = Math.max(a.y + a.height, b.y + b.height) - uy;

  const scale = resolution / Math.max(uw, uh);
  const cw = Math.max(1, Math.round(uw * scale));
  const ch = Math.max(1, Math.round(uh * scale));

  function drawShape(img, aabb) {
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      img,
      (aabb.x - ux) * scale,
      (aabb.y - uy) * scale,
      aabb.width  * scale,
      aabb.height * scale
    );
    return canvas;
  }

  const canvasA = drawShape(shapeA.img, a);
  const canvasB = drawShape(shapeB.img, b);

  const inter = document.createElement('canvas');
  inter.width = cw; inter.height = ch;
  const ictx = inter.getContext('2d');
  ictx.drawImage(canvasA, 0, 0);
  ictx.globalCompositeOperation = 'source-in';
  ictx.drawImage(canvasB, 0, 0);

  const cA = countOpaquePixels(canvasA);
  const cB = countOpaquePixels(canvasB);
  const cI = countOpaquePixels(inter);
  const union = cA + cB - cI;
  return union > 0 ? cI / union : 0;
}

function extractSvgModularNames(geolocation) {
  const modulars = [];
  if (!geolocation) return modulars;
  for (const aisleGroup of geolocation.children) {
    if (aisleGroup.tagName !== 'g') continue;
    const aisleName = aisleGroup.getAttribute('id') || '';
    for (const el of aisleGroup.children) {
      if (el.tagName !== 'rect' && el.tagName !== 'path') continue;
      const modularName = el.getAttribute('id') || '';
      modulars.push({ aisleName, modularName, key: `${aisleName}_${modularName}` });
    }
  }
  return modulars;
}


const section_ids = {
  gps: 'GPS',
  geolocation: 'geolocation',
  walls: 'walls',
  obstacles: 'obstacles',
};


function getSectionById(doc, id) {
  // Capitalize id in different ways to allow for some flexibility, but still require exact matches
  return doc.querySelector(`[id="${id}"], [id="${id.charAt(0).toUpperCase() + id.slice(1).toLowerCase()}"], [id="${id.toLowerCase()}"], [id="${id.toUpperCase()}"]`);
}


/**
 * Find scale-reference shapes in a GPS group. Accepts <line> and <path>
 * children whose id (after trimming) matches "<number>m" (e.g. "5m", "5.08m").
 * Returns an array of { id, meters, x1, y1, x2, y2 } in SVG-local coordinates.
 * Used by both the validator checks and the alignment view so the two stay
 * in sync.
 */
function findScaleShapes(gpsGroup) {
  const idRe = /^([\d.]+)m$/;
  const out = [];
  if (!gpsGroup) return out;

  for (const el of gpsGroup.querySelectorAll('line, path')) {
    const id = (el.getAttribute('id') || '').trim();
    const idMatch = idRe.exec(id);
    if (!idMatch) continue;
    const meters = parseFloat(idMatch[1]);
    if (isNaN(meters)) continue;

    const tag = el.tagName.toLowerCase();
    if (tag === 'line') {
      const x1 = parseFloat(el.getAttribute('x1'));
      const y1 = parseFloat(el.getAttribute('y1'));
      const x2 = parseFloat(el.getAttribute('x2'));
      const y2 = parseFloat(el.getAttribute('y2'));
      if ([x1, y1, x2, y2].some(isNaN)) continue;
      out.push({ id, meters, x1, y1, x2, y2 });
    } else {
      // <path> — accept simple "M x y H x2" or "M x1 y1 L x2 y2" forms.
      const d = el.getAttribute('d') || '';
      const mh = /^M([\d.]+)\s+([\d.]+)\s*[Hh]([\d.]+)/.exec(d);
      const ml = /^M([\d.]+)\s+([\d.]+)\s*[Ll]([\d.]+)\s+([\d.]+)/.exec(d);
      if (mh) {
        const x1 = parseFloat(mh[1]), y1 = parseFloat(mh[2]), x2 = parseFloat(mh[3]);
        out.push({ id, meters, x1, y1, x2, y2: y1 });
      } else if (ml) {
        out.push({
          id, meters,
          x1: parseFloat(ml[1]), y1: parseFloat(ml[2]),
          x2: parseFloat(ml[3]), y2: parseFloat(ml[4]),
        });
      }
    }
  }
  return out;
}


/**
 * Return the center (cx, cy) of an SVG shape in its own local coordinate space.
 * Supports <circle>, <ellipse>, <rect>, and <path>. Returns null if the shape
 * type is unsupported or coordinates can't be derived.
 */
function getShapeCenter(shape) {
  const tag = shape.tagName.toLowerCase();

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseFloat(shape.getAttribute('cx'));
    const cy = parseFloat(shape.getAttribute('cy'));
    if (isNaN(cx) || isNaN(cy)) return null;
    return { cx, cy };
  }

  if (tag === 'rect') {
    const x = parseFloat(shape.getAttribute('x') || '0');
    const y = parseFloat(shape.getAttribute('y') || '0');
    const w = parseFloat(shape.getAttribute('width'));
    const h = parseFloat(shape.getAttribute('height'));
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
    return { cx: x + w / 2, cy: y + h / 2 };
  }

  if (tag === 'path') {
    // getBBox() requires a laid-out SVG element, so mount a clone off-screen.
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    const cloned = shape.cloneNode(true);
    svg.appendChild(cloned);
    container.appendChild(svg);
    document.body.appendChild(container);
    try {
      const b = cloned.getBBox();
      if (b.width === 0 && b.height === 0) return null;
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    } catch (e) {
      return null;
    } finally {
      document.body.removeChild(container);
    }
  }

  return null;
}


async function findOverlaps(doc, elements, iouThreshold = 0.1) {
  // Clone SVG into a hidden DOM element so getBBox() and getCTM() work
  // for both <rect> and <path> elements, accounting for group transforms.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;';
  container.appendChild(doc.documentElement.cloneNode(true));
  document.body.appendChild(container);

  const clonedGeo = getSectionById(container, section_ids.geolocation);
  const clonedById = new Map(
    Array.from(clonedGeo.querySelectorAll('rect, path'))
    .filter(el => el.getAttribute('id'))
    .map(el => [el.getAttribute('id'), el])
  );

  const shapes = [];
  for (const el of elements) {
    const id = el.getAttribute('id');
    if (!id) continue;

    const cloned = clonedById.get(id);
    if (!cloned) continue;

    const aisleName = el.parentNode && el.parentNode.getAttribute
      ? (el.parentNode.getAttribute('id') || '')
      : '';
    const label = aisleName ? `${aisleName}_${id}` : id;

    try {
      const localBBox = cloned.getBBox();
      const ctm = cloned.getCTM();
      const aabb = transformedAABB(localBBox, ctm);
      if (aabb.width <= 0 || aabb.height <= 0) continue;
      const svgString = shapeToSvgString(cloned, aabb, ctm);
      shapes.push({ label, aabb, svgString });
    } catch (e) {
      // skip elements that cannot be measured (e.g. invisible or degenerate)
    }
  }
  document.body.removeChild(container);

  // Rasterize each shape once into its own <img>. Each pair is then a
  // small canvas-composite operation. Generic across rect / path / circle
  // / ellipse / polygon — the browser handles the geometry.
  await Promise.all(shapes.map(async (s) => {
    s.img = await loadSvgImage(s.svgString);
  }));

  const overlaps = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const iou = rasterIoU(shapes[i], shapes[j]);
      if (iou > iouThreshold) {
        overlaps.push(`"${shapes[i].label}" & "${shapes[j].label}" (IoU: ${(iou * 100).toFixed(1)}%)`);
      }
    }
  }
  return overlaps;
}


class CheckRegistry {
  static SVG_CHECKS = [
    {
      id: 'svg-root',
      name: 'Parseable XML document',
      description: 'File must parse as valid XML — mirrors ET.parse() / ET.fromstring() in svg_helper.py',
      severity: 'error',
      async run(doc) {
        const parseErr = doc.querySelector('parsererror');
        if (parseErr) {
          return { pass: false, message: 'File could not be parsed as valid XML.' };
        }
        const root = doc.documentElement;
        if (!root) {
          return { pass: false, message: 'Document has no root element.' };
        }
        return { pass: true, message: `XML parsed successfully. Root element: <${root.tagName}>` };
      }
    },
    {
      id: 'svg-gps-group',
      name: 'GPS anchor group present',
      description: `Must contain a <g id="${section_ids.gps}"> group`,
      severity: 'error',
      async run(doc) {
        try {
          const el = getSectionById(doc, section_ids.gps);
          if (!el) {
            return { pass: false, message: `No <g id="${section_ids.gps}"> group found. The parser uses this to geo-reference the map.` };
          }
          return { pass: true, message: `Found <g id="${el.id}">` };
        } catch (err) {
          return { pass: false, message: `Error checking GPS group: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-anchor-count',
      name: 'Minimum anchor count',
      description: 'GPS group must have at least 2 anchor sub-groups',
      severity: 'error',
      async run(doc) {
        try {
          const gps = getSectionById(doc, section_ids.gps);
          const anchors = Array.from(gps.children).filter(c => c.tagName === 'g');
          if (anchors.length < 2) {
            return { pass: false, message: `Found ${anchors.length} anchor group(s); need at least 2 for geo-referencing.` };
          }
          return { pass: true, message: `Found ${anchors.length} anchor group(s).` };
        } catch (err) {
          return { pass: false, message: `Error checking anchor count: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-anchor-ids',
      name: 'Anchor lat/lon coordinates',
      description: 'Each anchor <g> id must encode "lat,lon"',
      severity: 'error',
      async run(doc) {
        try {
          const gps = getSectionById(doc, section_ids.gps);
          const groups = Array.from(gps.children).filter(c => c.tagName === 'g');

          const anchors = [];
          for (const g of groups) {
            const id = g.getAttribute('id') || '';
            if (id === '') {
              return { pass: false, message: 'Anchor group has no id.' };
            }

            // Check gps coordinates
            const parts = id.split(',');
            const hasLatLonId = parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]));
            if (!hasLatLonId) {
              return { pass: false, message: `Anchor group "${id}" id does not encode lat/lon as "lat,lon".` };
            }
            const lat = parseFloat(parts[0]);
            const lon = parseFloat(parts[1]);
          }
          return { pass: true, message: `All ${groups.length} anchor(s) have coordinate data.` };
        } catch (err) {
          return { pass: false, message: `Error checking anchor coordinates: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-anchor-shapes',
      name: 'Anchor shape elements',
      description: 'Each anchor <g> must contain a <circle>, <ellipse>, <rect>, or <path> element to define the anchor point visually',
      severity: 'error',
      async run(doc) {
        try {
          const gps = getSectionById(doc, section_ids.gps);
          const groups = Array.from(gps.children).filter(c => c.tagName === 'g');

          for (const g of groups) {
            const shape = g.querySelector('circle, ellipse, rect, path');
            if (!shape) {
              return { pass: false, message: `Anchor group "${g.getAttribute('id') || ''}" is missing a <circle>, <ellipse>, <rect>, or <path> shape.` };
            }
          }
          return { pass: true, message: `All ${groups.length} anchor correct shapes items.` };
        } catch (err) {
          return { pass: false, message: `Error checking anchor shapes: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-anchor-coords',
      name: 'Anchor coordinate pairs',
      description: 'Each anchor <g> id must encode "lat,lon" and shape objects in them must have valid cx and cy attributes',
      severity: 'error',
      async run(doc, shared) {
        try {
          const gps = getSectionById(doc, section_ids.gps);
          const groups = Array.from(gps.children).filter(c => c.tagName === 'g');

          const anchors = [];
          for (const g of groups) {
            const id = g.getAttribute('id') || '';
            if (id === '') {
              return { pass: false, message: 'Anchor group has no id.' };
            }

            // Check gps coordinates
            const parts = id.split(',');
            const hasLatLonId = parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]));
            if (!hasLatLonId) {
              return { pass: false, message: `Anchor group "${id}" id does not encode lat/lon as "lat,lon".` };
            }
            const lat = parseFloat(parts[0]);
            const lon = parseFloat(parts[1]);

            // Check shape coordinates
            const shape = g.querySelector('circle, ellipse, rect, path');
            if (!shape) {
              return { pass: false, message: `Anchor group "${id}" is missing a <circle>, <ellipse>, <rect>, or <path> shape.` };
            }

            const center = getShapeCenter(shape);
            if (!center) {
              return { pass: false, message: `Anchor group "${id}" has invalid or unsupported shape coordinates.` };
            }
            anchors.push({ id, lat, lon, cx: center.cx, cy: center.cy });
          }
          shared.anchors = anchors;
          return { pass: true, message: `All ${groups.length} anchor(s) have coordinate data.` };
        } catch (err) {
          return { pass: false, message: `Error checking anchor coordinates: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-geolocation-group',
      name: 'Geolocation group present',
      description: `Must contain a <g id="${section_ids.geolocation}"> group for modular (rack/shelf) elements`,
      severity: 'error',
      async run(doc) {
        try {
          const el = getSectionById(doc, section_ids.geolocation);
          if (!el) {
            return { pass: false, message: `No <g id="${section_ids.geolocation}"> group found. This group holds modular/rack elements.` };
          }
          return { pass: true, message: `Found <g id="${section_ids.geolocation}">` };
        } catch (err) {
          return { pass: false, message: `Error checking geolocation group: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-modular-count',
      name: 'Modular elements present',
      description: 'Geolocation group must have at least one <rect> or <path> modular element',
      severity: 'error',
      async run(doc) {
        try {
          const geo = getSectionById(doc, section_ids.geolocation);
          const modulars = geo.querySelectorAll('rect, path');
          if (modulars.length === 0) {
            return { pass: false, message: `No <rect> or <path> elements inside <g id="${section_ids.geolocation}">.` };
          }
          const rects = geo.querySelectorAll('rect').length;
          const paths = geo.querySelectorAll('path').length;
          return { pass: true, message: `Found ${modulars.length} modular element(s): ${rects} rect(s), ${paths} path(s).` };
        } catch (err) {
          return { pass: false, message: `Error checking modular elements: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-modular-ids',
      name: 'Modular element IDs',
      description: 'All <rect> and <path> elements in geolocation group must have unique IDs. The IDs will be used as is without any processing like removing "_" like suffixes.',
      severity: 'warning',
      async run(doc, shared) {
        try {
          const geo = getSectionById(doc, section_ids.geolocation);
          const modulars = Array.from(geo.querySelectorAll('rect, path'));
          const missing  = modulars.filter(el => !el.getAttribute('id'));
          const ids      = modulars.map(el => el.getAttribute('id')).filter(Boolean);
          const dupes    = ids.filter((id, i) => ids.indexOf(id) !== i);
          const unique   = [...new Set(dupes)];

          if (shared) {
            // Save modular elements that have IDs for later API matching checks
            shared.svgModulars = modulars.filter(el => el.getAttribute('id'));
            shared.svgModularNames = extractSvgModularNames(geo);
          }

          if (missing.length > 0 || unique.length > 0) {
            const parts = [];
            if (missing.length > 0) parts.push(`${missing.length} element(s) without id`);
            if (unique.length > 0)  parts.push(`${unique.length} duplicate id(s): ${unique.slice(0, 3).join(', ')}`);
            return { pass: false, message: parts.join('; ') + '.' };
          }
          return { pass: true, message: `All ${modulars.length} modular elements have unique IDs.` };
        } catch (err) {
          return { pass: false, message: `Error checking modular IDs: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-modular-overlap-check',
      name: 'Modular element overlap',
      description: 'Check for overlapping modular elements in the geolocation group.',
      severity: 'error',
      async run(doc, shared) {
        try {
          if (!shared.svgModulars) {
            return { pass: false, message: 'No modular data extracted from SVG.' };
          }

          const elements = shared.svgModulars;
          if (elements.length < 2) {
            return { pass: true, message: 'Fewer than 2 modular elements; no overlap possible.' };
          }

          const overlaps = await findOverlaps(doc, elements, 0.2);
          if (overlaps.length > 0) {
            const shown = overlaps.slice(0, 10);
            const more = overlaps.length > 10 ? `\n…and ${overlaps.length - 10} more` : '';
            return { pass: false, message: `${overlaps.length} overlapping pair(s) detected (IoU > 20%):\n${shown.join('\n')}${more}` };
          }

          return { pass: true, message: `No overlapping modular elements detected (checked ${elements.length} elements, ${elements.length * (elements.length - 1) / 2} pairs).` };
          
        } catch (err) {
          return { pass: false, message: `Error checking modular overlap: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-scale-line-check',
      name: 'Scale line check',
      description: 'Check the scale line in the GPS group.',
      severity: 'warning',
      async run(doc, shared) {
        try {
          const gpsGroup = getSectionById(doc, section_ids.gps);
          const scaleShapes = findScaleShapes(gpsGroup);
          if (scaleShapes.length > 0) {
            const labels = scaleShapes.map(s => s.id).join(', ');
            return { pass: true, message: `Found ${scaleShapes.length} scale shape(s) in GPS group: ${labels}.` };
          }
          return { pass: false, message: `No scale line found in GPS group. Expected a <line> or <path> with id like "5m".` };
        } catch (err) {
          return { pass: false, message: `Error checking scale line: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-scale-check',
      name: 'Scale check',
      description: 'Check that the average modular size in the SVG is within a reasonable range in meters.',
      severity: 'warning',
      async run(doc, shared) {
        try {
          if (!shared.anchors || shared.anchors.length !== 2) {
            return { pass: false, message: 'Not enough anchor data to perform scale check. Ensure that the GPS anchor groups are correctly defined and have valid coordinates.' };
          }
          if (!shared.svgModulars || shared.svgModulars.length === 0) {
            return { pass: false, message: 'No modular data extracted from SVG. Ensure that the <g id="geolocation"> group and its child elements are correctly defined.' };
          }
          // Simple heuristic: calculate average distance between anchors in SVG coordinate space and compare to real-world distance from lat/lon
          const anchors = shared.anchors;
          const a1 = anchors[0];
          const a2 = anchors[1];
          const pixelDist_anchors = Math.sqrt((a1.cx - a2.cx) ** 2 + (a1.cy - a2.cy) ** 2);
          const geoDist_anchors = haversineDistance(a1.lat, a1.lon, a2.lat, a2.lon);
          const metersPerPixel_anchors = geoDist_anchors / pixelDist_anchors;
          let metersPerPixel = metersPerPixel_anchors;

          // Get scale shape(s) from GPS group if present to provide a visual
          // reference for the scale (optional, not required for the check).
          const gpsGroup = getSectionById(doc, section_ids.gps);
          const scaleShapes = findScaleShapes(gpsGroup);
          let lineDetail = '';
          if (scaleShapes.length > 0) {
            const s = scaleShapes[0];
            const pixelLength = Math.sqrt((s.x1 - s.x2) ** 2 + (s.y1 - s.y2) ** 2);
            const metersPerPixel_line = s.meters / pixelLength;
            lineDetail = `Scale from line object: ${metersPerPixel_line.toFixed(4)} m/px\nScale from anchors: ${metersPerPixel_anchors.toFixed(4)} m/px\n`;
          }
          
          // Compute average modular size in pixels using stored modulars in shared.svgModulars
          const sizes = [];
          for (const el of shared.svgModulars) {
            if (el.tagName === 'rect') {
              const w = parseFloat(el.getAttribute('width'));
              const h = parseFloat(el.getAttribute('height'));
              if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
                sizes.push({ w: w * metersPerPixel, h: h * metersPerPixel });
              }
            }
          }

          if (sizes.length === 0) {
            return { pass: false, message: 'Could not compute modular sizes — no <rect> elements with valid width/height found.' };
          }

          const avgW = sizes.reduce((s, v) => s + v.w, 0) / sizes.length;
          const avgH = sizes.reduce((s, v) => s + v.h, 0) / sizes.length;
          const minSide = Math.min(avgW, avgH);
          const maxSide = Math.max(avgW, avgH);

          // Give details in 3 lines
          const detail = `${lineDetail}Avg modular using anchor scale: ${avgW.toFixed(2)}m × ${avgH.toFixed(2)}m (${sizes.length} rects)`;
          return { pass: false, message: `${detail}` };
        } catch (err) {
          return { pass: false, message: `Error checking anchor coordinates: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-walls-group',
      name: 'Walls group',
      description: `Should contain a <g id="${section_ids.walls}"> group for perimeter/wall polygons`,
      severity: 'error',
      async run(doc) {
        try {
          const el = getSectionById(doc, section_ids.walls);
          if (!el) {
            return { pass: false, message: `<g id="${section_ids.walls}"> not found. Walls are required for accurate indoor maps.` };
          }
          return { pass: true, message: `Found <g id="${el.id}">` };
        } catch (err) {
          return { pass: false, message: `Error checking walls group: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-walls-data',
      name: 'Walls group data',
      description: `Should contain <line> or <path> elements inside <g id="${section_ids.walls}"> to define walls in the map.`,
      severity: 'error',
      async run(doc) {
        try {
          const el = getSectionById(doc, section_ids.walls);
          if (!el) {
            return { pass: false, message: `<g id="${section_ids.walls}"> not found. Walls are required for accurate indoor maps.` };
          }
          // Check for line and path elements as simple wall representations
          const lines = el.querySelectorAll('line');
          const paths = el.querySelectorAll('path');
          if (lines.length === 0 && paths.length === 0) {
            return { pass: false, message: `<g id="${el.id}"> is empty. It should contain <line> or <path> elements to define walls.` };
          }
          
          // For lines check if their x1,y1,x2,y2 attributes are valid numbers
          for (const line of lines) {
            const x1 = parseFloat(line.getAttribute('x1'));
            const y1 = parseFloat(line.getAttribute('y1'));
            const x2 = parseFloat(line.getAttribute('x2'));
            const y2 = parseFloat(line.getAttribute('y2'));
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
              return { pass: false, message: `<g id="${el.id}"> contains <line> elements with invalid coordinates.` };
            }
          }

          // For paths we can do a basic check to see if the 'd' attribute is present and non-empty, but a full validation of path data is complex and may be beyond the scope of this check
          for (const path of paths) {
            const d = path.getAttribute('d');
            if (!d || d.trim() === '') {
              return { pass: false, message: `<g id="${el.id}"> contains <path> elements with empty "d" attributes.` };
            }
          }

          return { pass: true, message: `<g id="${el.id}"> contains ${lines.length} line(s) and ${paths.length} path(s).` };
        } catch (err) {
          return { pass: false, message: `Error checking walls group: ${err.message}` };
        }
      }
    },
    {
      id: 'svg-obstacles-group',
      name: 'Obstacles group present',
      description: `Should contain a <g id="${section_ids.obstacles}"> group for obstacle polygons`,
      severity: 'warning',
      async run(doc) {
        try {
          const el = getSectionById(doc, section_ids.obstacles);
          if (!el) {
            return { pass: false, message: `<g id="${section_ids.obstacles}"> not found. Obstacles are optional for indoor maps.` };
          }
          return { pass: true, message: `Found <g id="${section_ids.obstacles}">` };
        } catch (err) {
          return { pass: false, message: `Error checking obstacles group: ${err.message}` };
        }
      }
    },
  ];

  static API_CHECKS = [
    {
      id: 'api-store-data',
      name: 'Fetch store data',
      description: 'GET /stores/{storeId} to fetch aisles and modulars for the store — this data is needed for floor detection and modular matching checks',
      severity: 'error',
      async run(cfg, ctx) {
        try {
          const api = new GeolocationAPI(cfg.geoApiUrl, cfg.apiKey);
          ctx.api = api;

          const store = await api.getStore(cfg.siteId);
          if (!store || store.length === 0) {
            return { pass: false, message: 'No store data found for the given site ID.' };
          }
          ctx.store = store;
          return { pass: true, message: `Fetched store data: ${store.length} aisle(s).` };
        } catch (err) {
          return { pass: false, message: `Error fetching store data: ${err.message}` };
        }
      }
    },
    {
        id: 'api-active-store-data',
        name: 'Check active store data',
        description: 'Verify that the fetched store data contains ACTIVE aisles and modulars.',
        severity: 'error',
        async run(cfg, ctx) {
          if (!ctx.store) {
            return { pass: false, message: 'Store data not available — pass the store data fetch check first.' };
          }

          // Check number of aisles and modulars (all are already active due to filtering in getStore, so we just check that there is at least one aisle and one modular)
          const aisleCount = ctx.store.length;
          const modularCount = ctx.store.reduce((n, a) => n + a.modulars.length, 0);
          if (aisleCount === 0) {
            return { pass: false, message: 'No ACTIVE aisles found in store data.' };
          }
          if (modularCount === 0) {
            return { pass: false, message: 'No ACTIVE modulars found in store data.' };
          }
          return { pass: true, message: `Store data contains ${aisleCount} ACTIVE aisle(s) and ${modularCount} ACTIVE modular(s).` };
        }
    },
    {
      id: 'api-modular-aisle-uniqueness',
      name: 'Aisle/Modular name uniqueness',
      description: 'Check that the combination of aisle name and modular name is unique across the store data.',
      severity: 'error',
      async run(cfg, ctx) {
        if (!ctx.store) {
          return { pass: false, message: 'Store data not available — pass the store data fetch check first.' };
        }

        const modularMap = new Map();
        for (const aisle of ctx.store) {
          for (const mod of aisle.modulars) {
            const key = `${aisle.name}_${mod.name}`;
            if (modularMap.has(key)) {
              return { pass: false, message: `Duplicate aisle/modular name combination found in API data: "${key}". This will cause issues with SVG modular matching. Please ensure that each combination of aisle name and modular name is unique in the store data.` };
            }
            modularMap.set(key, [{ aisle, modular: mod, floorId: aisle.floorId }]);
          }
        }
        ctx.modularMap = modularMap; // save for later API checks
        return { pass: true, message: `All aisle/modular name combinations are unique in the API data.` };
      }
    },
    {
      id: 'api-floor-detection',
      name: 'Detect floor from SVG modulars',
      description: 'Match SVG modular/aisle names against API modulars/aisles to identify exactly one floor — error if 0 or multiple floors matched',
      severity: 'error',
      async run(cfg, ctx) {
        if (!ctx.store) {
          return { pass: false, message: 'Store data not available — pass the store data fetch check first.' };
        }
        if (!ctx.svgModularNames || ctx.svgModularNames.length === 0) {
          return { pass: false, message: 'No SVG modular data available — pass SVG checks first.' };
        }
        if (!ctx.modularMap) {
          return { pass: false, message: 'Modular map not available — pass the API modular/aisle uniqueness check first.' };
        }

        const matchedFloorIds = new Set();
        const unmatched = [];
        // Loop through SVG modulars and try to find a match in the API modular map using the "aisleName_modularName" composite key
        for (const { key } of ctx.svgModularNames) {
          const entries = ctx.modularMap.get(key);
          if (entries && entries.length > 0) {
            for (const e of entries) matchedFloorIds.add(e.floorId);
          } else {
            unmatched.push(key);
          }
        }

        if (matchedFloorIds.size === 0) {
          return { pass: false, message: `None of the ${ctx.svgModularNames.length} SVG modular(s) matched an API modular. Examples: ${ctx.svgModularNames.slice(0, 5).map(m => m.key).join(', ')}.` };
        }
        if (matchedFloorIds.size > 1) {
          return { pass: false, message: `SVG modulars span ${matchedFloorIds.size} floors (${[...matchedFloorIds].join(', ')}). The SVG must map to exactly one floor.` };
        }

        ctx.detectedFloorId = [...matchedFloorIds][0];
        return { pass: true, message: `Detected floor: ${ctx.detectedFloorId}` };
      }
    },
    {
      id: 'api-modular-matching',
      name: 'Match SVG modulars to API modulars',
      description: 'For the detected floor, check that each SVG modular has a matching API modular with the same aisle/modular name combination, and that the API modular has coordinate data. This verifies that the modulars represented in the SVG can be linked to real modulars in the API data, which is essential for accurate geolocation.',
      severity: 'error',
      async run(cfg, ctx) {
        if (!ctx.store) {
          return { pass: false, message: 'Store data not available — pass the store data fetch check first.' };
        }
        if (!ctx.svgModularNames || ctx.svgModularNames.length === 0) {
          return { pass: false, message: 'No SVG modular data available — pass SVG checks first.' };
        }
        if (!ctx.modularMap) {
          return { pass: false, message: 'Modular map not available — pass the API modular/aisle uniqueness check first.' };
        }

        // Using the detected floor ID from the previous check, match SVG modulars to API modulars
        const floorAisles = ctx.store.filter(a => a.floorId === ctx.detectedFloorId);
        const floorModularMap = new Map();
        for (const aisle of floorAisles) {
          for (const mod of aisle.modulars) {
            floorModularMap.set(`${aisle.name}_${mod.name}`, mod);
          }
        }

        const svgCount = ctx.svgModularNames.length;
        const apiCount = floorModularMap.size;
        const matched = [];
        const unmatched = [];

        for (const { key } of ctx.svgModularNames) {
          if (floorModularMap.has(key)) {
            matched.push(key);
          } else {
            unmatched.push(key);
          }
        }

        const parts = [`${matched.length}/${svgCount} SVG modulars matched ${apiCount} API modulars`];
        if (unmatched.length > 0) {
          parts.push(`\n${unmatched.length} unmatched: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''}`);
        }

        const pass = unmatched.length === 0;
        return { pass, message: parts.join('. ') + '.' };
      }
    },
  ];
}


/* ════════════════════════════════════════════════════════════════
   Check Runner
════════════════════════════════════════════════════════════════ */
class CheckRunner {
  constructor() {
    this.svgShared = {}; // written by SVG checks, seeded into API ctx
  }

  async runSVGChecks(doc, onResult) {
    this.svgShared = {}; // reset on each run
    for (const check of CheckRegistry.SVG_CHECKS) {
      onResult(check, 'running', 'Running…');
      let result;
      try {
        result = await check.run(doc, this.svgShared);
      } catch (err) {
        result = { pass: false, message: `Unexpected error: ${err.message}` };
      }
      const state = result.pass ? 'pass' : (check.severity === 'warning' ? 'warn' : 'fail');
      onResult(check, state, result.message);
    }
  }

  async runAPIChecks(config, onResult) {
    const ctx = { ...this.svgShared }; // seed with data collected during SVG checks
    for (const check of CheckRegistry.API_CHECKS) {
      onResult(check, 'running', 'Running…');
      let result;
      try {
        result = await check.run(config, ctx);
      } catch (err) {
        result = { pass: false, message: `Unexpected error: ${err.message}` };
      }
      const state = result.pass ? 'pass' : (check.severity === 'warning' ? 'warn' : 'fail');
      onResult(check, state, result.message);
    }
  }
}


/* ════════════════════════════════════════════════════════════════
   UI Controller
════════════════════════════════════════════════════════════════ */
(function () {
  // ── State ────────────────────────────────────────────────────
  let activeFilter = null;  // 'pass' | 'fail' | 'warn' | null
  const runner = new CheckRunner();
  const rowMap = {};   // checkId → DOM row element

  // ── DOM refs ─────────────────────────────────────────────────
  const dropzone        = document.getElementById('dropzone');
  const fileInput       = document.getElementById('fileInput');
  const fileInfo        = document.getElementById('fileInfo');
  const fileName        = document.getElementById('fileName');
  const fileSize        = document.getElementById('fileSize');
  const fileClear       = document.getElementById('fileClear');
  const fileReload      = document.getElementById('fileReload');
  const runSvgBtn       = document.getElementById('runSvgBtn');
  const runAllBtn       = document.getElementById('runAllBtn');
  const clearResultsBtn = document.getElementById('clearResultsBtn');
  const resultsEl       = document.getElementById('results');
  const summaryBar      = document.getElementById('summaryBar');
  const svgSection      = document.getElementById('svgSection');
  const svgChecklist    = document.getElementById('svgChecklist');
  const apiSection      = document.getElementById('apiSection');
  const apiChecklist    = document.getElementById('apiChecklist');
  const apiToggleHeader = document.getElementById('apiToggleHeader');
  const apiToggleBtn    = document.getElementById('apiToggleBtn');
  const apiBody         = document.getElementById('apiBody');
  const apiToggleLabel  = document.getElementById('apiToggleLabel');
  const navValidate     = document.getElementById('navValidate');
  const navAlign        = document.getElementById('navAlign');
  const navEdit         = document.getElementById('navEdit');
  const navDownload     = document.getElementById('navDownload');
  const homeView        = document.getElementById('homeView');
  const validateView    = document.getElementById('validateView');
  const alignmentView   = document.getElementById('alignmentView');
  const editorView      = document.getElementById('editorView');

  function showView(name) {
    homeView.hidden = name !== 'home';
    validateView.hidden = name !== 'validate';
    alignmentView.hidden = name !== 'align';
    editorView.hidden = name !== 'editor';
    navValidate.classList.toggle('active', name === 'validate');
    navAlign.classList.toggle('active', name === 'align');
    navEdit.classList.toggle('active', name === 'editor');
    if (name === 'align' && window.AlignmentView) window.AlignmentView.enter();
    else if (window.AlignmentView) window.AlignmentView.exit();
    if (name === 'editor' && window.EditorView) window.EditorView.enter();
    else if (window.EditorView) window.EditorView.exit();
  }
  navValidate.addEventListener('click', () => { if (!navValidate.disabled) showView('validate'); });
  navAlign.addEventListener('click',    () => { if (!navAlign.disabled)    showView('align'); });
  navEdit.addEventListener('click',     () => { if (!navEdit.disabled)     showView('editor'); });
  navDownload.addEventListener('click', () => { if (!navDownload.disabled) downloadCurrentSvg(); });
  const sidebarHome = document.getElementById('sidebarHome');
  if (sidebarHome) sidebarHome.addEventListener('click', () => showView('home'));

  const homeValidateBtn = document.getElementById('homeValidateBtn');
  const homeAlignBtn    = document.getElementById('homeAlignBtn');
  if (homeValidateBtn) homeValidateBtn.addEventListener('click', () => {
    if (!homeValidateBtn.disabled) showView('validate');
  });
  if (homeAlignBtn) homeAlignBtn.addEventListener('click', () => {
    if (!homeAlignBtn.disabled) showView('align');
  });

  // ── File Handling ────────────────────────────────────────────
  fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
  fileClear.addEventListener('click', clearFile);
  if (fileReload) fileReload.addEventListener('click', () => {
    if (!window.AppState.hasSvg()) return;
    window.AppState.revertToOriginal();
    clearResults();
  });

  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  function loadFile(file) {
    if (!file) return;
    if (!file.name.endsWith('.svg') && file.type !== 'image/svg+xml') {
      alert('Please select a .svg file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      const probe = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (probe.querySelector('parsererror')) {
        alert('The file could not be parsed as valid XML/SVG.');
        return;
      }
      window.AppState.loadFromUpload(text, file.name);
      const fileNameText = fileName.querySelector('.file-info-name-text') || fileName;
      fileNameText.textContent = file.name;
      fileName.dataset.tooltip = file.name;
      fileSize.textContent = formatBytes(file.size);
      fileInfo.classList.add('visible');
      runSvgBtn.disabled = false;
      updateRunAllBtn();
      clearResults();
      if (window.AlignmentView) window.AlignmentView.setSvg(text, file.name);
      if (window.EditorView) window.EditorView.setSvg(text);
      setNavEnabled(true);
    };
    reader.readAsText(file);
  }

  function clearFile() {
    window.AppState.clear();
    fileInput.value = '';
    fileInfo.classList.remove('visible');
    runSvgBtn.disabled = true;
    runAllBtn.disabled = true; // no SVG = always disabled regardless of credentials
    clearResults();
    if (window.AlignmentView) window.AlignmentView.clear();
    if (window.EditorView) window.EditorView.clear();
    setNavEnabled(false);
    if (!alignmentView.hidden || !validateView.hidden || !editorView.hidden) showView('home');
  }

  function setNavEnabled(enabled) {
    const btns = [navValidate, navAlign, navEdit, navDownload];
    btns.forEach(b => {
      b.disabled = !enabled;
      if (enabled) b.removeAttribute('title');
      else b.title = 'Load an SVG first';
    });
    if (homeValidateBtn) {
      homeValidateBtn.disabled = !enabled;
      if (enabled) homeValidateBtn.removeAttribute('title');
      else homeValidateBtn.title = 'Load an SVG first';
    }
    if (homeAlignBtn) {
      homeAlignBtn.disabled = !enabled;
      if (enabled) homeAlignBtn.removeAttribute('title');
      else homeAlignBtn.title = 'Load an SVG first';
    }
  }

  function downloadCurrentSvg() {
    if (!window.AppState.hasSvg()) return;
    const text = window.AppState.svgText;
    const origName = window.AppState.fileName || 'image.svg';
    const dot = origName.lastIndexOf('.');
    const stem = dot > 0 ? origName.slice(0, dot) : origName;
    const ext  = dot > 0 ? origName.slice(dot)    : '.svg';
    const name = window.AppState.isEdited ? `${stem}-edited${ext}` : origName;
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ── Collapsible API panel ────────────────────────────────────
  apiToggleHeader.addEventListener('click', () => {
    const isHidden = apiBody.classList.contains('hidden');
    apiBody.classList.toggle('hidden', !isHidden);
    apiToggleBtn.classList.toggle('open', isHidden);
    apiToggleLabel.textContent = isHidden ? 'Hide' : 'Show';
  });

  // ── Run Checks ───────────────────────────────────────────────
  runSvgBtn.addEventListener('click', () => runChecks(false));
  runAllBtn.addEventListener('click', () => runChecks(true));
  clearResultsBtn.addEventListener('click', clearResults);

  async function runChecks(includeApi) {
    const svgDoc = window.AppState.getSvgDoc();
    if (!svgDoc) {
      alert('Current SVG is not valid XML — fix it in the editor first.');
      return;
    }
    clearResults();
    setRunning(true);

    resultsEl.classList.add('visible');
    clearResultsBtn.style.display = '';

    // Pre-populate SVG rows as "pending"
    svgSection.style.display = '';
    svgChecklist.innerHTML = '';
    for (const c of CheckRegistry.SVG_CHECKS) {
      const row = createRow(c, 'pending', '');
      svgChecklist.appendChild(row);
      rowMap[c.id] = row;
    }

    if (includeApi) {
      apiSection.style.display = '';
      apiChecklist.innerHTML = '';
      for (const c of CheckRegistry.API_CHECKS) {
        const row = createRow(c, 'pending', '');
        apiChecklist.appendChild(row);
        rowMap[c.id] = row;
      }
    }

    updateSummary();

    // Run SVG checks
    await runner.runSVGChecks(svgDoc, (check, state, msg) => {
      updateRow(check, state, msg);
      updateSummary();
    });

    // Run API checks if requested
    if (includeApi) {
      const cfg = getApiConfig();
      await runner.runAPIChecks(cfg, (check, state, msg) => {
        updateRow(check, state, msg);
        updateSummary();
      });
    }

    setRunning(false);
    autoSelectFilter();
  }

  // ── API field persistence ─────────────────────────────────────
  const CACHE_KEYS = ['geoApiUrl', 'apiKey', 'siteId'];

  function getApiConfig() {
    return {
      geoApiUrl: document.getElementById('geoApiUrl').value.trim(),
      apiKey:    document.getElementById('apiKey').value.trim(),
      siteId:    document.getElementById('siteId').value.trim(),
    };
  }

  function hasCredentials() {
    return CACHE_KEYS.every(id => document.getElementById(id).value.trim() !== '');
  }

  function updateRunAllBtn() {
    runAllBtn.disabled = !window.AppState.hasSvg() || !hasCredentials();
  }

  function setRunning(running) {
    const hasSvg = window.AppState.hasSvg();
    runSvgBtn.disabled = running || !hasSvg;
    runAllBtn.disabled = running || !hasSvg || !hasCredentials();
    const btnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${running ? 'spinning' : ''}">` +
      (running
        ? '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
        : '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>') +
      '</svg>';
    runSvgBtn.innerHTML = btnIcon + (running ? ' Running…' : ' Run SVG Checks');
    lucide.createIcons();
  }

  function clearResults() {
    Object.keys(rowMap).forEach(k => delete rowMap[k]);
    svgChecklist.innerHTML = '';
    apiChecklist.innerHTML = '';
    summaryBar.innerHTML = '';
    svgSection.style.display = 'none';
    apiSection.style.display = 'none';
    resultsEl.classList.remove('visible');
    clearResultsBtn.style.display = 'none';
    activeFilter = null;
    applyFilter();
  }

  // ── Filter ───────────────────────────────────────────────────
  function setFilter(state) {
    activeFilter = activeFilter === state ? null : state; // click active → deselect
    applyFilter();
    updateSummary();
  }

  function applyFilter() {
    resultsEl.classList.remove('filter-pass', 'filter-fail', 'filter-warn');
    if (activeFilter) resultsEl.classList.add(`filter-${activeFilter}`);
  }

  function autoSelectFilter() {
    const rows = Object.values(rowMap);
    if (rows.some(r => r.classList.contains('fail')))      activeFilter = 'fail';
    else if (rows.some(r => r.classList.contains('warn'))) activeFilter = 'warn';
    else if (rows.some(r => r.classList.contains('pass'))) activeFilter = 'pass';
    else activeFilter = null;
    applyFilter();
    updateSummary();
  }

  // ── Row helpers ──────────────────────────────────────────────
  const STATE_ICONS = {
    pass:    '<polyline points="20 6 9 17 4 12"/>',
    fail:    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    warn:    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    running: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    pending: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };

  function createRow(check, state, message) {
    const div = document.createElement('div');
    div.className = `check-row ${state}`;
    div.dataset.id = check.id;
    div.innerHTML = rowHTML(check, state, message);
    return div;
  }

  function updateRow(check, state, message) {
    const row = rowMap[check.id];
    if (!row) return;
    row.className = `check-row ${state}`;
    row.innerHTML = rowHTML(check, state, message);
  }

  function rowHTML(check, state, message) {
    const iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="${state === 'running' ? 'spinning' : ''}">${STATE_ICONS[state] || STATE_ICONS.pending}</svg>`;
    const severityBadge = (state === 'fail' || state === 'warn')
      ? `<span class="check-severity sev-${check.severity}">${check.severity}</span>`
      : '';
    // Replace \n with <br> for HTML rendering
    const msgBlock = message
      ? `<div class="check-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`
      : '';
    return `
      <div class="check-icon">${iconSvg}</div>
      <div class="check-body">
        <div class="check-name">${escapeHtml(check.name)}</div>
        <div class="check-desc">${escapeHtml(check.description)}</div>
        ${msgBlock}
      </div>
      ${severityBadge}
    `;
  }

  // ── Summary bar ──────────────────────────────────────────────
  function updateSummary() {
    const rows = Object.values(rowMap);
    const counts = { pass: 0, fail: 0, warn: 0, running: 0, pending: 0 };
    rows.forEach(r => {
      const state = [...r.classList].find(c => counts.hasOwnProperty(c));
      if (state) counts[state]++;
    });

    const isSettled = counts.running === 0 && counts.pending === 0 && rows.length > 0;

    const pill = (state, pillClass, iconPath, label) => {
      if (!counts[state]) return '';
      const active = isSettled && activeFilter === state ? ' active' : '';
      const clickable = isSettled ? ` role="button" tabindex="0" data-filter="${state}"` : '';
      return `<div class="summary-pill ${pillClass}${active}"${clickable}>` +
        `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>` +
        `${counts[state]} ${label}</div>`;
    };

    summaryBar.innerHTML = [
      pill('pass', 'pill-pass', '<polyline points="20 6 9 17 4 12"/>', counts.pass !== 1 ? 'passed' : 'passed'),
      pill('fail', 'pill-fail', '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', counts.fail !== 1 ? 'errors' : 'error'),
      pill('warn', 'pill-warn', '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', counts.warn !== 1 ? 'warnings' : 'warning'),
      counts.running ? `<div class="summary-pill pill-pending"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="spinning"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Running…</div>` : '',
      (counts.pending && !counts.running) ? `<div class="summary-pill pill-pending">${counts.pending} pending</div>` : '',
    ].join('');

    // Wire click handlers on filterable pills
    summaryBar.querySelectorAll('[data-filter]').forEach(el => {
      el.addEventListener('click', () => setFilter(el.dataset.filter));
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Restore saved values on load
  CACHE_KEYS.forEach(id => {
    const saved = localStorage.getItem(`vsv_${id}`);
    if (saved) document.getElementById(id).value = saved;
  });
  updateRunAllBtn(); // re-evaluate after restoring saved credentials

  // Save on change and re-evaluate Run All button state
  CACHE_KEYS.forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      localStorage.setItem(`vsv_${id}`, e.target.value);
      updateRunAllBtn();
    });
  });

  // Clear buttons
  document.querySelectorAll('.input-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  });

  // Init Lucide icons
  lucide.createIcons();
})();
