// Paper style & colour pickers with tiny CSS previews (used by the cover editor, ⋯ menu and page drawer).
import { h } from './dom.js';
import { PAPER_STYLES, PAPER_COLORS, BOARD_BACKGROUNDS } from '../canvas/constants.js';

export const PAPER_NAMES = { blank: 'Blank', lined: 'Lined', narrow: 'Narrow', grid: 'Grid', dotted: 'Dotted', cornell: 'Cornell' };
export const PAPER_COLOR_NAMES = { white: 'White', cream: 'Cream', dark: 'Dark' };
export const BOARD_NAMES = { dots: 'Dots', grid: 'Grid', blank: 'Blank' };

function ruleColor(color) {
  return color === 'dark' ? 'rgba(255,255,255,0.22)' : 'rgba(80,130,200,0.5)';
}

export function paperPreview(style, color) {
  return h('span', {
    class: 'paper-prev', 'data-style': style, 'aria-hidden': 'true',
    style: { '--paper': PAPER_COLORS[color] || '#fff', '--rule': ruleColor(color) },
  });
}

function chips(values, current, render, label, onPick) {
  const row = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': label });
  const btns = values.map(v => {
    const b = h('button', {
      type: 'button', class: 'paper-chip', role: 'radio', 'aria-checked': String(v === current),
      onClick: () => { btns.forEach(x => x.setAttribute('aria-checked', String(x === b))); onPick(v); },
    }, ...render(v));
    return b;
  });
  row.append(...btns);
  return { row, btns };
}

/** paperPicker({paper:{style,color}, onChange(paper)}) → element with .setPaper(p) */
export function paperPicker({ paper, onChange }) {
  let cur = { style: paper?.style || 'lined', color: paper?.color || 'white' };
  const styleChips = chips(PAPER_STYLES, cur.style,
    v => [paperPreview(v, cur.color), h('span', { class: 'paper-chip-name' }, PAPER_NAMES[v] || v)],
    'Paper style', v => { cur = { ...cur, style: v }; onChange({ ...cur }); });
  const colorChips = chips(Object.keys(PAPER_COLORS), cur.color,
    v => [h('span', { class: 'paper-dot', style: { background: PAPER_COLORS[v] } }), h('span', { class: 'paper-chip-name' }, PAPER_COLOR_NAMES[v] || v)],
    'Paper colour', v => {
      cur = { ...cur, color: v };
      styleChips.row.querySelectorAll('.paper-prev').forEach(p => {
        p.style.setProperty('--paper', PAPER_COLORS[v]);
        p.style.setProperty('--rule', ruleColor(v));
      });
      onChange({ ...cur });
    });
  colorChips.row.classList.add('chip-row--colors');
  return h('div', { class: 'paper-picker' }, styleChips.row, colorChips.row);
}

/** boardPicker({background, color, onChange({background,color})}) */
export function boardPicker({ background, color, onChange }) {
  let cur = { background: background || 'dots', color: color || 'white' };
  const prev = v => h('span', {
    class: 'paper-prev paper-prev--board', 'data-style': v === 'dots' ? 'dotted' : v, 'aria-hidden': 'true',
    style: { '--paper': PAPER_COLORS[cur.color] || '#fff', '--rule': ruleColor(cur.color) },
  });
  const bgChips = chips(BOARD_BACKGROUNDS, cur.background,
    v => [prev(v), h('span', { class: 'paper-chip-name' }, BOARD_NAMES[v] || v)],
    'Background', v => { cur = { ...cur, background: v }; onChange({ ...cur }); });
  const colorChips = chips(Object.keys(PAPER_COLORS), cur.color,
    v => [h('span', { class: 'paper-dot', style: { background: PAPER_COLORS[v] } }), h('span', { class: 'paper-chip-name' }, PAPER_COLOR_NAMES[v] || v)],
    'Board colour', v => {
      cur = { ...cur, color: v };
      bgChips.row.querySelectorAll('.paper-prev').forEach(p => {
        p.style.setProperty('--paper', PAPER_COLORS[v]);
        p.style.setProperty('--rule', ruleColor(v));
      });
      onChange({ ...cur });
    });
  colorChips.row.classList.add('chip-row--colors');
  return h('div', { class: 'paper-picker' }, bgChips.row, colorChips.row);
}
