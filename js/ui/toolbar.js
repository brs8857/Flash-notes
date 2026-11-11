// Tool dock: floating glass pill with the drawing tools, option popovers and quick colours.
import { h, clear, debounce, luminance } from './dom.js';
import { icon } from './icons.js';
import { openPopover } from './menu.js';
import { INK_COLORS, HIGHLIGHT_COLORS, SIZES } from '../canvas/constants.js';

const TOOLS = [
  { id: 'pen', icon: 'pen', label: 'Pen', options: true },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter', options: true },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', options: true },
  { id: 'lasso', icon: 'lasso', label: 'Lasso select' },
  { id: 'text', icon: 'text', label: 'Text', options: true },
  { id: 'image', icon: 'image', label: 'Insert image', action: true },
  { id: 'hand', icon: 'hand', label: 'Move around' },
];
const FONTS = [
  { id: 'sans', label: 'Sans', css: 'var(--font-ui)' },
  { id: 'round', label: 'Round', css: 'var(--font-rounded)' },
  { id: 'serif', label: 'Serif', css: 'var(--font-serif)' },
  { id: 'mono', label: 'Mono', css: 'var(--font-mono)' },
];
const SIZE_LABELS = ['Small', 'Medium', 'Large'];
const DOT_PX = [6, 10, 15];

function defaults() {
  return {
    active: 'pen',
    pen: { color: INK_COLORS[0], size: SIZES.pen[1] },
    highlighter: { color: HIGHLIGHT_COLORS[0], size: SIZES.highlighter[1] },
    eraser: { size: SIZES.eraser[1], eraseMode: 'stroke' },
    text: { color: INK_COLORS[0], size: SIZES.text[1], font: 'sans' },
  };
}

const isHex = c => /^#[0-9a-f]{6}$/i.test(c || '');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * createToolbar({saved, recent, getView, onInsertImage, onPersist})
 * → {el, setActive(tool), applyTo(view), layout(), destroy()}
 */
export function createToolbar({ saved, recent, getView, onInsertImage, onPersist }) {
  const d = defaults();
  const state = {
    active: TOOLS.some(t => t.id === saved?.active && !t.action) ? saved.active : d.active,
    pen: { ...d.pen, ...(saved?.pen || {}) },
    highlighter: { ...d.highlighter, ...(saved?.highlighter || {}) },
    eraser: { ...d.eraser, ...(saved?.eraser || {}) },
    text: { ...d.text, ...(saved?.text || {}) },
  };
  if (!isHex(state.pen.color)) state.pen.color = d.pen.color;
  if (!isHex(state.highlighter.color)) state.highlighter.color = d.highlighter.color;
  if (!isHex(state.text.color)) state.text.color = d.text.color;
  if (!(state.text.size >= 16)) state.text.size = d.text.size;
  let recents = (Array.isArray(recent) ? recent.filter(isHex) : []).slice(0, 3);
  for (const c of [INK_COLORS[0], INK_COLORS[1], INK_COLORS[2]]) {
    if (recents.length >= 3) break;
    if (!recents.some(r => same(r, c))) recents.push(c);
  }
  let pop = null;

  const persist = debounce(() => onPersist({ tools: JSON.parse(JSON.stringify(state)), recentColors: [...recents] }), 500);

  // ---------------------------------------------------------------- dock

  const thumb = h('span', { class: 'dock-thumb', 'aria-hidden': 'true', 'data-squircle': '13' });
  const buttons = {};
  const pips = {};
  const dock = h('div', { class: 'dock glass', role: 'toolbar', 'aria-label': 'Drawing tools' }, thumb);
  for (const t of TOOLS) {
    const pip = (t.id === 'pen' || t.id === 'highlighter') ? h('span', { class: 'tool-pip' }) : null;
    if (pip) pips[t.id] = pip;
    const b = h('button', {
      class: 'tool-btn', type: 'button', 'aria-label': t.label, title: t.label, 'data-tool': t.id,
      'aria-pressed': t.action ? null : 'false',
      onClick: () => onToolTap(t, b),
    }, icon(t.icon, 23, 1.8), pip);
    buttons[t.id] = b;
    if (t.id === 'image') dock.append(h('span', { class: 'dock-sep', 'aria-hidden': 'true' }));
    dock.append(b);
  }

  const quick = h('div', { class: 'quick glass', role: 'group', 'aria-label': 'Recent pen colours' });
  const el = h('div', { class: 'ed-tools' }, dock, quick);

  function swatchBorder(c) { return luminance(c) > 0.85 ? 'swatch--light' : (luminance(c) < 0.03 ? 'swatch--dark' : ''); }

  function renderQuick() {
    clear(quick);
    for (const c of recents) {
      quick.append(h('button', {
        type: 'button', class: `quick-dot ${swatchBorder(c)}`, 'aria-label': `Pen colour ${c}`,
        'aria-pressed': String(state.active === 'pen' && same(state.pen.color, c)),
        style: { '--sw': c },
        onClick: () => { state.pen.color = c; push('pen'); setActive('pen'); syncPips(); renderQuick(); persist(); },
      }));
    }
  }

  function syncPips() {
    pips.pen.style.background = state.pen.color;
    pips.pen.classList.toggle('tool-pip--light', luminance(state.pen.color) > 0.85);
    pips.highlighter.style.background = state.highlighter.color;
  }

  function layout() {
    const b = buttons[state.active];
    if (!b) return;
    thumb.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.height = `${b.offsetHeight}px`;
  }

  function push(tool) {
    const v = getView();
    if (!v) return;
    const o = state[tool];
    if (!o) return;
    if (tool === 'eraser') v.setToolOptions('eraser', { size: o.size, eraseMode: o.eraseMode });
    else if (tool === 'text') v.setToolOptions('text', { color: o.color, size: o.size, font: o.font });
    else v.setToolOptions(tool, { color: o.color, size: o.size });
  }

  function setActive(tool, { fromEngine = false } = {}) {
    if (!buttons[tool] || tool === 'image') return;
    const changed = state.active !== tool;
    state.active = tool;
    for (const t of TOOLS) if (!t.action) buttons[t.id].setAttribute('aria-pressed', String(t.id === tool));
    layout();
    if (!fromEngine) { const v = getView(); if (v && v.getTool() !== tool) v.setTool(tool); }
    if (changed) { renderQuick(); persist(); }
  }

  function onToolTap(t, btn) {
    if (t.action) { onInsertImage(); return; }
    if (state.active !== t.id) { setActive(t.id); return; }
    if (t.options) openOptions(t, btn);
  }

  // ---------------------------------------------------------------- option popovers

  function colorRow(tool, colors, { custom }) {
    const row = h('div', { class: 'opt-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
    const pick = (c, { commit = true } = {}) => {
      state[tool].color = c;
      push(tool);
      syncPips();
      if (tool === 'pen' && commit) {
        if (!recents.some(r => same(r, c))) recents = [c, ...recents].slice(0, 3);
        renderQuick();
      } else if (tool === 'pen') renderQuick();
      sync();
      persist();
    };
    const btns = colors.map(c => h('button', {
      type: 'button', class: `swatch ${swatchBorder(c)}`, role: 'radio', 'aria-label': `Colour ${c}`, 'data-color': c,
      style: { '--sw': c }, onClick: () => pick(c),
    }));
    row.append(...btns);
    let customSwatch = null;
    if (custom) {
      const input = h('input', {
        type: 'color', class: 'swatch-custom-input', value: state[tool].color, 'aria-label': 'Custom colour',
        onInput: e => pick(e.target.value, { commit: false }),
        onChange: e => pick(e.target.value),
      });
      customSwatch = h('label', { class: 'swatch swatch--custom', title: 'Custom colour' }, input);
      row.append(customSwatch);
    }
    function sync() {
      const cur = state[tool].color;
      let found = false;
      btns.forEach(b => { const on = same(b.dataset.color, cur); if (on) found = true; b.setAttribute('aria-checked', String(on)); });
      if (customSwatch) {
        customSwatch.classList.toggle('is-active', !found);
        if (!found) customSwatch.style.setProperty('--sw', cur);
      }
    }
    sync();
    return row;
  }

  function sizeRow(tool, sizes) {
    const row = h('div', { class: 'opt-sizes', role: 'radiogroup', 'aria-label': 'Size' });
    const btns = sizes.map((s, i) => h('button', {
      type: 'button', class: 'size-btn', role: 'radio', 'aria-label': `${SIZE_LABELS[i]} size`,
      'aria-checked': String(state[tool].size === s),
      onClick: () => {
        state[tool].size = s; push(tool); persist();
        btns.forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
      },
    }, tool === 'text'
      ? h('span', { class: 'size-letter', style: { fontSize: `${13 + i * 5}px` } }, 'A')
      : h('span', { class: `size-dot ${tool === 'eraser' ? 'size-dot--ring' : ''}`, style: { width: `${DOT_PX[i]}px`, height: `${DOT_PX[i]}px` } })));
    row.append(...btns);
    return row;
  }

  function segRow(label, options, current, onPick) {
    const row = h('div', { class: 'opt-seg', role: 'radiogroup', 'aria-label': label });
    const btns = options.map(o => h('button', {
      type: 'button', class: 'opt-seg-btn', role: 'radio', 'aria-checked': String(o.id === current),
      style: o.css ? { fontFamily: o.css } : null,
      onClick: () => { btns.forEach(b => b.setAttribute('aria-checked', String(b === btn(o)))); onPick(o.id); },
    }, o.label));
    const btn = o => btns[options.indexOf(o)];
    row.append(...btns);
    return row;
  }

  function openOptions(t, btn) {
    if (pop) { pop.close(); pop = null; }
    const title = txt => h('div', { class: 'opt-title' }, txt);
    let content;
    if (t.id === 'pen') {
      content = h('div', { class: 'opt' }, title('Pen'), colorRow('pen', INK_COLORS, { custom: true }), h('div', { class: 'opt-divider' }), sizeRow('pen', SIZES.pen));
    } else if (t.id === 'highlighter') {
      content = h('div', { class: 'opt' }, title('Highlighter'), colorRow('highlighter', HIGHLIGHT_COLORS, { custom: false }), h('div', { class: 'opt-divider' }), sizeRow('highlighter', SIZES.highlighter));
    } else if (t.id === 'eraser') {
      content = h('div', { class: 'opt' }, title('Eraser'),
        segRow('Eraser mode', [{ id: 'stroke', label: 'Stroke' }, { id: 'area', label: 'Precise' }], state.eraser.eraseMode,
          m => { state.eraser.eraseMode = m; push('eraser'); persist(); }),
        h('div', { class: 'opt-note' }, 'Stroke removes whole lines. Precise rubs out only what you touch.'),
        h('div', { class: 'opt-divider' }), sizeRow('eraser', SIZES.eraser));
    } else if (t.id === 'text') {
      content = h('div', { class: 'opt' }, title('Text'),
        segRow('Font', FONTS, state.text.font, f => { state.text.font = f; push('text'); persist(); }),
        sizeRow('text', SIZES.text), h('div', { class: 'opt-divider' }),
        colorRow('text', INK_COLORS, { custom: false }),
        h('div', { class: 'opt-note' }, 'Tap the page to add a text box.'));
    } else return;
    pop = openPopover(btn, content, { className: 'popover--opts', label: `${t.label} options`, onClose: () => { pop = null; } });
  }

  renderQuick();
  syncPips();
  for (const t of TOOLS) if (!t.action) buttons[t.id].setAttribute('aria-pressed', String(t.id === state.active));
  const ro = new ResizeObserver(() => layout());
  ro.observe(dock);

  return {
    el, layout,
    setActive,
    getActive: () => state.active,
    applyTo(view) {
      for (const tool of ['pen', 'highlighter', 'eraser', 'text']) {
        const o = state[tool];
        if (tool === 'eraser') view.setToolOptions('eraser', { size: o.size, eraseMode: o.eraseMode });
        else if (tool === 'text') view.setToolOptions('text', { color: o.color, size: o.size, font: o.font });
        else view.setToolOptions(tool, { color: o.color, size: o.size });
      }
      view.setTool(state.active);
      layout();
    },
    destroy() { ro.disconnect(); persist.flush(); if (pop) pop.close(); },
  };
}
