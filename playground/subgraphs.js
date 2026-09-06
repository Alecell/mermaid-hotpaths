/**
 * Source-text surgery for `subgraph ... end` blocks: finding one, finding which one an
 * element belongs to, writing new declarations inside it, deleting one, and promoting a
 * plain node into one.
 *
 * Same policy as the rest of this playground's editing helpers: best-effort line scanning,
 * not a real parser — anything that can't be pinned down confidently is left alone rather
 * than rewritten wrong.
 */

import { escapeRegExp, extractExistingIds, findNodeDeclaration, shapeToken, SHAPES } from './shapes.js';
import { removeNodeEdges } from './edgeEditor.js';
import { appendToDiagram, stripNotes } from './notes.js';

const HEADER_RE = /^\s*subgraph\s+([A-Za-z][\w-]*)/;
const END_RE = /^\s*end\s*$/;

/** Finds `subgraph <id>`'s header line and its matching (nesting-aware) `end` line. */
export function findSubgraphBlock(lines, subgraphId) {
  const headerRe = new RegExp(`^\\s*subgraph\\s+${escapeRegExp(subgraphId)}(\\s|\\[|$)`);
  const headerIdx = lines.findIndex((l) => headerRe.test(l));
  if (headerIdx === -1) {
    return null;
  }
  let depth = 1;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i])) {
      depth++;
    } else if (END_RE.test(lines[i])) {
      depth--;
      if (depth === 0) {
        return { headerIdx, endIdx: i };
      }
    }
  }
  return null;
}

/**
 * The id of the innermost subgraph `id` lives in, or null when it sits at the diagram's
 * root.
 *
 * Mermaid decides membership from the *blocks* an id appears in — any mention inside
 * `subgraph … end` claims the node, which is exactly how you nest a node that was declared
 * elsewhere. Two consequences this function has to respect, and got wrong before:
 *
 * - A mention at the root level says nothing. Real diagrams accumulate stray `id`-on-its-own
 *   lines at the root (this editor's own edge deletion leaves them behind), and stopping at
 *   the first one reported "lives at the root" for a node mermaid was plainly drawing inside
 *   a group.
 * - Among mentions that *are* inside blocks, the line that declares the id (`n3["…"]`) wins
 *   over a passing mention in an edge, since an edge written inside one subgraph routinely
 *   names nodes that live in another. Ties go to the first one, mermaid's own reading order.
 *
 * For a subgraph's own id this answers its *parent*: `s2` nested inside `s1` returns `s1`.
 * That's what callers want — "where does a sibling of this element belong".
 *
 * Pass `stripNotes(source)`: a note's freeform text mentioning an id must not be mistaken
 * for a declaration.
 */
export function findEnclosingSubgraph(source, id) {
  const escaped = escapeRegExp(id);
  const declRe = new RegExp(`(?<![\\w-])${escaped}\\s*(?:\\[|\\(|\\{|>|@\\{)`);
  const mentionRe = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
  const stack = [];
  let best = null;

  for (const line of source.split('\n')) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (header[1] === id) {
        return stack[stack.length - 1] ?? null;
      }
      stack.push(header[1]);
      continue;
    }
    if (END_RE.test(line)) {
      stack.pop();
      continue;
    }
    const enclosing = stack[stack.length - 1];
    if (enclosing === undefined) {
      continue; // root level: tells us nothing about where the node belongs
    }
    const rank = declRe.test(line) ? 2 : mentionRe.test(line) ? 1 : 0;
    if (rank > (best?.rank ?? 0)) {
      best = { rank, enclosing };
    }
  }
  return best?.enclosing ?? null;
}

/**
 * Inserts `newLines` just before `subgraphId`'s own `end`, matching the indentation its
 * existing members use. Returns null (and changes nothing) if there's no such block, so
 * callers can fall back to appending at the root.
 */
export function insertInsideSubgraph(source, subgraphId, newLines) {
  const lines = source.split('\n');
  const block = findSubgraphBlock(lines, subgraphId);
  if (!block) {
    return null;
  }
  const lastMember = lines[block.endIdx - 1];
  const indent =
    lastMember && lastMember.trim()
      ? (/^\s*/.exec(lastMember)?.[0] ?? '  ')
      : `${/^\s*/.exec(lines[block.headerIdx])?.[0] ?? ''}  `;
  lines.splice(block.endIdx, 0, ...newLines.map((line) => `${indent}${line}`));
  return lines.join('\n');
}

/** The `subgraph id["title"] / one placeholder child / end` lines a new subgraph is made of. */
export function subgraphBlockLines(id, title, childId) {
  return [
    `subgraph ${shapeToken(SHAPES[0], id, title)}`,
    `  ${shapeToken(SHAPES[0], childId, 'Node')}`,
    'end',
  ];
}

/**
 * Turns node `id` into a subgraph of the same id, holding one placeholder child. Every
 * edge already pointing at `id` keeps working untouched — mermaid links to a subgraph by
 * the very same id — and the new block lands where the node lived, inside its parent
 * subgraph or at the root.
 *
 * The node's own declaration goes away: a standalone declaration line is removed outright,
 * while one written inline in an edge (`A[Start] --> B`) is reduced to the bare id, so the
 * edge on that line survives.
 */
export function convertNodeToSubgraph(source, id, title, childId) {
  const parent = findEnclosingSubgraph(stripNotes(source), id);
  const decl = findNodeDeclaration(source, id);
  let result = source;

  if (decl) {
    const lineStart = source.lastIndexOf('\n', decl.start - 1) + 1;
    const nlAfter = source.indexOf('\n', decl.end);
    const lineEnd = nlAfter === -1 ? source.length : nlAfter;
    const aloneOnItsLine =
      !source.slice(lineStart, decl.start).trim() && !source.slice(decl.end, lineEnd).trim();
    result = aloneOnItsLine
      ? source.slice(0, lineStart) + source.slice(nlAfter === -1 ? lineEnd : nlAfter + 1)
      : source.slice(0, decl.start) + id + source.slice(decl.end);
  }

  const block = subgraphBlockLines(id, title, childId);
  const inside = parent ? insertInsideSubgraph(result, parent, block) : null;
  return inside ?? appendToDiagram(result, block);
}

/**
 * Every `subgraph` in the source, in the order they appear, each with its nesting depth and
 * its title (falling back to its id when it has none) — the raw material for a "move
 * into…" picker.
 */
export function listSubgraphs(source) {
  const found = [];
  const stack = [];
  for (const line of source.split('\n')) {
    const header = HEADER_RE.exec(line);
    if (header) {
      const id = header[1];
      found.push({ id, title: findNodeDeclaration(line, id)?.label ?? id, depth: stack.length });
      stack.push(id);
      continue;
    }
    if (END_RE.test(line)) {
      stack.pop();
    }
  }
  return found;
}

/** Every id declared inside `subgraphId`'s block, nested subgraphs' own ids included. */
export function idsInsideSubgraph(source, subgraphId) {
  const lines = source.split('\n');
  const block = findSubgraphBlock(lines, subgraphId);
  if (!block) {
    return new Set();
  }
  return extractExistingIds(lines.slice(block.headerIdx + 1, block.endIdx).join('\n'));
}

/** Puts already-dedented `movedLines` inside `targetId`, or at the root when it's null. */
function placeLines(source, targetId, movedLines) {
  const inside = targetId === null ? null : insertInsideSubgraph(source, targetId, movedLines);
  return (
    inside ??
    appendToDiagram(
      source,
      movedLines.map((line) => `  ${line}`)
    )
  );
}

/**
 * Moves a node or subgraph into `targetId`'s block, or out to the root when `targetId` is
 * null. Only the lines that *declare* the element move: mermaid works out membership from
 * where a node is declared, so every edge touching it keeps working exactly as written,
 * wherever in the file that happens to be.
 *
 * A node with no declaration of its own (one that only ever appears inside edges) gets a
 * bare `id` line, which is all mermaid needs to place it. One declared inline on an edge
 * line (`A[Start] --> B`) hands its shape over to the new declaration and leaves the edge
 * behind with a bare id.
 *
 * Returns the source untouched when the move makes no sense: an unknown target, an element
 * already there, or a subgraph asked to move inside itself or one of its own descendants.
 */
export function moveIntoSubgraph(source, id, targetId) {
  const stripped = stripNotes(source);
  if (findEnclosingSubgraph(stripped, id) === targetId) {
    return source;
  }
  const lines = source.split('\n');
  if (targetId !== null && !findSubgraphBlock(lines, targetId)) {
    return source;
  }

  const ownBlock = findSubgraphBlock(lines, id);
  if (ownBlock) {
    if (targetId !== null && (targetId === id || idsInsideSubgraph(source, id).has(targetId))) {
      return source;
    }
    const blockLines = lines.slice(ownBlock.headerIdx, ownBlock.endIdx + 1);
    // Dedent by the block's own indentation rather than trimming every line, so whatever
    // nesting it contains keeps its shape once re-indented at the destination.
    const baseIndent = /^\s*/.exec(blockLines[0])?.[0] ?? '';
    const moved = blockLines.map((line) =>
      line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line.trimStart()
    );
    lines.splice(ownBlock.headerIdx, ownBlock.endIdx - ownBlock.headerIdx + 1);
    return placeLines(lines.join('\n'), targetId, moved);
  }

  const decl = findNodeDeclaration(source, id);
  if (!decl) {
    const bareRe = new RegExp(`^\\s*${escapeRegExp(id)}\\s*$`);
    const withoutBareLine = source.split('\n').filter((line) => !bareRe.test(line));
    return placeLines(withoutBareLine.join('\n'), targetId, [id]);
  }

  const shape = SHAPES.find((s) => s.key === decl.shapeKey) ?? SHAPES[0];
  const lineStart = source.lastIndexOf('\n', decl.start - 1) + 1;
  const nlAfter = source.indexOf('\n', decl.end);
  const lineEnd = nlAfter === -1 ? source.length : nlAfter;
  const aloneOnItsLine =
    !source.slice(lineStart, decl.start).trim() && !source.slice(decl.end, lineEnd).trim();
  const without = aloneOnItsLine
    ? source.slice(0, lineStart) + source.slice(nlAfter === -1 ? lineEnd : nlAfter + 1)
    : source.slice(0, decl.start) + id + source.slice(decl.end);
  return placeLines(without, targetId, [shapeToken(shape, id, decl.label)]);
}

/**
 * Deletes a subgraph's whole `subgraph ... end` block (nested subgraphs and all), plus
 * every edge elsewhere in the diagram touching the subgraph itself or any id that was
 * declared inside it — same "deleting a container deletes its contents" cascade as
 * deleting a node deletes its edges.
 */
export function deleteSubgraphFromSource(source, subgraphId) {
  const lines = source.split('\n');
  const block = findSubgraphBlock(lines, subgraphId);
  if (!block) {
    return source;
  }
  const blockText = lines.slice(block.headerIdx, block.endIdx + 1).join('\n');
  const cascadeIds = extractExistingIds(blockText);
  cascadeIds.add(subgraphId);
  lines.splice(block.headerIdx, block.endIdx - block.headerIdx + 1);
  let result = lines.join('\n');
  for (const cascadeId of cascadeIds) {
    result = removeNodeEdges(result, cascadeId);
  }
  return result;
}

/**
 * Removes any subgraph left with no member ids at all — most commonly right after deleting
 * its last remaining node — repeating so a now-empty parent subgraph (its only child was
 * itself an emptied-out subgraph) gets cleaned up too.
 */
export function pruneEmptySubgraphs(source) {
  let result = source;
  let changed = true;
  while (changed) {
    changed = false;
    const lines = result.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const header = HEADER_RE.exec(lines[i]);
      if (!header) {
        continue;
      }
      const block = findSubgraphBlock(lines, header[1]);
      if (!block || block.headerIdx !== i) {
        continue;
      }
      const interior = lines.slice(block.headerIdx + 1, block.endIdx).join('\n');
      if (extractExistingIds(interior).size === 0) {
        lines.splice(block.headerIdx, block.endIdx - block.headerIdx + 1);
        // The pruned subgraph may still be referenced by edges elsewhere (e.g. `A --> s2`)
        // — drop those too, same as deleting it outright.
        result = removeNodeEdges(lines.join('\n'), header[1]);
        changed = true;
        break;
      }
    }
  }
  return result;
}
