/**
 * Pan/zoom for a diagram viewport: wheel to zoom (centered on the cursor),
 * hold Space + drag to pan, `.fit()` to re-center. Double-clicking empty canvas
 * deliberately does nothing — it used to call `.fit()`, but resetting the whole
 * view on a stray double-click was a surprising, hard-to-undo accident.
 *
 * Panning is gated behind Space (à la Figma/Miro) rather than "any drag":
 * a plain click has natural pixel jitter between mousedown and mouseup, so
 * treating any small drag as a pan swallowed real clicks on the diagram
 * (e.g. hotpaths pin-toggling). With Space required, a plain click is never
 * ambiguous with a pan gesture — and while Space is held the diagram itself
 * is made non-interactive (pointer-events: none), so hovering/clicking over
 * nodes mid-pan can never trigger their own handlers either.
 */
export function attachPanZoom(
  viewportEl,
  contentEl,
  { minScale = 0.002, maxScale = 80, fitMaxScale = 1.5, padding = 40, onChange } = {}
) {
  let x = 0;
  let y = 0;
  let scale = 1;
  let dragging = false;
  let spaceHeld = false;
  let startX = 0;
  let startY = 0;
  let startPanX = 0;
  let startPanY = 0;

  contentEl.style.transformOrigin = '0 0';
  contentEl.style.position = 'absolute';
  contentEl.style.top = '0';
  contentEl.style.left = '0';
  viewportEl.title = 'Hold Space + drag to pan';

  function apply() {
    contentEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    onChange?.();
  }

  function clampScale(s) {
    return Math.min(maxScale, Math.max(minScale, s));
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewportEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const newScale = clampScale(scale * factor);
    x = px - ((px - x) * newScale) / scale;
    y = py - ((py - y) * newScale) / scale;
    scale = newScale;
    apply();
  }

  function fit() {
    const svg = contentEl.querySelector('svg');
    if (!svg) {
      return;
    }
    const viewBox = svg.viewBox?.baseVal;
    let w = viewBox?.width;
    let h = viewBox?.height;
    if (!w || !h) {
      const bbox = svg.getBBox();
      w = bbox.width;
      h = bbox.height;
    }
    if (!w || !h) {
      return;
    }
    const rect = viewportEl.getBoundingClientRect();
    const availW = Math.max(rect.width - padding * 2, 10);
    const availH = Math.max(rect.height - padding * 2, 10);
    scale = clampScale(Math.min(availW / w, availH / h, fitMaxScale));
    x = (rect.width - w * scale) / 2;
    y = (rect.height - h * scale) / 2;
    apply();
  }

  function stopDrag() {
    if (!dragging) {
      return;
    }
    dragging = false;
    viewportEl.classList.remove('panning');
  }

  function isEditableTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function setSpaceHeld(held) {
    if (spaceHeld === held) {
      return;
    }
    spaceHeld = held;
    viewportEl.classList.toggle('space-pan', held);
    // While panning is armed, the diagram itself stops being a click/hover
    // target — the viewport (its parent) receives the pointer events instead.
    contentEl.style.pointerEvents = held ? 'none' : '';
    if (!held) {
      stopDrag();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || isEditableTarget(document.activeElement)) {
      return;
    }
    e.preventDefault();
    setSpaceHeld(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      setSpaceHeld(false);
    }
  });
  window.addEventListener('blur', () => setSpaceHeld(false));

  viewportEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false }
  );

  viewportEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !spaceHeld) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = x;
    startPanY = y;
    viewportEl.classList.add('panning');
    viewportEl.setPointerCapture(e.pointerId);
  });

  viewportEl.addEventListener('pointermove', (e) => {
    if (!dragging) {
      return;
    }
    x = startPanX + (e.clientX - startX);
    y = startPanY + (e.clientY - startY);
    apply();
  });

  viewportEl.addEventListener('pointerup', stopDrag);
  viewportEl.addEventListener('pointercancel', stopDrag);

  /** Pan (without changing zoom) so content-space point (cx, cy) is centered. */
  function centerOnPoint(cx, cy) {
    const rect = viewportEl.getBoundingClientRect();
    x = rect.width / 2 - cx * scale;
    y = rect.height / 2 - cy * scale;
    apply();
  }

  /** Convert a client (viewport-relative) point to content-space coordinates. */
  function clientToContent(clientX, clientY) {
    const rect = viewportEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - x) / scale,
      y: (clientY - rect.top - y) / scale,
    };
  }

  /** Nudges the pan by a raw viewport-pixel delta (e.g. edge-of-screen auto-scroll during a drag). */
  function panBy(dx, dy) {
    x += dx;
    y += dy;
    apply();
  }

  /** Current pan/zoom, for persisting where the user left off. */
  function getView() {
    return { x, y, scale };
  }

  /** Restores a pan/zoom previously returned by getView() (scale still gets clamped). */
  function setView(view) {
    if (!view) {
      return;
    }
    x = view.x ?? x;
    y = view.y ?? y;
    scale = clampScale(view.scale ?? scale);
    apply();
  }

  return {
    fit,
    centerOnPoint,
    clientToContent,
    panBy,
    getView,
    setView,
    zoomIn: () => {
      const r = viewportEl.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
    },
    zoomOut: () => {
      const r = viewportEl.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
    },
  };
}
