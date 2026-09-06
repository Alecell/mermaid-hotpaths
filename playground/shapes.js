/**
 * Classic mermaid flowchart node shapes — only the ones with inline bracket
 * syntax (`[text]`, `(text)`, ...), deliberately excluding the newer
 * `@{ shape: name }` catalog, which has no inline equivalent.
 */
export const SHAPES = [
  { key: 'rect', label: 'Rectangle', open: '[', close: ']' },
  { key: 'rounded', label: 'Rounded', open: '(', close: ')' },
  { key: 'stadium', label: 'Stadium', open: '([', close: '])' },
  { key: 'subroutine', label: 'Subroutine', open: '[[', close: ']]' },
  { key: 'cylinder', label: 'Cylinder', open: '[(', close: ')]' },
  { key: 'circle', label: 'Circle', open: '((', close: '))' },
  { key: 'double-circle', label: 'Double Circle', open: '(((', close: ')))' },
  { key: 'asymmetric', label: 'Asymmetric', open: '>', close: ']' },
  { key: 'diamond', label: 'Diamond', open: '{', close: '}' },
  { key: 'hexagon', label: 'Hexagon', open: '{{', close: '}}' },
  { key: 'parallelogram', label: 'Parallelogram', open: '[/', close: '/]' },
  { key: 'parallelogram-alt', label: 'Parallelogram Alt', open: '[\\', close: '\\]' },
  { key: 'trapezoid', label: 'Trapezoid', open: '[/', close: '\\]' },
  { key: 'trapezoid-alt', label: 'Trapezoid Alt', open: '[\\', close: '/]' },
];

/** Render a bare node declaration token, e.g. `n3["Rectangle"]` — no indent, no newline. */
export function shapeToken(shape, id, text) {
  return `${id}${shape.open}"${text.replace(/"/g, '#quot;')}"${shape.close}`;
}

/** Render a node declaration line, e.g. `n3["Rectangle"]`. */
export function shapeLine(shape, id, text) {
  return `  ${shapeToken(shape, id, text)}`;
}

const ID_PATTERN = /^[A-Za-z][\w-]*$/;

export function isValidId(id) {
  return ID_PATTERN.test(id);
}

/**
 * Best-effort scan for identifiers already used in the source: subgraph
 * names, node declarations (`id[`, `id(`, `id{`, `id@{`), bare ids
 * appearing on either side of an edge arrow, and an edge's own explicit id
 * (`id@` glued directly onto its arrow, e.g. `A e1@--> B`). Not a real
 * parser — good enough to steer clear of an accidental collision.
 */
export function extractExistingIds(source) {
  const ids = new Set();
  const patterns = [
    /subgraph\s+([A-Za-z][\w-]*)/g,
    /(?:^|[\s;])([A-Za-z][\w-]*)\s*(?:\[|\(|{|@{)/gm,
    /(?:^|[\s;])([A-Za-z][\w-]*)\s*(?:[A-Za-z][\w-]*@)?(?:-{1,3}>|={2,3}>|-{2,3}|\.{1,3}-)/gm,
    /(?:-{1,3}>|={2,3}>|-{2,3}|\.{1,3}-)\s*([A-Za-z][\w-]*)/g,
    /([A-Za-z][\w-]*)@(?=[<ox]?[=-])/g,
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

export function nextAutoId(existingIds, prefix) {
  let n = 1;
  while (existingIds.has(`${prefix}${n}`)) {
    n++;
  }
  return `${prefix}${n}`;
}

export function escapeRegExp(s) {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

// Longest delimiters first, so e.g. subroutine's `[[` `]]` is tried before
// rect's plain `[` `]` — otherwise a greedy/non-anchored scan for the shorter
// pair can match a prefix of the longer one and mis-detect the shape.
const SHAPES_BY_SPECIFICITY = [...SHAPES].sort(
  (a, b) => b.open.length + b.close.length - (a.open.length + a.close.length)
);

/**
 * Best-effort search for `id`'s own shape-declaration token anywhere in the
 * source (a standalone line like `n1["Rectangle"]`, or inline within an edge
 * line like `A[Start] --> B{Choice}`), returning its exact char span (for
 * splicing), extracted label text, and shape key. Returns null if `id` has no
 * bracketed declaration anywhere (e.g. it only ever appears as a bare id in
 * edges, using mermaid's default shape).
 */
export function findNodeDeclaration(source, id) {
  const escapedId = escapeRegExp(id);
  for (const shape of SHAPES_BY_SPECIFICITY) {
    const open = escapeRegExp(shape.open);
    const close = escapeRegExp(shape.close);
    const re = new RegExp(`(?<![\\w-])${escapedId}${open}([^\\n]*?)${close}`, 'd');
    const m = re.exec(source);
    if (m) {
      let label = m[1];
      if (label.startsWith('"') && label.endsWith('"')) {
        label = label.slice(1, -1);
      }
      label = label.replace(/#quot;/g, '"');
      const [start, end] = m.indices[0];
      const lineIndex = source.slice(0, start).split('\n').length - 1;
      return { start, end, label, lineIndex, shapeKey: shape.key };
    }
  }
  return null;
}

/**
 * Deletes `id`'s own standalone declaration line — its bracketed shape
 * (`n1["Rectangle"]`) or, lacking one, a line that's just the bare id by itself (a
 * node only ever referenced elsewhere via edges, e.g. `aa` alone inside a subgraph).
 * A declaration sharing its line with anything else (most commonly, the same edge
 * line a caller already dropped via `removeNodeEdges`) is left untouched — it's not
 * this node's own line to delete.
 */
export function removeNodeDeclarationLine(source, id) {
  const decl = findNodeDeclaration(source, id);
  if (decl) {
    // decl.start/end are offsets into the whole source, not into any one line, so find
    // this line's own bounds the same way rather than mixing the two coordinate spaces.
    const lineStart = source.lastIndexOf('\n', decl.start - 1) + 1;
    const nlAfter = source.indexOf('\n', decl.end);
    const lineEnd = nlAfter === -1 ? source.length : nlAfter;
    const before = source.slice(lineStart, decl.start).trim();
    const after = source.slice(decl.end, lineEnd).trim();
    if (!before && !after) {
      const removeTo = nlAfter === -1 ? lineEnd : nlAfter + 1;
      return source.slice(0, lineStart) + source.slice(removeTo);
    }
    return source;
  }
  const lines = source.split('\n');
  const bareRe = new RegExp(`^\\s*${escapeRegExp(id)}\\s*$`);
  const idx = lines.findIndex((line) => bareRe.test(line));
  if (idx !== -1) {
    lines.splice(idx, 1);
  }
  return lines.join('\n');
}

/**
 * Finds the source line (0-based index) that best represents `id` — its
 * shape declaration if it has one, otherwise the first line it's mentioned
 * on at all (e.g. a bare id inside an edge). Returns null if `id` doesn't
 * appear in the source.
 */
export function findLineForNodeId(source, id) {
  const decl = findNodeDeclaration(source, id);
  if (decl) {
    return decl.lineIndex;
  }
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`);
  const lines = source.split('\n');
  for (const [i, line] of lines.entries()) {
    if (re.test(line)) {
      return i;
    }
  }
  return null;
}

/** A small monochrome preview icon for a shape, 24x24 viewBox. */
export function shapeIconSvg(shape) {
  const common = 'fill="none" stroke="currentColor" stroke-width="1.6"';
  switch (shape.key) {
    case 'rect':
      return `<rect x="3" y="6" width="18" height="12" ${common}/>`;
    case 'rounded':
      return `<rect x="3" y="6" width="18" height="12" rx="6" ${common}/>`;
    case 'stadium':
      return `<rect x="2" y="7" width="20" height="10" rx="5" ${common}/>`;
    case 'subroutine':
      return `<rect x="3" y="6" width="18" height="12" ${common}/><line x1="6.5" y1="6" x2="6.5" y2="18" ${common}/><line x1="17.5" y1="6" x2="17.5" y2="18" ${common}/>`;
    case 'cylinder':
      return `<path d="M3 7.5 C3 6 20 6 21 7.5 V16.5 C20 18 3 18 3 16.5 Z" ${common}/><path d="M3 7.5 C4 9 20 9 21 7.5" ${common}/>`;
    case 'circle':
      return `<circle cx="12" cy="12" r="8" ${common}/>`;
    case 'double-circle':
      return `<circle cx="12" cy="12" r="8" ${common}/><circle cx="12" cy="12" r="5.3" ${common}/>`;
    case 'asymmetric':
      return `<path d="M3 6 H18 L21 12 L18 18 H3 Z" ${common}/>`;
    case 'diamond':
      return `<path d="M12 3 L21 12 L12 21 L3 12 Z" ${common}/>`;
    case 'hexagon':
      return `<path d="M7 4 H17 L21 12 L17 20 H7 L3 12 Z" ${common}/>`;
    case 'parallelogram':
      return `<path d="M7 6 H21 L17 18 H3 Z" ${common}/>`;
    case 'parallelogram-alt':
      return `<path d="M3 6 H17 L21 18 H7 Z" ${common}/>`;
    case 'trapezoid':
      return `<path d="M7 6 H17 L21 18 H3 Z" ${common}/>`;
    case 'trapezoid-alt':
      return `<path d="M3 6 H21 L17 18 H7 Z" ${common}/>`;
    default:
      return `<rect x="3" y="6" width="18" height="12" ${common}/>`;
  }
}
