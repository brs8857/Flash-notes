// Cover editor sheet: used to create a notebook and to edit an existing cover.
import { h, downscaleImage, filePicker } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { coverEl, updateCover, COVER_COLORS, COVER_PATTERNS, COVER_EMOJI, PATTERN_NAMES } from './cover.js';
import { paperPicker } from './paper.js';

const SUBJECT_HINTS = ['Economics', 'Geography', 'Politics', 'History', 'Maths', 'Biology'];

/**
 * openCoverEditor({doc?}) → Promise<{title, cover, paper} | null>
 * With a doc: edits it ("Done"). Without: creates ("Create").
 */
export function openCoverEditor({ doc } = {}) {
  const editing = !!doc;
  const state = {
    title: doc?.title || '',
    cover: { color: COVER_COLORS[0], pattern: 'plain', emoji: '📘', image: null, ...(doc?.cover || {}) },
    paper: { style: 'lined', color: 'white', ...(doc?.paper || {}) },
  };
  if (!editing) {
    // A little variety so a shelf of new notebooks does not look uniform.
    state.cover.color = COVER_COLORS[Math.floor(Math.random() * 10)];
  }

  const preview = coverEl({ title: state.title || 'Untitled', cover: state.cover });
  preview.classList.add('ce-cover');
  const refresh = () => updateCover(preview, { title: state.title.trim() || 'Untitled', cover: state.cover });

  const titleInput = h('input', {
    class: 'field', type: 'text', value: state.title, maxlength: '60', 'aria-label': 'Notebook title',
    placeholder: `e.g. ${SUBJECT_HINTS[Math.floor(Math.random() * SUBJECT_HINTS.length)]}`,
    autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done',
    onInput: e => { state.title = e.target.value; refresh(); },
    onKeydown: e => { if (e.key === 'Enter') e.target.blur(); },
  });

  // Colours
  const swatchRow = h('div', { class: 'swatch-grid', role: 'radiogroup', 'aria-label': 'Cover colour' });
  const customInput = h('input', {
    type: 'color', class: 'swatch-custom-input', value: state.cover.color, 'aria-label': 'Custom colour',
    onInput: e => { setColor(e.target.value); },
  });
  const customSwatch = h('label', { class: 'swatch swatch--custom', title: 'Custom colour' }, customInput);
  function setColor(c) {
    state.cover.color = c;
    patternRow.style.setProperty('--chip-cover', c);
    swatchRow.querySelectorAll('.swatch[data-color]').forEach(s => s.setAttribute('aria-checked', String(s.dataset.color.toLowerCase() === c.toLowerCase())));
    const isCustom = !COVER_COLORS.some(x => x.toLowerCase() === c.toLowerCase());
    customSwatch.classList.toggle('is-active', isCustom);
    if (isCustom) customSwatch.style.setProperty('--sw', c);
    refresh();
  }
  for (const c of COVER_COLORS) {
    swatchRow.append(h('button', {
      type: 'button', class: 'swatch', role: 'radio', 'data-color': c, 'aria-label': `Colour ${c}`,
      style: { '--sw': c }, onClick: () => setColor(c),
    }));
  }
  swatchRow.append(customSwatch);

  // Patterns
  const patternRow = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'Cover pattern' });
  function setPattern(p) {
    state.cover.pattern = p;
    patternRow.querySelectorAll('.pattern-chip').forEach(b => b.setAttribute('aria-checked', String(b.dataset.pattern === p)));
    refresh();
  }
  for (const p of COVER_PATTERNS) {
    patternRow.append(h('button', {
      type: 'button', class: 'pattern-chip', role: 'radio', 'data-pattern': p, onClick: () => setPattern(p),
    },
      h('span', { class: 'pattern-prev cover-pattern-host', 'data-pattern': p }, h('span', { class: 'cover-pattern' })),
      h('span', { class: 'paper-chip-name' }, PATTERN_NAMES[p])));
  }

  // Emoji
  const emojiRow = h('div', { class: 'emoji-grid', role: 'radiogroup', 'aria-label': 'Sticker' });
  function setEmoji(e) {
    state.cover.emoji = e;
    emojiRow.querySelectorAll('.emoji-chip').forEach(b => b.setAttribute('aria-checked', String((b.dataset.emoji || null) === e)));
    refresh();
  }
  emojiRow.append(h('button', { type: 'button', class: 'emoji-chip emoji-chip--none', role: 'radio', 'aria-label': 'No sticker', onClick: () => setEmoji(null) }, 'None'));
  for (const e of COVER_EMOJI) {
    emojiRow.append(h('button', { type: 'button', class: 'emoji-chip', role: 'radio', 'data-emoji': e, 'aria-label': `Sticker ${e}`, onClick: () => setEmoji(e) }, e));
  }

  // Photo
  const picker = filePicker('image/*');
  const removeBtn = h('button', { type: 'button', class: 'btn btn--quiet btn--danger', onClick: () => { state.cover.image = null; syncPhoto(); refresh(); } }, 'Remove photo');
  const photoBtn = h('button', {
    type: 'button', class: 'btn btn--tinted',
    onClick: () => picker.pick(async file => {
      try {
        const { dataUrl } = await downscaleImage(file, 800, { quality: 0.85 });
        state.cover.image = dataUrl; syncPhoto(); refresh();
      } catch (err) { toast(err.message || 'Could not use that photo', { icon: 'info' }); }
    }),
  }, icon('image', 18), h('span', null, 'Choose photo'));
  const photoRow = h('div', { class: 'btn-row' }, photoBtn, removeBtn);
  function syncPhoto() {
    removeBtn.hidden = !state.cover.image;
    photoBtn.lastChild.textContent = state.cover.image ? 'Change photo' : 'Choose photo';
    patternRow.classList.toggle('is-disabled', !!state.cover.image);
  }

  const papers = paperPicker({ paper: state.paper, onChange: p => { state.paper = p; } });

  const group = (label, ...kids) => h('section', { class: 'form-group' }, h('div', { class: 'form-label' }, label), ...kids);
  const body = h('div', { class: 'ce' },
    h('div', { class: 'ce-preview' }, preview),
    h('div', { class: 'ce-form' },
      group('Title', titleInput),
      group('Colour', swatchRow),
      group('Pattern', patternRow),
      group('Sticker', emojiRow),
      group('Photo cover', photoRow),
      group('Paper for new pages', papers)));

  setColor(state.cover.color); setPattern(state.cover.pattern); setEmoji(state.cover.emoji || null); syncPhoto();

  return new Promise(resolve => {
    openSheet({
      title: editing ? 'Edit cover' : 'New notebook',
      body, size: 'lg', cancelLabel: 'Cancel', doneLabel: editing ? 'Done' : 'Create',
      className: 'sheet--cover',
      onClose: result => {
        picker.destroy();
        if (!result) { resolve(null); return; }
        resolve({
          title: state.title.trim() || (editing ? doc.title : 'Untitled notebook'),
          cover: { ...state.cover },
          paper: { ...state.paper },
        });
      },
    });
  });
}
