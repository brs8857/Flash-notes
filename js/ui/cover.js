// Notebook covers: a realistic little notebook drawn with CSS (spine, elastic band, label, sticker).
import { h, luminance, shade } from './dom.js';

export const COVER_COLORS = [
  '#3B5BDB', '#1C7ED6', '#0C8599', '#2F9E44', '#F59F00', '#E8590C',
  '#E03131', '#D6336C', '#9C36B5', '#5F3DC4', '#343A40', '#E7D9BE',
];
export const COVER_PATTERNS = ['plain', 'stripes', 'dots', 'grid', 'waves', 'checks'];
export const COVER_EMOJI = ['📘', '📗', '📕', '📙', '📓', '🧠', '🌍', '⚖️', '📈', '✏️', '🎓', '⭐'];
export const PATTERN_NAMES = { plain: 'Plain', stripes: 'Stripes', dots: 'Dots', grid: 'Grid', waves: 'Waves', checks: 'Checks' };

function applyCover(el, title, cover) {
  const color = /^#[0-9a-f]{6}$/i.test(cover?.color || '') ? cover.color : '#3B5BDB';
  const light = luminance(color) > 0.55;
  el.style.setProperty('--cover', color);
  el.style.setProperty('--cover-dark', shade(color, -0.3));
  el.style.setProperty('--cover-deep', shade(color, -0.48));
  el.style.setProperty('--cover-light', shade(color, 0.16));
  el.style.setProperty('--pat', light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.17)');
  el.dataset.pattern = cover?.image ? 'plain' : (cover?.pattern || 'plain');
  el.classList.toggle('cover--photo', !!cover?.image);
  const photo = el.querySelector('.cover-photo');
  photo.style.backgroundImage = cover?.image ? `url("${cover.image}")` : '';
  el.querySelector('.cover-label-text').textContent = title || 'Untitled';
  const em = el.querySelector('.cover-emoji');
  em.textContent = cover?.emoji || '';
  em.hidden = !cover?.emoji;
}

/** Build a cover element. Size it with CSS (width) — it keeps a 3:4 ratio and scales its details. */
export function coverEl(doc) {
  const el = h('div', { class: 'cover' },
    h('div', { class: 'cover-shadow', 'aria-hidden': 'true' }),
    h('div', { class: 'cover-pages', 'aria-hidden': 'true' }),
    h('div', { class: 'cover-body', 'data-squircle': '5 15 15 5' },
      h('div', { class: 'cover-photo' }),
      h('div', { class: 'cover-pattern' }),
      h('div', { class: 'cover-sheen' }),
      h('div', { class: 'cover-band' }),
      h('div', { class: 'cover-spine' }),
      h('div', { class: 'cover-label' },
        h('span', { class: 'cover-label-text' }),
        h('span', { class: 'cover-label-rule', 'aria-hidden': 'true' })),
      h('div', { class: 'cover-emoji', 'aria-hidden': 'true' })));
  applyCover(el, doc.title, doc.cover);
  return el;
}

export function updateCover(el, { title, cover }) { applyCover(el, title, cover); }
