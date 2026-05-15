/* ════════════════════════════════════════════════════════════════
   Editor view — split layout with two modes:
     • Tree: Chrome-DevTools-style collapsible DOM tree (primary).
     • Raw XML: CodeMirror text editor (escape hatch).

   Selection syncs both ways between the tree and the preview via a
   `data-vsv-id` attribute attached to every Element in the working
   Document. The preview is a deep clone of the working documentElement,
   so the same id resolves to the matching node on either side.

   Public API (window.EditorView):
     setSvg(text) – update from external source
     clear()      – wipe editor and preview
     enter()      – lazy init + refresh
     exit()       – noop
     hasSvg()     – bool
════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  let initialized = false;
  let mode = 'tree';                  // 'tree' | 'raw'
  let workingDoc = null;              // current Document (annotated with data-vsv-id)
  let nextId = 0;
  const elementById = new Map();      // id (string) → Element in workingDoc
  let selectedId = null;
  let cm = null;
  let cmSuppress = false;
  let cmDebounce = null;
  let lastValidText = '';

  // DOM refs (resolved on init)
  let previewEl, treeEl, codeEl, errorBanner, selOverlay,
      modeTreeBtn, modeRawBtn, splitterEl, splitEl, leftPaneEl;

  const ATTR_ID = 'data-vsv-id';
  const SPLIT_KEY = 'vsv_editor_split_pct';
  const ATTR_MAX_DISPLAY = 40;

  function init() {
    if (initialized) return;
    initialized = true;

    previewEl    = document.getElementById('editorPreview');
    treeEl       = document.getElementById('editorTree');
    codeEl       = document.getElementById('editorCode');
    errorBanner  = document.getElementById('editorErrorBanner');
    selOverlay   = document.getElementById('editorSelOverlay');
    modeTreeBtn  = document.getElementById('editorModeTree');
    modeRawBtn   = document.getElementById('editorModeRaw');
    splitterEl   = document.getElementById('editorSplitter');
    splitEl      = document.getElementById('editorSplit');
    leftPaneEl   = document.getElementById('editorLeftPane');

    setupSplitter();
    setupModeButtons();
    setupPreviewClick();
    window.addEventListener('resize', hideOverlay);

    // Initial load from AppState.
    rebuildFromText(window.AppState.svgText || '');
  }

  // ── Splitter ──────────────────────────────────────────────────────
  function setupSplitter() {
    const stored = parseFloat(localStorage.getItem(SPLIT_KEY));
    if (!Number.isNaN(stored) && stored >= 15 && stored <= 85) {
      splitEl.style.setProperty('--editor-left-width', stored + '%');
    }

    let dragging = false;
    splitterEl.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      splitterEl.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = splitEl.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(15, Math.min(85, pct));
      splitEl.style.setProperty('--editor-left-width', pct + '%');
      hideOverlay();
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const pct = splitEl.style.getPropertyValue('--editor-left-width');
      if (pct) localStorage.setItem(SPLIT_KEY, parseFloat(pct).toFixed(2));
      if (cm) cm.refresh();
    });
  }

  // ── Mode switching ────────────────────────────────────────────────
  function setupModeButtons() {
    modeTreeBtn.addEventListener('click', () => switchMode('tree'));
    modeRawBtn.addEventListener('click',  () => switchMode('raw'));
  }

  function switchMode(target) {
    if (target === mode) return;
    if (target === 'tree') {
      // Going tree→ only works if current text parses.
      const text = cm ? cm.getValue() : (workingDoc ? serializeWorking() : '');
      if (parseError(text)) {
        // Force user to fix raw first.
        showError('Fix XML errors before switching to Tree view.');
        return;
      }
      // Promote cm text into workingDoc.
      rebuildFromText(text);
      window.AppState.setSvgText(text, 'editor');
      mode = 'tree';
      treeEl.hidden = false;
      codeEl.hidden = true;
      modeTreeBtn.classList.add('active');
      modeRawBtn.classList.remove('active');
    } else {
      ensureCodeMirror();
      const text = serializeWorking();
      cmSuppress = true; cm.setValue(text); cmSuppress = false;
      mode = 'raw';
      treeEl.hidden = true;
      codeEl.hidden = false;
      modeTreeBtn.classList.remove('active');
      modeRawBtn.classList.add('active');
      requestAnimationFrame(() => cm.refresh());
    }
  }

  function ensureCodeMirror() {
    if (cm) return;
    cm = CodeMirror(codeEl, {
      value: '',
      mode: 'application/xml',
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 2,
      matchTags: { bothTags: true },
      autoCloseTags: true,
      viewportMargin: Infinity,
      theme: 'default',
    });
    cm.on('change', () => {
      if (cmSuppress) return;
      if (cmDebounce) clearTimeout(cmDebounce);
      cmDebounce = setTimeout(applyRawEdit, 250);
    });
  }

  function applyRawEdit() {
    if (!cm) return;
    const text = cm.getValue();
    const err = parseError(text);
    if (err) {
      showError(err);
      return;
    }
    hideError();
    lastValidText = text;
    // Build a fresh working doc (the tree will rebuild lazily on next switchMode).
    // Update preview now so user sees their raw edits live.
    rebuildFromText(text);
    window.AppState.setSvgText(text, 'editor');
  }

  // ── Working document ──────────────────────────────────────────────
  function rebuildFromText(text) {
    if (!text || !text.trim()) {
      workingDoc = null;
      elementById.clear();
      treeEl.innerHTML = '';
      previewEl.querySelectorAll('svg').forEach(s => s.remove());
      hideOverlay();
      return;
    }
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const errEl = doc.querySelector('parsererror');
    if (errEl) {
      // Don't clobber working doc; surface error.
      showError(condense(errEl.textContent || 'Parse error'));
      return;
    }
    hideError();
    annotateIds(doc);
    workingDoc = doc;
    lastValidText = text;
    renderTree();
    renderPreview();
    if (selectedId && elementById.has(selectedId)) {
      selectId(selectedId, { scroll: false });
    } else {
      selectedId = null;
      hideOverlay();
    }
  }

  function annotateIds(doc) {
    elementById.clear();
    nextId = 0;
    walk(doc.documentElement, el => {
      const id = String(nextId++);
      el.setAttribute(ATTR_ID, id);
      elementById.set(id, el);
    });
  }

  function walk(el, fn) {
    fn(el);
    for (const c of el.children) walk(c, fn);
  }

  function serializeWorking() {
    if (!workingDoc) return '';
    const clone = workingDoc.documentElement.cloneNode(true);
    clone.querySelectorAll('[' + ATTR_ID + ']').forEach(e => e.removeAttribute(ATTR_ID));
    clone.removeAttribute(ATTR_ID);
    return new XMLSerializer().serializeToString(clone);
  }

  // ── Preview rendering ─────────────────────────────────────────────
  function renderPreview() {
    if (!previewEl) return;
    // Remove existing svg (keep the overlay div).
    previewEl.querySelectorAll('svg').forEach(s => s.remove());
    if (!workingDoc) return;
    const clone = workingDoc.documentElement.cloneNode(true);
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.maxWidth  = '100%';
    clone.style.maxHeight = '100%';
    clone.style.width     = '100%';
    clone.style.height    = '100%';
    previewEl.appendChild(clone);
    // Selection overlay is positioned absolutely; keep it last in DOM order.
    previewEl.appendChild(selOverlay);
  }

  // ── Tree rendering ────────────────────────────────────────────────
  function renderTree() {
    treeEl.innerHTML = '';
    if (!workingDoc) return;
    const root = buildTreeNode(workingDoc.documentElement, /*depth*/ 0);
    treeEl.appendChild(root);
  }

  function buildTreeNode(el, depth) {
    const id = el.getAttribute(ATTR_ID);
    const node = document.createElement('div');
    node.className = 'tnode';
    node.dataset.id = id;

    const hasChildren = el.children.length > 0;
    const textChild = !hasChildren && el.textContent && el.textContent.trim() ? el.textContent.trim() : null;
    if (!hasChildren && !textChild) node.classList.add('leaf');
    // Default expansion: root + first child layer expanded, rest collapsed.
    if (depth >= 2) node.classList.add('collapsed');

    const header = document.createElement('div');
    header.className = 'tnode-header';
    header.appendChild(makeChevron());
    header.appendChild(makeTagLine(el));
    node.appendChild(header);

    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('tchevron') || e.target.closest('.tchevron')) {
        node.classList.toggle('collapsed');
        e.stopPropagation();
        return;
      }
      if (e.target.classList.contains('tnode-attr-value')) return; // handled separately
    });
    header.addEventListener('mouseenter', () => showOverlayForId(id));
    header.addEventListener('mouseleave', () => hideOverlay());

    if (textChild) {
      const t = document.createElement('span');
      t.className = 'tnode-text';
      t.textContent = textChild.length > 80 ? textChild.slice(0, 80) + '…' : textChild;
      t.title = textChild;
      node.appendChild(t);
    }

    if (hasChildren) {
      const childrenC = document.createElement('div');
      childrenC.className = 'tchildren';
      for (const c of el.children) childrenC.appendChild(buildTreeNode(c, depth + 1));
      node.appendChild(childrenC);
    }

    return node;
  }

  function makeChevron() {
    const c = document.createElement('span');
    c.className = 'tchevron';
    c.textContent = '▼';
    return c;
  }

  function makeTagLine(el) {
    const line = document.createElement('span');
    line.className = 'tnode-tagline';
    const tag = el.tagName;

    const lt   = span('tnode-punct', '<');
    const name = span('tnode-tag', tag);
    line.appendChild(lt);
    line.appendChild(name);

    for (const attr of el.attributes) {
      if (attr.name === ATTR_ID) continue;
      line.appendChild(document.createTextNode(' '));
      const an = span('tnode-attr-name', attr.name);
      const eq = span('tnode-punct', '=');
      const qO = span('tnode-punct', '"');
      const av = span('tnode-attr-value', truncate(attr.value));
      av.dataset.attr = attr.name;
      av.dataset.full = attr.value;
      av.title = attr.value;
      const qC = span('tnode-punct', '"');
      line.appendChild(an); line.appendChild(eq); line.appendChild(qO);
      line.appendChild(av); line.appendChild(qC);

      av.addEventListener('click', e => {
        e.stopPropagation();
        beginAttrEdit(av, el);
      });
    }
    line.appendChild(span('tnode-punct', '>'));
    return line;
  }

  function span(cls, txt) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = txt;
    return s;
  }

  function truncate(v) {
    if (v.length <= ATTR_MAX_DISPLAY) return v;
    return v.slice(0, ATTR_MAX_DISPLAY - 1) + '…';
  }

  // ── Inline attribute editing ──────────────────────────────────────
  function beginAttrEdit(span, el) {
    if (span.classList.contains('editing')) return;
    const attrName = span.dataset.attr;
    const original = span.dataset.full;
    span.classList.add('editing');
    span.contentEditable = 'true';
    span.textContent = original;
    span.focus();
    // Select all
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      span.contentEditable = 'false';
      span.classList.remove('editing');
      const newVal = span.textContent;
      if (save && newVal !== original) {
        el.setAttribute(attrName, newVal);
        span.dataset.full = newVal;
        span.title = newVal;
        span.textContent = truncate(newVal);
        pushChange();
      } else {
        span.title = original;
        span.dataset.full = original;
        span.textContent = truncate(original);
      }
    }
    span.addEventListener('blur', () => commit(true), { once: true });
    span.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
  }

  function pushChange() {
    const text = serializeWorking();
    lastValidText = text;
    renderPreview();
    hideOverlay();
    window.AppState.setSvgText(text, 'editor');
  }

  // ── Selection ─────────────────────────────────────────────────────
  function selectId(id, opts) {
    if (!elementById.has(id)) return;
    selectedId = id;
    treeEl.querySelectorAll('.tnode-header.selected').forEach(h => h.classList.remove('selected'));
    const tNode = treeEl.querySelector(`.tnode[data-id="${cssEscape(id)}"]`);
    if (tNode) {
      let p = tNode.parentElement;
      while (p && p !== treeEl) {
        if (p.classList && p.classList.contains('tnode')) p.classList.remove('collapsed');
        p = p.parentElement;
      }
      const header = tNode.firstElementChild;
      if (header) {
        header.classList.add('selected');
        if (opts && opts.scroll) header.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function showOverlayForId(id) {
    if (!id || !elementById.has(id)) { hideOverlay(); return; }
    const svg = previewEl.querySelector('svg');
    if (!svg) { hideOverlay(); return; }
    const target = svg.matches(`[${ATTR_ID}="${cssEscape(id)}"]`)
      ? svg
      : svg.querySelector(`[${ATTR_ID}="${cssEscape(id)}"]`);
    if (!target) { hideOverlay(); return; }
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideOverlay(); return; }
    const host = previewEl.getBoundingClientRect();
    selOverlay.hidden = false;
    selOverlay.style.left   = (rect.left - host.left + previewEl.scrollLeft) + 'px';
    selOverlay.style.top    = (rect.top  - host.top  + previewEl.scrollTop)  + 'px';
    selOverlay.style.width  = rect.width  + 'px';
    selOverlay.style.height = rect.height + 'px';
  }

  function setupPreviewClick() {
    previewEl.addEventListener('click', e => {
      if (e.target === selOverlay) return;
      // Find topmost element with data-vsv-id (climb if needed).
      let n = e.target;
      while (n && n !== previewEl && !(n.getAttribute && n.getAttribute(ATTR_ID) != null)) {
        n = n.parentNode;
      }
      if (!n || n === previewEl) return;
      const id = n.getAttribute(ATTR_ID);
      if (id) selectId(id, { scroll: true });
    });
  }

  function hideOverlay() {
    if (selOverlay) selOverlay.hidden = true;
  }

  function cssEscape(s) {
    return String(s).replace(/"/g, '\\"');
  }

  // ── Parse / error helpers ─────────────────────────────────────────
  function parseError(text) {
    if (!text || !text.trim()) return 'SVG is empty';
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) return condense(err.textContent || 'Parse error');
    if (!doc.querySelector('svg')) return 'No <svg> root element found';
    return null;
  }

  function condense(s) {
    return s.trim().replace(/\s+/g, ' ').slice(0, 400);
  }

  function showError(msg) {
    if (!errorBanner) return;
    errorBanner.textContent = 'SVG parse error: ' + msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    if (!errorBanner) return;
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  }

  // ── AppState sync (external changes) ──────────────────────────────
  if (window.AppState) {
    window.AppState.subscribe(({ source }) => {
      if (source === 'editor') return;
      const t = window.AppState.svgText || '';
      if (!initialized) { lastValidText = t; return; }
      // External update: replace working doc and tree.
      rebuildFromText(t);
      if (mode === 'raw' && cm) {
        cmSuppress = true; cm.setValue(t); cmSuppress = false;
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────
  window.EditorView = {
    setSvg(text) {
      if (initialized) rebuildFromText(text || '');
      else lastValidText = text || '';
    },
    clear() {
      if (!initialized) return;
      workingDoc = null;
      elementById.clear();
      treeEl.innerHTML = '';
      previewEl.querySelectorAll('svg').forEach(s => s.remove());
      hideOverlay();
      hideError();
      if (cm) { cmSuppress = true; cm.setValue(''); cmSuppress = false; }
      lastValidText = '';
      selectedId = null;
    },
    enter() {
      init();
      const t = window.AppState.svgText || '';
      if (!workingDoc || serializeWorking() !== t) rebuildFromText(t);
      if (mode === 'raw' && cm) requestAnimationFrame(() => cm.refresh());
      hideOverlay();
    },
    exit() {},
    hasSvg() { return !!(window.AppState && window.AppState.hasSvg()); },
  };
})();
