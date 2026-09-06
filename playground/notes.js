/**
 * Per-element notes (node/edge/subgraph), stored as `%%` comment lines in a dedicated
 * block at the end of the diagram source — mermaid ignores `%%` lines entirely, so this
 * never affects rendering, but it means the notes travel with the source itself: copy
 * the diagram's text anywhere (another instance of this editor, a file, a chat message)
 * and the notes come with it. That's the whole point — a note only pinned to this
 * project's own database would vanish the moment someone else opens just the source.
 *
 * One line per note: `%% @note:<kind> <id> <text>`, kind is `node`, `edge`, or
 * `subgraph`; `id` is that element's own id (an edge's is whatever `assignEdgeId` in
 * edgeEditor.js gave it — edges have no identity of their own otherwise). `text` is
 * everything after the id to end of line, with real newlines/backslashes escaped so a
 * multi-line note still round-trips as a single physical source line.
 */

const NOTES_HEADER = '%% ---- Notes (managed by the Notes panel) ----';
const NOTE_LINE_RE = /^%% @note:(node|edge|subgraph) ([A-Za-z][\w-]*) (.*)$/;

function escapeNoteText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');
}

function unescapeNoteText(raw) {
  return raw.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

/** Returns every note in `source` as a `Map` keyed `"<kind>:<id>"` -> note text. */
export function parseNotes(source) {
  const notes = new Map();
  for (const line of source.split('\n')) {
    const m = NOTE_LINE_RE.exec(line);
    if (m) {
      notes.set(`${m[1]}:${m[2]}`, unescapeNoteText(m[3]));
    }
  }
  return notes;
}

function rewriteNotesBlock(source, notes) {
  const lines = source
    .split('\n')
    .filter((line) => line !== NOTES_HEADER && !NOTE_LINE_RE.test(line));
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  let result = lines.length ? `${lines.join('\n')}\n` : '';
  if (notes.size > 0) {
    const noteLines = [...notes.entries()]
      .map(([key, text]) => {
        const [kind, id] = key.split(':');
        return `%% @note:${kind} ${id} ${escapeNoteText(text)}`;
      })
      .join('\n');
    result += `${NOTES_HEADER}\n${noteLines}\n`;
  }
  return result;
}

/**
 * Appends `lines` to the diagram, above the notes footer when there is one. Mermaid
 * ignores `%%` lines wherever they sit, so this changes nothing about rendering — but
 * diagram code written *below* a "---- Notes ----" footer reads like something went wrong,
 * and the next note written would shuffle the footer back down past it anyway.
 */
export function appendToDiagram(source, lines) {
  const block = `${lines.join('\n')}\n`;
  const at = source.indexOf(NOTES_HEADER);
  if (at === -1) {
    const sep = source.length && !source.endsWith('\n') ? '\n' : '';
    return `${source}${sep}${block}`;
  }
  return source.slice(0, at) + block + source.slice(at);
}

/** Sets (or, given blank text, removes) the note for `kind`:`id`. */
export function setNote(source, kind, id, text) {
  const notes = parseNotes(source);
  const key = `${kind}:${id}`;
  if (text.trim()) {
    notes.set(key, text);
  } else {
    notes.delete(key);
  }
  return rewriteNotesBlock(source, notes);
}

/** Removes the note for `kind`:`id`, if any. No-op if it doesn't have one. */
export function removeNote(source, kind, id) {
  const notes = parseNotes(source);
  if (!notes.delete(`${kind}:${id}`)) {
    return source;
  }
  return rewriteNotesBlock(source, notes);
}

/**
 * A note can point at another element by id, written `@n12` — so a note reads as prose
 * ("blocked by @auth until @n12 lands") while still linking to the real thing. The
 * notation's parsing *and* its rendering live here together, since the two have to agree
 * on exactly what counts as a reference.
 */
const NOTE_REF_RE = /@([A-Za-z][\w-]*)/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
}

/**
 * `text` as HTML with every `@id` wrapped in a `.note-ref` span carrying the id, for the
 * Notes panel's clickable backdrop. A reference to an id that isn't in the diagram (yet)
 * is marked `.unknown` rather than dropped — it's most likely a typo or an element that
 * was deleted, and hiding that would be worse than showing it.
 */
export function noteTextToHtml(text, isKnownId) {
  let out = '';
  let last = 0;
  NOTE_REF_RE.lastIndex = 0;
  let match;
  while ((match = NOTE_REF_RE.exec(text))) {
    out += escapeHtml(text.slice(last, match.index));
    const known = isKnownId(match[1]);
    out += `<span class="note-ref${known ? '' : ' unknown'}" data-ref-id="${escapeHtml(match[1])}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * Returns `source` with the whole notes block (header + every note line) stripped out.
 * A note's own text is freeform — someone might write "fix A->B" or "new node X[shape]"
 * describing the diagram — and callers that scan the source for identifiers
 * (existing-id collision checks, "does this id still exist" pruning) must not mistake
 * that prose for real mermaid syntax. Scan `stripNotes(source)`, never `source` itself,
 * for that.
 */
export function stripNotes(source) {
  return rewriteNotesBlock(source, new Map());
}
