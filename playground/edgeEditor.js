/**
 * Best-effort mapping from rendered flowchart edges back to the exact text
 * span in the source that declared them, so a dragged endpoint can rewrite
 * just that one token.
 *
 * Mermaid gives every auto-named edge a deterministic id, `L_{start}_{end}_{n}`
 * (see packages/mermaid/src/utils.ts `getEdgeId`). `n` is NOT a global edge
 * index — it's per (start, end) pair: the first `A-->B` gets `L_A_B_0`; if
 * another `A-->B` shows up later, it gets `L_A_B_2` (flowDb.ts `addLink`
 * counts prior links with the same pair and adds 1 — so repeats go 0, 2, 3,
 * 4, ... skipping 1). We don't have access to that parser from outside
 * `mermaid.render()`, so we re-derive the same counters with a line-scanner:
 * walk the source top to bottom, split each edge-bearing line on its arrows,
 * and bump a per-pair counter for each consecutive (id, id) pair found.
 *
 * Lines that are *exactly* one `id[shape]? ARROW id[shape]?` get their
 * start/end/arrow captured with character offsets, for splicing (`simple:
 * true`). Multi-arrow chains (`A-->B-->C`) get the very same per-segment
 * spans captured too — a chain node's id is literally one piece of text
 * shared by the segment before and after it (`B` in `A-->B-->C` is both the
 * first segment's end and the second's start), so dragging *or* retyping
 * either segment just edits that one span in place, same as a standalone
 * line. Anything we fail to parse cleanly is left with no spans at all —
 * selectable, but not safe to drag or retype.
 *
 * Every candidate id is verified against the real rendered ids before use —
 * a mismatch (a line we tokenized wrong, etc.) just leaves that edge
 * selectable-but-not-draggable rather than risking a wrong text edit.
 *
 * Mermaid also lets an edge carry its own explicit id (`A e1@--> B`, see
 * "Attaching an ID to Edges" in flowchart.md) — unlike the auto ids above,
 * this one *is* what the edge's own DOM id becomes (verified empirically:
 * `id="{svgId}-e1"`, not `L_...`), and it survives edits that would shift an
 * auto id's counter. We don't generate these ourselves except when a note
 * gets attached to an edge (see notes.js) — an edge otherwise has no stable
 * identity to hang a note off of. Self-loops are the one exception: mermaid
 * keeps rendering those under the usual `-cyclic-special-` scheme even with
 * an explicit id (verified empirically too), so `entry.edgeId` there is only
 * ever useful as the note's own storage key, never for DOM lookup.
 *
 * A label can be written two ways in real mermaid source: `A -->|text| B` (a bare
 * arrow, label in pipes after it) or `A -- text --> B` / `A -. text .-> B` /
 * `A == text ==> B` (the label sits *between* an opening and a closing delimiter of
 * the same style — mermaid's own lexer, flow.jison, treats this as a distinct
 * "open, freeform text, close" token, not an arrow followed by a label). Both are
 * captured under one `arrowSpan` per entry (the whole thing between the ids, edge id
 * excluded) with `label`/`styleToken` already pulled out — see `parseArrowText`.
 * Never split on a bare ARROW alone: for `A -- text --> B`, "--" on its own is a
 * complete (label-less) ARROW match, and "text" is itself a valid id-shaped token, so
 * a naive scan misreads the label as a fake middle node of a 3-node chain.
 */

const ID = String.raw`[A-Za-z][\w-]*`;
const SHAPE = String.raw`(?:\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|>[^\]\n]*\]|@\{[^}\n]*\})?`;
// Line style (solid `-`, dotted `-.-`, thick `=`) crossed with an optional arrowhead
// (`>`/`<` normal, `o` circle, `x` cross, or none) at either end — e.g. `-->`, `--o`,
// `-.-x`, `===`, `==>`, `<-->`, `o--o`. The leading/trailing head chars aren't required
// to match each other here (a real bidirectional edge always pairs them, e.g. `<-->` or
// `o--o`, never `<--o`) — this is a recognizer for already-valid mermaid source, not a
// validator, so the extra permissiveness is harmless.
const ARROW = String.raw`(?:[<ox]?-{2,3}[>ox]?|[<ox]?-\.{1,3}-[>ox]?|[<ox]?={2,3}[>ox]?)`;
// An edge's own explicit id: `id@` glued directly onto the front of the arrow, no space
// (e.g. `e1@-->`) — optional, so this never changes behavior for the vast majority of
// edges that don't have one.
const EDGE_ID = String.raw`(?:(${ID})@)?`;
const EDGE_LABEL = String.raw`(?:\|[^|\n]*\|)?`;
// "Text between delimiters" labels. Each open token is followed by non-greedy text and
// a same-family close token shaped just like a bare, label-less ARROW (so `-->`, `--x`,
// `--o`, `---`, `.->`, `..->`, `==>`, `===`, ... are all valid closers) — the negative
// lookahead right after the open excludes the label-less form (e.g. `---`, `-.->`), which
// has no gap for text and must fall through to the bare-ARROW branch below instead.
// Leading head chars (before the open delimiter, e.g. the `<` in `<-- text --> `) and
// trailing ones (closing an arrowhead, e.g. the `>` in `--> `) are different sets — `<`
// only ever leads, `>` only ever trails — same split the plain ARROW pattern above uses.
const LEAD_CHAR = String.raw`[<ox]`;
const TAIL_CHAR = String.raw`[>ox]`;
const DASH_TEXT = String.raw`--(?!-)[^\n]*?-{2,3}${TAIL_CHAR}?`;
const DOT_TEXT = String.raw`-\.(?!-)[^\n]*?-?\.+-${TAIL_CHAR}?`;
const THICK_TEXT = String.raw`==(?!=)[^\n]*?={2,3}${TAIL_CHAR}?`;
const TEXT_LABEL = String.raw`${LEAD_CHAR}?(?:${DASH_TEXT}|${DOT_TEXT}|${THICK_TEXT})`;
// The whole span between two ids (edge id excluded): a text-between-delimiters label if
// there is one, else a bare arrow with an optional `|text|` label. Order matters — see the
// file header comment on why the text-label form must be tried first.
const ARROW_OR_LABEL = String.raw`(?:${TEXT_LABEL}|${ARROW}${EDGE_LABEL})`;
// A cheap "does this line contain an edge at all" pre-check. Must recognize a
// text-between-delimiters label even when it's the line's *only* delimiter-shaped
// substring (e.g. `A -. read .-> B` has no bare 2-3-dash/`=` run anywhere else in the
// line) — testing against the bare ARROW alone would silently skip such a line.
const ARROW_TOKEN_RE = new RegExp(ARROW_OR_LABEL, 'g');
const SPLIT_RE = new RegExp(ARROW_OR_LABEL, 'g');
// Same as SPLIT_RE but with the edge id and the whole arrow-or-label span each in their
// own capture group, plus `d` (indices), so a single scan yields each one's own span and
// where the next segment (id) begins.
const SPLIT_RE_D = new RegExp(`${EDGE_ID}(${ARROW_OR_LABEL})`, 'gd');
const LEADING_ID_RE = new RegExp(`^\\s*(${ID})`);
const LEADING_ID_RE_D = new RegExp(`^\\s*(${ID})`, 'd');
// Groups: 1 start id, 2 start shape, 3 edge id, 4 arrow-or-label span, 5 end id, 6 end shape.
const SIMPLE_LINE_RE = new RegExp(
  `^\\s*(${ID})(${SHAPE})?\\s*${EDGE_ID}(${ARROW_OR_LABEL})\\s*(${ID})(${SHAPE})?\\s*$`,
  'd'
);

/**
 * Classifies one already-matched `ARROW_OR_LABEL` span and pulls out its label text
 * (decoded, no delimiters) and style token (just the arrow-shaped part, e.g. `-->`,
 * `.->`, `==>`, `<-->` — safe to feed to a style/head parser). Every write helper below
 * (`rewriteEdgeArrow`, `rewriteEdgeLabel`) rebuilds the *whole* span from these two
 * pieces rather than splicing text in place, since a text-between-delimiters label has
 * no independent "just the label" or "just the arrow" substring to splice — changing
 * either one always normalizes the edge to `styleToken|label|` form. That mirrors what
 * this app already did for `|text|`-style edges, so it's not a new normalization, just
 * a consistent one.
 */
function parseArrowText(text) {
  const dash = /^([<ox]?)--(?!-)([^\n]*?)(-{2,3}[>ox]?)$/.exec(text);
  if (dash) {
    return { label: dash[2].trim(), styleToken: dash[1] + dash[3] };
  }
  const dot = /^([<ox]?)-\.(?!-)([^\n]*?)(-?\.+-[>ox]?)$/.exec(text);
  if (dot) {
    return { label: dot[2].trim(), styleToken: dot[1] + dot[3] };
  }
  const thick = /^([<ox]?)==(?!=)([^\n]*?)(={2,3}[>ox]?)$/.exec(text);
  if (thick) {
    return { label: thick[2].trim(), styleToken: thick[1] + thick[3] };
  }
  // Bare arrow, optionally followed by a `|text|` label.
  const pipe = /\|([^\n|]*)\|\s*$/.exec(text);
  return {
    label: pipe ? pipe[1].trim() : '',
    styleToken: (pipe ? text.slice(0, pipe.index) : text).trim(),
  };
}

/** Splits an edge-bearing line into its chain of node ids, e.g. "A-->B-->C" -> ['A','B','C']. */
function extractChainIds(line) {
  const segments = line.split(SPLIT_RE);
  const ids = segments.map((seg) => LEADING_ID_RE.exec(seg)?.[1]);
  return ids.every(Boolean) && ids.length >= 2 ? ids : null;
}

/**
 * Finds every node id's own char span in a chain line (one more than the number of
 * arrows — `A-->B-->C` has 3) plus every arrow-or-label span (the whole delimiter
 * between two ids, edge id excluded — see `parseArrowText`), by walking the boundaries
 * between them. Returns null if any segment's leading id can't be pinned down (e.g. a
 * shape we don't recognize butts right up against the arrow with no whitespace) rather
 * than risk a wrong text edit.
 */
function matchChainSegments(line) {
  const edgeIdSpans = [];
  const edgeIds = [];
  const arrowSpans = [];
  const labels = [];
  const styleTokens = [];
  const segmentStarts = [0];
  SPLIT_RE_D.lastIndex = 0;
  let m;
  while ((m = SPLIT_RE_D.exec(line))) {
    edgeIdSpans.push(m.indices[1]);
    edgeIds.push(m[1]);
    const arrowSpan = m.indices[2];
    arrowSpans.push(arrowSpan);
    const parsed = parseArrowText(line.slice(arrowSpan[0], arrowSpan[1]));
    labels.push(parsed.label);
    styleTokens.push(parsed.styleToken);
    segmentStarts.push(m.indices[0][1]);
  }

  const idSpans = [];
  for (const [i, segStart] of segmentStarts.entries()) {
    const segEnd = arrowSpans[i]?.[0] ?? line.length;
    LEADING_ID_RE_D.lastIndex = 0;
    const idMatch = LEADING_ID_RE_D.exec(line.slice(segStart, segEnd));
    if (!idMatch) {
      return null;
    }
    idSpans.push([segStart + idMatch.indices[1][0], segStart + idMatch.indices[1][1]]);
  }
  return { idSpans, arrowSpans, labels, styleTokens, edgeIds, edgeIdSpans };
}

function nextPairCounter(pairCounts, start, end) {
  const key = `${start} ${end}`;
  const priorCount = pairCounts.get(key) ?? 0;
  const counter = priorCount === 0 ? 0 : priorCount + 1;
  pairCounts.set(key, priorCount + 1);
  return counter;
}

/**
 * Parses every edge-bearing line of a flowchart source, in mermaid's own
 * declaration order. Returns one entry per (start, end) pair encountered.
 */
export function parseEdgeLines(source) {
  const lines = source.split('\n');
  const entries = [];
  const pairCounts = new Map();

  for (const [lineIndex, line] of lines.entries()) {
    if (!ARROW_TOKEN_RE.test(line)) {
      continue;
    }
    ARROW_TOKEN_RE.lastIndex = 0;

    const ids = extractChainIds(line);
    if (!ids) {
      continue;
    }

    if (ids.length === 2) {
      const match = SIMPLE_LINE_RE.exec(line);
      if (match) {
        const [start, end] = ids;
        const startSpan = match.indices[2]
          ? [match.indices[1][0], match.indices[2][1]]
          : match.indices[1];
        const endSpan = match.indices[6]
          ? [match.indices[5][0], match.indices[6][1]]
          : match.indices[5];
        const edgeId = match[3];
        const edgeIdSpan = match.indices[3];
        const arrowSpan = match.indices[4];
        const parsed = parseArrowText(line.slice(arrowSpan[0], arrowSpan[1]));
        const counter = nextPairCounter(pairCounts, start, end);
        entries.push({
          counter,
          lineIndex,
          simple: true,
          start,
          end,
          startSpan,
          endSpan,
          edgeId,
          edgeIdSpan,
          arrowSpan,
          label: parsed.label,
          styleToken: parsed.styleToken,
        });
        continue;
      }
    }

    // Chain lines (A-->B-->C) and anything SIMPLE_LINE_RE couldn't parse cleanly still need
    // their pair counters bumped (so later lines' ids/counters line up). When the segment
    // spans resolve cleanly, each segment gets the same startSpan/endSpan/arrowSpan a
    // standalone line would — dragging or retyping just edits that one shared id/arrow token.
    const segments = matchChainSegments(line);
    for (let i = 0; i < ids.length - 1; i++) {
      const start = ids[i];
      const end = ids[i + 1];
      const counter = nextPairCounter(pairCounts, start, end);
      entries.push({
        lineIndex,
        simple: false,
        start,
        end,
        counter,
        edgeId: segments?.edgeIds[i],
        edgeIdSpan: segments?.edgeIdSpans[i],
        arrowSpan: segments?.arrowSpans[i],
        label: segments?.labels[i],
        styleToken: segments?.styleTokens[i],
        startSpan: segments?.idSpans[i],
        endSpan: segments?.idSpans[i + 1],
      });
    }
  }

  return entries;
}

/**
 * Maps each real rendered edge DOM id to its parsed source entry. Every entry
 * carries `lineIndex` (for "view in code"); most also carry `arrowSpan`/
 * `startSpan`/`endSpan`/`labelSpan` (safe to retype the arrow, drag an
 * endpoint, or set the label) — `simple: true` just means the whole line was
 * one plain `id ARROW id`, as opposed to a segment of a longer chain.
 *
 * Self-loops (`D --> D`) are a special case: mermaid renders them as several
 * path segments (`{svgId}-{id}-cyclic-special-1/mid/2/...`) instead of the
 * usual single `L_start_end_n` path, so every segment sharing that node's
 * prefix is indexed under the same entry — selecting/retyping works no
 * matter which segment of the loop was actually clicked.
 */
export function buildEdgeIndex(source, svg) {
  const svgId = svg.id;
  const index = new Map();
  for (const entry of parseEdgeLines(source)) {
    if (entry.start === entry.end) {
      const prefix = `${svgId}-${entry.start}-cyclic-special-`;
      for (const el of svg.querySelectorAll('path.flowchart-link')) {
        if (el.id.startsWith(prefix)) {
          index.set(el.id, entry);
        }
      }
      continue;
    }
    const domId = entry.edgeId
      ? `${svgId}-${entry.edgeId}`
      : `${svgId}-L_${entry.start}_${entry.end}_${entry.counter}`;
    if (svg.getElementById(domId)) {
      index.set(domId, entry);
    }
  }
  return index;
}

/**
 * Returns new source text with the given edge's start or end token replaced
 * by a bare node id (no shape suffix — the target node keeps whatever shape
 * it's already declared with elsewhere).
 */
export function rewriteEdgeEndpoint(source, entry, which, newId) {
  const lines = source.split('\n');
  const line = lines[entry.lineIndex];
  const [from, to] = which === 'start' ? entry.startSpan : entry.endSpan;
  lines[entry.lineIndex] = line.slice(0, from) + newId + line.slice(to);
  return lines.join('\n');
}

/**
 * Returns new source text with the given edge's arrow token (e.g. `-->`) swapped for
 * `newArrowToken` (e.g. `-.->`), preserving its label (if any). Valid for any entry
 * that has an `arrowSpan` (simple lines and chain segments alike). The edge's DOM id
 * is unaffected — it's derived from start/end ids only. `arrowSpan` covers the whole
 * delimiter, label included when it was written `-- text -->`-style — replacing it
 * wholesale (rather than just its close token) is what normalizes such an edge to
 * `newArrowToken|label|` form instead of silently dropping the label.
 */
export function rewriteEdgeArrow(source, entry, newArrowToken) {
  const lines = source.split('\n');
  const line = lines[entry.lineIndex];
  const [from, to] = entry.arrowSpan;
  const suffix = entry.label ? `|${entry.label}|` : '';
  lines[entry.lineIndex] = line.slice(0, from) + newArrowToken + suffix + line.slice(to);
  return lines.join('\n');
}

/**
 * Returns new source text with the given edge's label set to `newLabel` (or removed,
 * if blank), preserving its arrow style/head. Valid for any entry that has an
 * `arrowSpan` (a text-between-delimiters label has no separate "just the label"
 * substring to splice, so this rebuilds the whole span using `entry.styleToken`).
 */
export function rewriteEdgeLabel(source, entry, newLabel) {
  const lines = source.split('\n');
  const line = lines[entry.lineIndex];
  const [from, to] = entry.arrowSpan;
  const clean = newLabel.replace(/\|/g, '').trim();
  const token = entry.styleToken ?? '-->';
  lines[entry.lineIndex] =
    line.slice(0, from) + token + (clean ? `|${clean}|` : '') + line.slice(to);
  return lines.join('\n');
}

/**
 * Gives an edge that doesn't have one yet its own explicit id (`edgeId@` glued onto the
 * front of its arrow token) — the only way to give an edge a stable identity to hang a
 * note off of. No-op if `entry` already has an `edgeId`, or has no `arrowSpan` to anchor
 * on.
 */
export function assignEdgeId(source, entry, edgeId) {
  if (entry.edgeId || !entry.arrowSpan) {
    return source;
  }
  const lines = source.split('\n');
  const line = lines[entry.lineIndex];
  const at = entry.arrowSpan[0];
  lines[entry.lineIndex] = line.slice(0, at) + `${edgeId}@` + line.slice(at);
  return lines.join('\n');
}

/** Strips an edge's explicit id (the counterpart to `assignEdgeId`) once it's no longer needed. */
export function clearEdgeId(source, entry) {
  if (!entry.edgeIdSpan) {
    return source;
  }
  const lines = source.split('\n');
  const line = lines[entry.lineIndex];
  const [from] = entry.edgeIdSpan;
  const to = entry.arrowSpan[0]; // spans the id *and* the `@` right after it
  lines[entry.lineIndex] = line.slice(0, from) + line.slice(to);
  return lines.join('\n');
}

/**
 * Deletes exactly one edge — the specific segment `entry` describes, not every edge
 * touching its start/end ids (that's `removeNodeEdges`, for deleting a whole node) and
 * never either endpoint's own declaration. A `simple` entry's start/end spans already
 * include any inline shape (`A[Start] --> B[End]`'s `startSpan` is `A[Start]`, not just
 * `A`), so removing just the arrow between them turns the line into two standalone
 * declaration lines rather than deleting the nodes along with the edge — same as
 * disconnecting a link by hand without touching what it was connecting. A chain segment
 * (`A-->B-->C`) only loses its own arrow+id the same way — surviving ids on either side
 * become their own line(s). No-op (returns `source` unchanged) if `entry` has no safe
 * span to work from.
 */
export function removeEdgeSegment(source, entry) {
  if (!entry.startSpan || !entry.endSpan) {
    return source;
  }
  const lines = source.split('\n');
  if (entry.simple) {
    const line = lines[entry.lineIndex];
    if (entry.start === entry.end) {
      // Self-loop: one node, so one surviving declaration — keep whichever span
      // carries more (e.g. an inline shape declared on only one side of it).
      const keep =
        entry.endSpan[1] - entry.endSpan[0] > entry.startSpan[1] - entry.startSpan[0]
          ? entry.endSpan
          : entry.startSpan;
      lines[entry.lineIndex] = line.slice(keep[0], keep[1]);
    } else {
      lines.splice(
        entry.lineIndex,
        1,
        line.slice(0, entry.startSpan[1]),
        line.slice(entry.endSpan[0])
      );
    }
    return lines.join('\n');
  }
  const line = lines[entry.lineIndex];
  const segments = matchChainSegments(line);
  const i = segments?.idSpans.findIndex(
    ([s, e]) => s === entry.startSpan[0] && e === entry.startSpan[1]
  );
  if (i == null || i === -1) {
    return source;
  }
  const n = segments.idSpans.length;
  const hasLeft = i > 0;
  const hasRight = i < n - 2;
  const replacement = [];
  if (hasLeft) {
    replacement.push(line.slice(0, segments.idSpans[i][1]));
  }
  if (hasRight) {
    replacement.push(line.slice(segments.idSpans[i + 1][0]));
  }
  lines.splice(entry.lineIndex, 1, ...replacement);
  return lines.join('\n');
}

/**
 * Deletes every edge (or chain segment) that touches `nodeId`, on any line, leaving
 * whatever else was on those lines intact — used both for "delete this node" and, by
 * the caller, as a cascade step when deleting a subgraph deletes its member nodes too.
 * Does not touch `nodeId`'s own declaration line (see `removeNodeDeclarationLine` in
 * shapes.js for that).
 *
 * Reconstructs each affected line from its surviving ids: two ids that were already
 * adjacent in the original chain keep the exact arrow/label text between them; two
 * that end up adjacent only because the id(s) between them got deleted are NOT
 * rejoined — that connection never existed — so they become separate lines instead.
 */
export function removeNodeEdges(source, nodeId) {
  const lines = source.split('\n');
  const result = [];
  for (const line of lines) {
    const hasArrow = ARROW_TOKEN_RE.test(line);
    ARROW_TOKEN_RE.lastIndex = 0;
    if (!hasArrow) {
      result.push(line);
      continue;
    }
    const ids = extractChainIds(line);
    const segments = ids ? matchChainSegments(line) : null;
    if (!ids || !segments) {
      // Can't safely reconstruct this line — leave it untouched rather than risk
      // mangling text we don't fully understand (same policy as the rest of this file).
      result.push(line);
      continue;
    }
    const idTexts = segments.idSpans.map(([s, e]) => line.slice(s, e));
    if (!idTexts.includes(nodeId)) {
      result.push(line);
      continue;
    }
    const n = idTexts.length;
    let runStart = null;
    for (let k = 0; k <= n; k++) {
      const survives = k < n && idTexts[k] !== nodeId;
      if (survives && runStart === null) {
        runStart = k;
      }
      if ((!survives || k === n) && runStart !== null) {
        const runEnd = k - 1;
        const start = runStart === 0 ? 0 : segments.idSpans[runStart][0];
        const end = runEnd === n - 1 ? line.length : segments.idSpans[runEnd][1];
        result.push(line.slice(start, end));
        runStart = null;
      }
    }
  }
  return result.join('\n');
}
