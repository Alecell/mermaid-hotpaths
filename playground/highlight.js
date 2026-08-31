/**
 * Minimal regex-based syntax highlighter for mermaid source. Produces highlighted
 * HTML for the inert <pre> backdrop painted behind the plain-text source textarea
 * (see editor.html) — the textarea itself stays fully functional and just renders
 * its own text transparently on top, so typing/selection/undo are all untouched.
 */
const KEYWORDS = [
  'flowchart',
  'graph',
  'subgraph',
  'end',
  'direction',
  'classDef',
  'class',
  'style',
  'linkStyle',
  'click',
  'TD',
  'TB',
  'BT',
  'RL',
  'LR',
];

const ARROW_CORE = String.raw`[ox<]?(?:-{2,3}|-\.{1,2}-|={2,3})[ox>]?`;
const ARROW_RE = new RegExp(`^${ARROW_CORE}$`);

const TOKEN_RE = new RegExp(
  [
    String.raw`%%[^\n]*`,
    String.raw`"[^"\n]*"|'[^'\n]*'`,
    String.raw`\|[^|\n]*\|`,
    ARROW_CORE,
    `\\b(?:${KEYWORDS.join('|')})\\b`,
  ].join('|'),
  'g'
);

function classify(token) {
  if (token.startsWith('%%')) {
    return 'tok-comment';
  }
  if (token.startsWith('"') || token.startsWith("'")) {
    return 'tok-string';
  }
  if (token.startsWith('|')) {
    return 'tok-label';
  }
  if (ARROW_RE.test(token)) {
    return 'tok-arrow';
  }
  return 'tok-keyword';
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ESCAPE_MAP[c]);
}

/** Returns `code` as HTML with recognized mermaid syntax wrapped in classed <span>s. */
export function highlightMermaid(code) {
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(code))) {
    out += escapeHtml(code.slice(last, match.index));
    out += `<span class="${classify(match[0])}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}
