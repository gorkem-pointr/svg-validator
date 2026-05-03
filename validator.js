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
 * Transform an SVG local bounding box through a CTM to get the axis-aligned
 * bounding box in the SVG viewport coordinate space.
 */
function transformBBox(bbox, ctm) {
  if (!ctm) return bbox;
  const corners = [
    { x: bbox.x,              y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x,              y: bbox.y + bbox.height },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
  ];
  const tx = corners.map(p => ctm.a * p.x + ctm.c * p.y + ctm.e);
  const ty = corners.map(p => ctm.b * p.x + ctm.d * p.y + ctm.f);
  return {
    x:      Math.min(...tx),
    y:      Math.min(...ty),
    width:  Math.max(...tx) - Math.min(...tx),
    height: Math.max(...ty) - Math.min(...ty),
  };
}

/**
 * Intersection-over-Union for two axis-aligned bounding boxes.
 */
function computeIoU(a, b) {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  if (intersection === 0) return 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
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


function findOverlaps(doc, elements, iouThreshold = 0.1) {
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

  const bboxes = [];
  for (const el of elements) {
    const id = el.getAttribute('id');
    if (!id) continue;
    
    const cloned = clonedById.get(id);
    if (!cloned) continue;
    
    try {
      const localBBox = cloned.getBBox();
      const ctm = cloned.getCTM();
      const bbox = transformBBox(localBBox, ctm);
      if (bbox.width > 0 && bbox.height > 0) {
        bboxes.push({ id, bbox });
      }
    } catch (e) {
      // skip elements that cannot be measured (e.g. invisible or degenerate)
    }
  }
  document.body.removeChild(container);

  // Check every pair for IoU > threshold
  const overlaps = [];
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      const iou = computeIoU(bboxes[i].bbox, bboxes[j].bbox);
      if (iou > iouThreshold) {
        overlaps.push(`"${bboxes[i].id}" & "${bboxes[j].id}" (IoU: ${(iou * 100).toFixed(1)}%)`);
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
      id: 'svg-anchor-shapes',
      name: 'Anchor shape elements',
      description: 'Each anchor <g> must contain a <circle> or <ellipse>',
      severity: 'error',
      async run(doc) {
        try {
          const gps = getSectionById(doc, section_ids.gps);
          const groups = Array.from(gps.children).filter(c => c.tagName === 'g');

          for (const g of groups) {
            const shape = g.querySelector('circle, ellipse');
            if (!shape) {
              return { pass: false, message: `Anchor group "${g.getAttribute('id') || ''}" is missing a <circle> or <ellipse> shape.` };
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
      name: 'Anchor coordinate encoding',
      description: 'Each anchor <g> id must encode "lat,lon" and shape must have valid cx and cy attributes',
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
            const shape = g.querySelector('circle, ellipse');
            const cx = shape.getAttribute('cx');
            const cy = shape.getAttribute('cy');
            if (cx === null || cy === null || isNaN(parseFloat(cx)) || isNaN(parseFloat(cy))) {
              return { pass: false, message: `Anchor group "${id}" has invalid coordinates.` };
            }
            anchors.push({ id, lat, lon, cx: parseFloat(cx), cy: parseFloat(cy) });
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

          const overlaps = findOverlaps(doc, elements, 0.2);
          if (overlaps.length > 0) {
            const shown = overlaps.slice(0, 10);
            const more = overlaps.length > 10 ? `\n…and ${overlaps.length - 10} more` : '';
            return { pass: false, message: `${overlaps.length} overlapping pair(s) detected (IoU > 20%):\n${shown.join('\n')}${more}` };
          }

          return { pass: true, message: `No overlapping modular elements detected (checked ${bboxes.length} elements, ${bboxes.length * (bboxes.length - 1) / 2} pairs).` };
          
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
          const gpsGroup = doc.getElementById(section_ids.gps);
          const scaleLine = gpsGroup.querySelector('line');
          if (scaleLine) {
            return { pass: true, message: `Scale line found in GPS group.` };
          } else {
            return { pass: false, message: `No scale line found in GPS group.` };
          }
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

          // Get line object from GPS group if it exists to provide a visual reference for the scale (optional, not required for the check)
          const gpsGroup = doc.getElementById(section_ids.gps);
          const scaleLine = gpsGroup.querySelector('line');
          let lineDetail = '';
          if (scaleLine) {
            // remove "m" suffix if present and parse the length in meters
            const meterLength = parseFloat(scaleLine.getAttribute('id').replace('m', ''));
            const x1 = parseFloat(scaleLine.getAttribute('x1'));
            const y1 = parseFloat(scaleLine.getAttribute('y1'));
            const x2 = parseFloat(scaleLine.getAttribute('x2'));
            const y2 = parseFloat(scaleLine.getAttribute('y2'));
            const pixelLength = Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
            const metersPerPixel_line = meterLength / pixelLength;

            // Compare it to anchor based scale
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
  let svgDoc = null;
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
  const homeView        = document.getElementById('homeView');
  const validateView    = document.getElementById('validateView');
  const alignmentView   = document.getElementById('alignmentView');

  function showView(name) {
    homeView.hidden = name !== 'home';
    validateView.hidden = name !== 'validate';
    alignmentView.hidden = name !== 'align';
    navValidate.classList.toggle('active', name === 'validate');
    navAlign.classList.toggle('active', name === 'align');
    if (name === 'align' && window.AlignmentView) window.AlignmentView.enter();
    else if (window.AlignmentView) window.AlignmentView.exit();
  }
  navValidate.addEventListener('click', () => { if (!navValidate.disabled) showView('validate'); });
  navAlign.addEventListener('click', () => { if (!navAlign.disabled) showView('align'); });
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
      const parser = new DOMParser();
      svgDoc = parser.parseFromString(text, 'image/svg+xml');
      const parseErr = svgDoc.querySelector('parsererror');
      if (parseErr) {
        alert('The file could not be parsed as valid XML/SVG.');
        return;
      }
      fileName.textContent = file.name;
      fileSize.textContent = formatBytes(file.size);
      fileInfo.classList.add('visible');
      runSvgBtn.disabled = false;
      updateRunAllBtn();
      clearResults();
      if (window.AlignmentView) {
        window.AlignmentView.setSvg(text, file.name);
      }
      navValidate.disabled = false;
      navValidate.removeAttribute('title');
      navAlign.disabled = false;
      navAlign.removeAttribute('title');
      if (homeValidateBtn) { homeValidateBtn.disabled = false; homeValidateBtn.removeAttribute('title'); }
      if (homeAlignBtn)    { homeAlignBtn.disabled = false;    homeAlignBtn.removeAttribute('title'); }
    };
    reader.readAsText(file);
  }

  function clearFile() {
    svgDoc = null;
    fileInput.value = '';
    fileInfo.classList.remove('visible');
    runSvgBtn.disabled = true;
    runAllBtn.disabled = true; // no SVG = always disabled regardless of credentials
    clearResults();
    if (window.AlignmentView) {
      window.AlignmentView.clear();
    }
    navValidate.disabled = true;
    navValidate.title = 'Load an SVG first';
    navAlign.disabled = true;
    navAlign.title = 'Load an SVG first';
    if (homeValidateBtn) { homeValidateBtn.disabled = true; homeValidateBtn.title = 'Load an SVG first'; }
    if (homeAlignBtn)    { homeAlignBtn.disabled = true;    homeAlignBtn.title = 'Load an SVG first'; }
    if (!alignmentView.hidden || !validateView.hidden) showView('home');
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
    if (!svgDoc) return;
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
    runAllBtn.disabled = !svgDoc || !hasCredentials();
  }

  function setRunning(running) {
    runSvgBtn.disabled = running || !svgDoc;
    runAllBtn.disabled = running || !svgDoc || !hasCredentials();
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
