/* ════════════════════════════════════════════════════════════════
   AppState — single source of truth for the currently loaded SVG.

   svgText is the live, possibly-edited content. Validate, Align, Edit,
   and Download all read from here. Mutations broadcast to subscribers.
   Each listener receives a `source` tag so it can skip its own updates.
════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  let originalSvgText = '';
  let svgText = '';
  let fileName = '';
  const listeners = new Set();

  function notify(source) {
    for (const fn of listeners) {
      try { fn({ source }); } catch (e) { console.error(e); }
    }
  }

  window.AppState = {
    get fileName()         { return fileName; },
    get svgText()          { return svgText; },
    get originalSvgText()  { return originalSvgText; },
    get isEdited()         { return !!originalSvgText && svgText !== originalSvgText; },
    hasSvg()               { return !!svgText; },

    loadFromUpload(text, name) {
      originalSvgText = text || '';
      svgText = originalSvgText;
      fileName = name || '';
      notify('upload');
    },

    setSvgText(text, source) {
      if (text === svgText) return;
      svgText = text || '';
      notify(source || 'unknown');
    },

    revertToOriginal() {
      if (svgText === originalSvgText) return;
      svgText = originalSvgText;
      notify('revert');
    },

    clear() {
      originalSvgText = '';
      svgText = '';
      fileName = '';
      notify('clear');
    },

    getSvgDoc() {
      if (!svgText) return null;
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      if (doc.querySelector('parsererror')) return null;
      return doc;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
