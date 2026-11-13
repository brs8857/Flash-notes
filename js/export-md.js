// Notes → Markdown. Pure (no DOM), tested in tests/export-md.test.mjs.
// Markdown can only carry words: notebook titles and text boxes. Handwriting, shapes, highlighter and
// pictures cannot be expressed in Markdown and are only counted. Use the JSON backup or PDF for those.

/** Escapes text so it is shown literally by any Markdown renderer: no markup, no HTML, no links. */
export function mdEscape(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|~])/g, '\\$1');
}

/** One line (titles): no line breaks. */
function mdLine(text) { return mdEscape(String(text == null ? '' : text).replace(/\s+/g, ' ').trim()); }

/** A text box: each of its lines escaped; a line break inside a box stays a line break. */
function mdBlock(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
    .map(line => mdEscape(line).replace(/^(\s*)=/, '$1\\=').replace(/^[ \t]+/, ws => ws.replace(/\t/g, ' ').slice(0, 3)))   // never a code block
    .join('  \n');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * sections = [{doc, pages:[page…]}] (pages in notebook order). Returns the Markdown text.
 * Text boxes are listed top to bottom, then left to right.
 */
export function notesToMarkdown(sections, { exportedAt } = {}) {
  const out = ['# Flash Notes export', ''];
  if (exportedAt) out.push(`Exported ${new Date(exportedAt).toISOString().slice(0, 10)}.`, '');
  out.push('Only titles and text boxes are included. Handwriting, shapes, highlighter and pictures cannot be written as Markdown; use the JSON backup or a PDF export to keep those.', '');
  if (!sections || !sections.length) out.push('_No notebooks yet._', '');
  for (const { doc, pages } of sections || []) {
    const kind = doc && doc.kind === 'whiteboard' ? 'Whiteboard' : 'Notebook';
    out.push(`## ${mdLine(doc && doc.title) || 'Untitled'}`, '', `_${kind}_`, '');
    (pages || []).forEach((page, i) => {
      const items = Array.isArray(page && page.items) ? page.items : [];
      const texts = items.filter(it => it && it.type === 'text' && typeof it.text === 'string' && it.text.trim())
        .sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0));
      const strokes = items.filter(it => it && it.type === 'stroke').length;
      const images = items.filter(it => it && it.type === 'image').length;
      if (kind === 'Notebook') out.push(`### Page ${i + 1}`, '');
      for (const t of texts) out.push(mdBlock(t.text), '');
      const skipped = [];
      if (strokes) skipped.push(plural(strokes, 'handwriting stroke', 'handwriting strokes'));
      if (images) skipped.push(plural(images, 'picture', 'pictures'));
      if (skipped.length) out.push(`_Not included: ${skipped.join(' and ')}._`, '');
      else if (!texts.length) out.push('_Empty page._', '');
    });
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
