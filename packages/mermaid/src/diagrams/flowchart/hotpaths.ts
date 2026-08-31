/**
 * Hotpaths — hover/click highlighting of trigger paths in flowcharts.
 *
 * A node can DECLARE one or more named triggers (each with a color). Other nodes
 * can LISTEN to those triggers. Hovering a declaring (source) node lights up every
 * member of its trigger(s) — nodes and the edges that connect two members — with a
 * colored drop-shadow glow. Clicking a source pins the highlight so it can be
 * navigated; clicking empty space or pressing Esc clears the pins.
 *
 * All behaviour is attached here, from `flowDb.bindFunctions`, so it survives the
 * `mermaid.render()` serialize-to-string lifecycle and needs no user CSS. It is
 * purely additive: with no hotpath metadata in the diagram, this is a no-op.
 */
import { log } from '../../logger.js';
import { getEdgeId } from '../../utils.js';
import type { FlowDB } from './flowDb.js';
import type { FlowVertexHotpath } from './types.js';

export interface HotpathNodeInfo {
  /** Unprefixed domId of the node's `<g>` (the diagramId prefix is added at bind time). */
  domId: string;
  /** Triggers the node owns — makes it a hoverable/clickable source. */
  declares: string[];
  /** declares ∪ listens — every trigger this node belongs to. */
  member: string[];
}

export interface HotpathData {
  /** Declared trigger name -\> color (undefined when no color was given). */
  triggers: Map<string, string | undefined>;
  /** Vertex id -\> membership info. */
  nodes: Map<string, HotpathNodeInfo>;
}

// Global on/off switch, independent of any diagram's own trigger/listen metadata —
// lets a host app (e.g. the playground editor) kill hover/click interactivity
// entirely without needing to strip metadata from the diagram source itself.
let hotpathsEnabled = true;

/** Enables or disables hotpath hover/click interactivity for all future renders. */
export function setHotpathsEnabled(enabled: boolean): void {
  hotpathsEnabled = enabled;
}

/** Colors used when a trigger is declared without an explicit color. */
const FALLBACK_COLORS = [
  '#e53935',
  '#1e88e5',
  '#43a047',
  '#fb8c00',
  '#8e24aa',
  '#00897b',
  '#d81b60',
];

const asTrimmedString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

/**
 * Extract hotpath keys (`trigger` / `triggers` / `color` / `listen`) from a parsed
 * `@{ ... }` metadata document. Returns undefined when the node has no hotpath data.
 */
export function parseHotpathMetadata(doc: any): FlowVertexHotpath | undefined {
  if (!doc || typeof doc !== 'object') {
    return undefined;
  }

  const declares: { name: string; color?: string }[] = [];
  const listens: string[] = [];

  const sharedColor = asTrimmedString(doc.color);

  const singleTrigger = asTrimmedString(doc.trigger);
  if (singleTrigger) {
    declares.push({ name: singleTrigger, color: sharedColor });
  }

  if (Array.isArray(doc.triggers)) {
    for (const t of doc.triggers) {
      if (typeof t === 'string') {
        // String form "name" or "name:color" — avoids nested braces, which the
        // flowchart `@{ ... }` lexer cannot handle.
        const raw = asTrimmedString(t);
        if (!raw) {
          continue;
        }
        const sep = raw.indexOf(':');
        if (sep >= 0) {
          const name = raw.slice(0, sep).trim();
          const color = raw.slice(sep + 1).trim();
          if (name) {
            declares.push({ name, color: color || sharedColor });
          }
        } else {
          declares.push({ name: raw, color: sharedColor });
        }
      } else if (t && typeof t === 'object') {
        // Object form — usable via the JS API where there is no lexer.
        const name = asTrimmedString(t.name);
        if (name) {
          declares.push({ name, color: asTrimmedString(t.color) ?? sharedColor });
        }
      }
    }
  }

  if (typeof doc.listen === 'string') {
    const name = asTrimmedString(doc.listen);
    if (name) {
      listens.push(name);
    }
  } else if (Array.isArray(doc.listen)) {
    for (const l of doc.listen) {
      const name = asTrimmedString(l);
      if (name) {
        listens.push(name);
      }
    }
  }

  if (declares.length === 0 && listens.length === 0) {
    return undefined;
  }
  return { declares, listens };
}

/** Escape a value for use inside an `[id="..."]` attribute selector. */
const attrEscape = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Escape an id for use as a `#id` CSS selector. */
const idEscape = (v: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(v);
  }
  return v.replace(/[^\w-]/g, (c) => `\\${c}`);
};

function injectStyle(svgEl: SVGSVGElement, diagramId: string): void {
  if (svgEl.querySelector('style[data-hp-style]')) {
    return;
  }
  const sel = diagramId ? `#${idEscape(diagramId)}` : 'svg';
  const css = `
${sel} g.node, ${sel} .edgePaths path, ${sel} path[data-id] { transition: filter .15s ease, opacity .15s ease; }
${sel} .hp-source { cursor: pointer; }
${sel}.hp-active g.node:not(.hp-lit) { opacity: .25; }
${sel}.hp-active .edgePaths path:not(.hp-lit), ${sel}.hp-active path[data-id]:not(.hp-lit) { opacity: .12; }
${sel}.hp-active g.edgeLabel:not(.hp-lit) { opacity: .3; }
`;
  const doc = svgEl.ownerDocument;
  if (!doc) {
    return;
  }
  const style = doc.createElement('style');
  style.setAttribute('data-hp-style', 'true');
  style.textContent = css;
  svgEl.insertBefore(style, svgEl.firstChild);
}

/**
 * Attach hotpath highlighting to a rendered flowchart. Called via bindFunctions with
 * the container the SVG was inserted into (or the SVG itself).
 */
export function applyHotpaths(element: Element, db: FlowDB): void {
  if (!hotpathsEnabled) {
    return;
  }
  let data: HotpathData;
  try {
    data = db.getHotpaths();
  } catch (e) {
    log.warn('Hotpaths: failed to read data', e);
    return;
  }
  if (!data || data.nodes.size === 0) {
    return;
  }

  const svgEl = (
    element.tagName?.toLowerCase() === 'svg' ? element : element.querySelector('svg')
  ) as SVGSVGElement | null;
  if (!svgEl) {
    return;
  }
  // Guard against double-binding (bindFunctions may run more than once).
  if (svgEl.dataset.hpInit === 'true') {
    return;
  }
  svgEl.dataset.hpInit = 'true';

  const diagramId = svgEl.id;

  // Resolve a concrete color for every declared trigger.
  const triggerColor = new Map<string, string>();
  let ci = 0;
  for (const [name, color] of data.triggers) {
    triggerColor.set(
      name,
      color && color.length > 0 ? color : FALLBACK_COLORS[ci++ % FALLBACK_COLORS.length]
    );
  }

  // element -> the (activatable) trigger names it belongs to.
  const elementTriggers = new Map<Element, string[]>();
  // source nodes -> the triggers hovering/clicking them activates.
  const sources: { el: Element; triggers: string[] }[] = [];

  const findById = (id: string): Element | null => svgEl.querySelector(`[id="${attrEscape(id)}"]`);

  // Nodes
  for (const [, info] of data.nodes) {
    const el = findById(diagramId ? `${diagramId}-${info.domId}` : info.domId);
    if (!el) {
      continue;
    }
    const member = info.member.filter((t) => triggerColor.has(t));
    if (member.length > 0) {
      elementTriggers.set(el, member);
    }
    const declares = info.declares.filter((t) => triggerColor.has(t));
    if (declares.length > 0) {
      sources.push({ el, triggers: declares });
    }
  }

  // Edges: auto-infer membership — an edge belongs to trigger T when both its
  // endpoints are members of T. The rendered path's data-id matches getEdgeId().
  const edges = db.getEdges();
  edges.forEach((e, index) => {
    const startInfo = data.nodes.get(e.start);
    const endInfo = data.nodes.get(e.end);
    if (!startInfo || !endInfo) {
      return;
    }
    const shared = startInfo.member.filter(
      (t) => endInfo.member.includes(t) && triggerColor.has(t)
    );
    if (shared.length === 0) {
      return;
    }
    const edgeId = getEdgeId(e.start, e.end, { counter: index, prefix: 'L' }, e.id);
    const path =
      svgEl.querySelector(`path[data-id="${attrEscape(edgeId)}"]`) ??
      findById(diagramId ? `${diagramId}-${edgeId}` : edgeId);
    if (path) {
      elementTriggers.set(path, shared);
    }
  });

  if (sources.length === 0) {
    return;
  }

  injectStyle(svgEl, diagramId);

  // --- interaction state ---
  const pinned = new Set<string>();
  let hovered: string[] = [];

  const paint = (): void => {
    const active = new Set<string>([...pinned, ...hovered]);
    svgEl.classList.toggle('hp-active', active.size > 0);
    for (const [el, trigs] of elementTriggers) {
      const colors = trigs.filter((t) => active.has(t)).map((t) => triggerColor.get(t)!);
      const styled = el as unknown as { style: CSSStyleDeclaration };
      if (colors.length > 0) {
        // Stacking drop-shadows = automatic dual glow where triggers converge.
        styled.style.filter = colors
          .map((c) => `drop-shadow(0 0 6px ${c}) drop-shadow(0 0 3px ${c})`)
          .join(' ');
        el.classList.add('hp-lit');
      } else {
        styled.style.filter = '';
        el.classList.remove('hp-lit');
      }
    }
  };

  for (const src of sources) {
    src.el.classList.add('hp-source');
    src.el.addEventListener('mouseenter', () => {
      hovered = src.triggers;
      paint();
    });
    src.el.addEventListener('mouseleave', () => {
      hovered = [];
      paint();
    });
    src.el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const allOn = src.triggers.every((t) => pinned.has(t));
      for (const t of src.triggers) {
        if (allOn) {
          pinned.delete(t);
        } else {
          pinned.add(t);
        }
      }
      paint();
    });
  }

  // Click on empty canvas clears pins.
  svgEl.addEventListener('click', () => {
    if (pinned.size > 0) {
      pinned.clear();
      paint();
    }
  });

  // Esc clears pins.
  svgEl.ownerDocument?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinned.size > 0) {
      pinned.clear();
      paint();
    }
  });
}
