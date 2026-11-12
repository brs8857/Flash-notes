// Tool dock: floating glass pill with the drawing tools, option popovers and quick colours.
import { h, clear, debounce, luminance, reducedMotion, fastTap } from './dom.js';
import { icon } from './icons.js';
import { openPopover } from './menu.js';
import { INK_COLORS, HIGHLIGHT_COLORS, SIZES, FONT_STACKS } from '../canvas/constants.js';
import { listBrushes, renderBrushPreview } from '../canvas/engine.js';
import { PALETTES, normalizeHex } from './color.js';
import { colorPanel, swatchSections } from './color-picker.js';

const BRUSHES = listBrushes();
const brushesOf = tool => BRUSHES.filter(b => b.kind === tool);
const brushById = (tool, id) => brushesOf(tool).find(b => b.id === id) || null;
const DEFAULT_BRUSH = { pen: 'pen', highlighter: 'round' };
const PRESET_ROWS = { pen: [PALETTES.ink, PALETTES.pastel, PALETTES.deep], highlighter: [PALETTES.highlight, PALETTES.highlightSoft] };

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
  { id: 'hand', label: 'Handwriting', css: FONT_STACKS.hand, wide: true },
];
const SIZE_LABELS = ['Small', 'Medium', 'Large'];
const DOT_PX = [6, 10, 15];

function defaults() {
  return {
    active: 'pen',
    pen: { brush: DEFAULT_BRUSH.pen, color: INK_COLORS[0], size: SIZES.pen[1], memo: {} },
    highlighter: { brush: DEFAULT_BRUSH.highlighter, color: HIGHLIGHT_COLORS[0], size: SIZES.highlighter[1], memo: {} },
    eraser: { size: SIZES.eraser[1], eraseMode: 'stroke' },
    text: { color: INK_COLORS[0], size: SIZES.text[1], font: 'sans' },
  };
}

const isHex = c => /^#[0-9a-f]{6}$/i.test(c || '');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * createToolbar({saved, colors, getView, onInsertImage, onPersist})   colors = colorMemory(app) (saved + recent colours)
 * → {el, setActive(tool), applyTo(view), layout(), destroy()}
 * Pen and highlighter state: {brush, color, size, memo:{brushId:{color, size}}}; every brush remembers its own.
 */
export function createToolbar({ saved, colors, getView, onInsertImage, onPersist }) {
  const d = defaults();
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const state = {
    active: TOOLS.some(t => t.id === saved?.active && !t.action) ? saved.active : d.active,
    pen: { ...d.pen, ...obj(saved?.pen) },
    highlighter: { ...d.highlighter, ...obj(saved?.highlighter) },
    eraser: { ...d.eraser, ...obj(saved?.eraser) },
    text: { ...d.text, ...obj(saved?.text) },
  };
  if (state.eraser.eraseMode !== 'stroke' && state.eraser.eraseMode !== 'area') state.eraser.eraseMode = 'stroke';
  if (!(state.eraser.size > 0)) state.eraser.size = d.eraser.size;
  if (!['sans', 'round', 'serif', 'mono', 'hand'].includes(state.text.font)) state.text.font = 'sans';
  state.pen.color = normalizeHex(state.pen.color) || d.pen.color;
  state.highlighter.color = normalizeHex(state.highlighter.color) || d.highlighter.color;
  if (!isHex(state.text.color)) state.text.color = d.text.color;
  if (!(state.text.size >= 16)) state.text.size = d.text.size;
  for (const tool of ['pen', 'highlighter']) {
    const st = state[tool];
    if (!brushById(tool, st.brush)) st.brush = DEFAULT_BRUSH[tool];
    const cur = brushById(tool, st.brush);
    st.size = Number.isFinite(st.size) && st.size > 0 ? Math.min(cur.max, Math.max(cur.min, st.size)) : cur.size;
    const memo = {};
    const mm = st.memo && typeof st.memo === 'object' ? st.memo : {};
    for (const b of brushesOf(tool)) {
      const m = mm[b.id];
      if (m && isHex(m.color) && Number.isFinite(m.size) && m.size > 0) memo[b.id] = { color: m.color, size: Math.min(b.max, Math.max(b.min, m.size)) };
    }
    st.memo = memo;
    st.memo[st.brush] = { color: st.color, size: st.size };
  }
  /** The three quick dots: the most recent colours, topped up with the classic inks. */
  function quickColors() {
    const out = colors.recent().slice(0, 3);
    for (const c of [state.pen.color, INK_COLORS[0], INK_COLORS[1], INK_COLORS[2]]) {
      if (out.length >= 3) break;
      if (!out.some(r => same(r, c))) out.push(c);
    }
    return out;
  }
  let pop = null;

  const persist = debounce(() => onPersist({ tools: JSON.parse(JSON.stringify(state)) }), 500);

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
      [t.action ? 'onClick' : 'onFast']: () => onToolTap(t, b),
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
    for (const c of quickColors()) {
      quick.append(h('button', {
        type: 'button', class: `quick-dot ${swatchBorder(c)}`, 'aria-label': `Pen colour ${c}`,
        'aria-pressed': String(state.active === 'pen' && same(state.pen.color, c)),
        style: { '--sw': c },
        onFast: () => { setInk('pen', { color: c }); setActive('pen'); renderQuick(); },
      }));
    }
  }

  function syncPips() {
    pips.pen.style.background = state.pen.color;
    pips.pen.classList.toggle('tool-pip--light', luminance(state.pen.color) > 0.85);
    pips.highlighter.style.background = state.highlighter.color;
    for (const tool of ['pen', 'highlighter']) {
      const b = brushById(tool, state[tool].brush);
      const name = tool === 'pen' ? (b.id === 'pen' ? 'Pen' : `Pen: ${b.label}`) : `Highlighter: ${b.label}`;
      buttons[tool].setAttribute('aria-label', name);
      buttons[tool].title = name;
      buttons[tool].dataset.brush = b.id;
      pips[tool].classList.toggle('tool-pip--grain', ['pencil', 'mechanical', 'charcoal'].includes(b.id));
      pips[tool].classList.toggle('tool-pip--chisel', b.id === 'chisel');
    }
  }

  /** Change the pen's / highlighter's brush, colour or size (each brush keeps its own colour and size). */
  function setInk(tool, { brush, color, size }) {
    const st = state[tool];
    if (brush && brush !== st.brush && brushById(tool, brush)) {
      st.memo[st.brush] = { color: st.color, size: st.size };
      const b = brushById(tool, brush), m = st.memo[brush];
      st.brush = brush;
      st.color = m ? m.color : (b.color || st.color);
      st.size = m ? m.size : b.size;
    }
    if (color && isHex(color)) st.color = normalizeHex(color);
    if (size > 0) st.size = size;
    st.memo[st.brush] = { color: st.color, size: st.size };
    push(tool);
    syncPips();
    persist();
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
    else v.setToolOptions(tool, { brush: o.brush, color: o.color, size: o.size });
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
      void commit;
      sync();
      persist();
    };
    const btns = colors.map(c => h('button', {
      type: 'button', class: `swatch ${swatchBorder(c)}`, role: 'radio', 'aria-label': `Colour ${c}`, 'data-color': c,
      style: { '--sw': c }, onFast: () => pick(c),
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
      onFast: () => {
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
    const row = h('div', { class: `opt-seg ${options.some(o => o.wide) ? 'opt-seg--wrap' : ''}`, role: 'radiogroup', 'aria-label': label });
    const btns = options.map(o => h('button', {
      type: 'button', class: `opt-seg-btn ${o.wide ? 'opt-seg-btn--wide' : ''}`, role: 'radio', 'aria-checked': String(o.id === current),
      style: o.css ? { fontFamily: o.css } : null,
      onFast: () => { btns.forEach(b => b.setAttribute('aria-checked', String(b === btn(o)))); onPick(o.id); },
    }, o.label));
    const btn = o => btns[options.indexOf(o)];
    row.append(...btns);
    return row;
  }

  // ---------------------------------------------------------------- pen & highlighter options

  /** Brushes (live previews) · size (quick sizes + slider) · colour (presets, My colours, Recent, custom picker). */
  function inkOptions(tool) {
    const st = state[tool];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cleanup = [];
    const fmt = n => (n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n)));

    // -- brushes
    const cards = brushesOf(tool).map(b => {
      const cv = h('canvas', { class: 'brush-canvas', width: Math.round(76 * dpr), height: Math.round(44 * dpr), 'aria-hidden': 'true' });
      const card = h('button', {
        type: 'button', class: 'brush-card', role: 'radio', 'data-brush': b.id, 'aria-label': b.label,
        onFast: () => { setInk(tool, { brush: b.id }); syncAll(); card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); },
      }, cv, h('span', { class: 'brush-name' }, b.label));
      return { b, cv, card };
    });
    const brushRow = h('div', { class: 'brush-row', role: 'radiogroup', 'aria-label': 'Brush' }, cards.map(c => c.card));
    const dark = () => luminance(getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()) < 0.2;
    function paintBrushes() {
      const isDark = dark();
      for (const { b, cv, card } of cards) {
        const on = b.id === st.brush, m = st.memo[b.id];
        card.setAttribute('aria-checked', String(on));
        // On the popover (not on paper): near-black ink is shown light in dark mode, white ink dark in light mode.
        renderBrushPreview(cv, { tool, brush: b.id, color: on ? st.color : (m ? m.color : (b.color || st.color)), size: on ? st.size : (m ? m.size : b.size), dark: isDark, cssHeight: 44 });
      }
    }

    // -- size
    const quickBtns = [0, 1, 2].map(i => h('button', {
      type: 'button', class: 'size-btn', role: 'radio', 'aria-label': `${SIZE_LABELS[i]} size`,
      onFast: () => { setInk(tool, { size: brushById(tool, st.brush).sizes[i] }); syncSize(); paintBrushes(); },
    }, h('span', { class: 'size-dot', style: { width: `${DOT_PX[i]}px`, height: `${DOT_PX[i]}px` } })));
    const slider = h('input', { type: 'range', class: 'size-slider', 'aria-label': 'Size', min: '0', max: '1000', step: '1' });
    const dot = h('span', { class: 'size-preview-dot' });
    const value = h('span', { class: 'size-value' });
    // The slider is logarithmic: fine control over thin lines, still reaching the thick end.
    const toSize = t => { const b = brushById(tool, st.brush); return b.min * Math.pow(b.max / b.min, t); };
    const toT = sz => { const b = brushById(tool, st.brush); return Math.log(Math.min(b.max, Math.max(b.min, sz)) / b.min) / Math.log(b.max / b.min); };
    let paintQueued = 0;
    slider.addEventListener('input', () => {
      const sz = Math.round(toSize(slider.value / 1000) * 10) / 10;
      setInk(tool, { size: sz });
      syncSize(true);
      if (!paintQueued) paintQueued = requestAnimationFrame(() => { paintQueued = 0; paintBrushes(); });
    });
    function syncSize(fromSlider) {
      const b = brushById(tool, st.brush);
      if (!fromSlider) slider.value = String(Math.round(toT(st.size) * 1000));
      quickBtns.forEach((q, i) => q.setAttribute('aria-checked', String(Math.abs(b.sizes[i] - st.size) < 0.051)));
      const z = getView() ? getView().getZoom() : 1.4;
      const px = Math.max(1.5, Math.min(36, st.size * z));           // as wide as the line will be on the page right now
      dot.style.width = dot.style.height = `${px}px`;
      dot.style.background = st.color;
      dot.classList.toggle('size-preview-dot--light', luminance(st.color) > 0.85);
      value.textContent = fmt(st.size);
      slider.style.setProperty('--pos', `${toT(st.size) * 100}%`);
    }

    // -- colour
    const pick = (c, { commit = true } = {}) => {
      setInk(tool, { color: c });
      if (commit) colors.use(c);
      if (tool === 'pen') renderQuick();
      syncColor();
    };
    const sections = swatchSections({ rows: PRESET_ROWS[tool], memory: colors, get: () => st.color, pick: c => { pick(c); panel.set(c); } });
    const panel = colorPanel({ color: st.color, onInput: c => pick(c, { commit: false }), onCommit: c => pick(c) });
    const customBtn = h('button', { type: 'button', class: 'pal-custom', 'aria-expanded': 'false' },
      h('span', { class: 'pal-custom-wheel', 'aria-hidden': 'true' }), h('span', { class: 'pal-custom-label' }, 'Custom colour'), h('span', { class: 'pal-custom-chip' }));
    const colorBox = h('div', { class: 'opt-colors' }, sections.el, customBtn);
    let custom = false;
    fastTap(customBtn, () => {
      custom = !custom;
      customBtn.setAttribute('aria-expanded', String(custom));
      customBtn.querySelector('.pal-custom-label').textContent = custom ? 'Back to swatches' : 'Custom colour';
      if (custom) { panel.set(st.color); sections.el.replaceWith(panel.el); } else { panel.el.replaceWith(sections.el); sections.sync(); }
      if (pop) pop.reposition();
    });
    function syncColor(noPaint) {
      sections.sync();
      customBtn.querySelector('.pal-custom-chip').style.background = st.color;
      dot.style.background = st.color;
      dot.classList.toggle('size-preview-dot--light', luminance(st.color) > 0.85);
      if (!noPaint && !paintQueued) paintQueued = requestAnimationFrame(() => { paintQueued = 0; paintBrushes(); });
    }
    function syncAll() { paintBrushes(); syncSize(); syncColor(true); if (custom) panel.set(st.color); if (tool === 'pen') renderQuick(); }
    cleanup.push(() => sections.destroy(), () => cancelAnimationFrame(paintQueued), () => { for (const c of cards) c.cv.width = c.cv.height = 0; });

    const el = h('div', { class: 'opt opt--ink' },
      h('div', { class: 'opt-title' }, tool === 'pen' ? 'Pens & pencils' : 'Highlighters'),
      brushRow,
      h('div', { class: 'opt-size' }, h('div', { class: 'opt-sizes', role: 'radiogroup', 'aria-label': 'Quick sizes' }, quickBtns),
        h('div', { class: 'size-slide' }, slider, h('span', { class: 'size-preview' }, dot), value)),
      h('div', { class: 'opt-divider' }),
      colorBox);
    // The previews are painted right away (the popover scales in over them); the chosen brush is scrolled into view
    // once the popover has a layout.
    syncAll();
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const cur = cards.find(c => c.b.id === st.brush);
      if (cur) brushRow.scrollLeft = Math.max(0, cur.card.offsetLeft - (brushRow.clientWidth - cur.card.offsetWidth) / 2);
    });
    return { el, destroy: () => cleanup.forEach(fn => fn()) };
  }

  function openOptions(t, btn) {
    if (pop) { pop.close(); pop = null; }
    const title = txt => h('div', { class: 'opt-title' }, txt);
    let content, ink = null;
    if (t.id === 'pen' || t.id === 'highlighter') {
      ink = inkOptions(t.id);
      content = ink.el;
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
        h('div', { class: 'opt-note' }, 'Tap the page to add a text box. Tap with Apple Pencil to write: iPad turns your handwriting into neat text.'));
    } else return;
    pop = openPopover(btn, content, { className: 'popover--opts', label: `${t.label} options`, onClose: () => { pop = null; if (ink) ink.destroy(); } });
  }

  renderQuick();
  syncPips();
  const offColors = colors.onChange(renderQuick);
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
        else view.setToolOptions(tool, { brush: o.brush, color: o.color, size: o.size });
      }
      view.setTool(state.active);
      layout();
    },
    destroy() { ro.disconnect(); offColors(); persist.flush(); if (pop) pop.close(); },
  };
}
