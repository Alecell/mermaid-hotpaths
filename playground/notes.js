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
