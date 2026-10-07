/**
 * Renaming an element's id, everywhere the source mentions it — its declaration, every edge
 * touching it, the subgraph block it sits in (or heads), `style`/`class`/`click` lines, bare
 * mentions, and the notes block — so that nothing is left pointing at a name that no longer
 * exists. A rename that only touched the declaration would quietly turn every edge into one
 * aimed at a brand new, empty node.
 *
 * The id is replaced as a whole token, never as a substring of a longer id, and never
 * inside text: an id can easily double as a word in a label (`C["B"]`, `-->|B|`,
 * `-- B -->`) or in a note's prose, and that text is not a reference. The label grammar
 * for edges lives in edgeEditor.js, so the edge parser is what tells this file where an
 * edge's label text sits, rather than teaching it the same grammar a second time.
 *
 * Same policy as the rest of the playground's editing helpers: a best-effort line scanner,
 * not a real parser. Comment lines are left alone, except the notes block, which notes.js
 * knows how to rewrite.
 */

import { parseEdgeLines } from './edgeEditor.js';
import { renameNoteId } from './notes.js';
import { escapeRegExp } from './shapes.js';

/**
 * Character ranges of a line that are text rather than syntax: quoted strings, `|label|`
 * pipes, and the body of an inline shape (`n1[Some text]`, `n1(text)`, `n1{text}`,
 * `n1>text]`, `n1@{ shape: … }`).
 */
function textRanges(line) {
  const ranges = [];
  for (const m of line.matchAll(/"[^"\n]*"/g)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  for (const m of line.matchAll(/\|[^|\n]*\|/g)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const shapeBody = /(?<![\w-])[A-Za-z][\w-]*(\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|>[^\]\n]*\]|@\{[^}\n]*\})/g;
  for (const m of line.matchAll(shapeBody)) {
    const end = m.index + m[0].length;
    ranges.push([end - m[1].length, end]);
  }
  return ranges;
}

/**
 * Replaces every whole-token occurrence of `oldId` in `line` that does not fall inside one
 * of `protectedRanges`. A token glued to a following `@` is an edge's own id (`e1@-->`),
 * a different namespace, and is skipped — unless the `@` opens an `@{ … }` shape block,
 * which is a node declaration.
 */
function replaceToken(line, oldId, newId, protectedRanges) {
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(oldId)}(?![\\w-])(?!@(?!\\{))`, 'g');
  let out = '';
  let last = 0;
  for (const m of line.matchAll(re)) {
    const inText = protectedRanges.some(([from, to]) => m.index >= from && m.index < to);
    if (inText) {
      continue;
    }
    out += line.slice(last, m.index) + newId;
    last = m.index + oldId.length;
  }
  return out + line.slice(last);
}

/** Returns `source` with every reference to `oldId` renamed to `newId`. */
export function renameId(source, oldId, newId) {
  if (oldId === newId) {
    return source;
  }
  const lines = source.split('\n');

  // Where each edge line's labels sit (an `arrowSpan` covers everything between two ids,
  // label text included, whichever way the label was written) — the one kind of text a
  // plain scan of the line can't tell apart from syntax.
  const labelRanges = new Map();
  for (const entry of parseEdgeLines(source)) {
    if (entry.arrowSpan) {
      const ranges = labelRanges.get(entry.lineIndex) ?? [];
      ranges.push(entry.arrowSpan);
      labelRanges.set(entry.lineIndex, ranges);
    }
  }

  for (const [i, line] of lines.entries()) {
    if (/^\s*%%/.test(line)) {
      continue; // comments are prose; the notes block gets its own pass below
    }
    const ranges = [...textRanges(line), ...(labelRanges.get(i) ?? [])];
    lines[i] = replaceToken(line, oldId, newId, ranges);
  }

  return renameNoteId(lines.join('\n'), oldId, newId);
}
