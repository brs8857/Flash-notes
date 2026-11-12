// Colour picker: saturation/brightness square + hue slider + hex field, built on Pointer Events so it
// works the same with a finger, Apple Pencil and a mouse (Safari's <input type=color> is not used).
// Also: the shared memory of saved ("My colours") and recent colours, the swatch sections built on it, and
// a stand-alone popover used by the lasso menu's "More…".
import { h, clear, clamp, luminance, fastTap } from './dom.js';
import { icon } from './icons.js';
import { openPopover } from './menu.js';
import { toast } from './toast.js';
import { normalizeHex, hexToHsv, hsvToHex, sameColor, pushRecent, addSaved, removeSaved, PALETTES } from './color.js';

const MAX_SAVED = 24, MAX_RECENT = 8, LONG_PRESS_MS = 480;

export function swatchClass(c) { return luminance(c) > 0.85 ? 'swatch--light' : (luminance(c) < 0.03 ? 'swatch--dark' : ''); }

/**
 * Saved + recent colours, kept in settings (`customColors`, `recentColors`) and shared by every picker.
 * colorMemory(app) → {recent(), saved(), use(color), save(color) → bool, remove(color), onChange(fn) → off}
 */
export function colorMemory(app) {
  // Settings can hold anything (older versions, a hand-edited backup): keep valid, distinct colours only.
  const list = (v, max) => [...new Set((Array.isArray(v) ? v.slice(0, 400) : []).map(normalizeHex).filter(Boolean))].slice(0, max);
  let recent = list(app.settings.recentColors, MAX_RECENT);
  let saved = list(app.settings.customColors, MAX_SAVED);
  const subs = new Set();
  const emit = () => subs.forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });
  return {
    recent: () => recent.slice(),
    saved: () => saved.slice(),
    /** A colour was chosen for drawing: remember it as recent. */
    use(color) {
      const next = pushRecent(recent, color, MAX_RECENT);
      if (next.join() === recent.join()) return;
      recent = next;
      app.updateSettings({ recentColors: recent });
      emit();
    },
    save(color) {
      const c = normalizeHex(color);
      if (!c || saved.includes(c)) return false;
      saved = addSaved(saved, c, MAX_SAVED);
      app.updateSettings({ customColors: saved });
      emit();
      return true;
    },
    remove(color) {
      saved = removeSaved(saved, color);
      app.updateSettings({ customColors: saved });
      emit();
    },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/**
 * The picker itself. colorPanel({color, onInput(hex), onCommit(hex)}) → {el, set(hex), get()}
 * onInput fires while dragging, onCommit when the finger lifts or a hex code is entered.
 */
export function colorPanel({ color, onInput, onCommit }) {
  let hsv = hexToHsv(color) || { h: 220, s: 0.7, v: 0.9 };
  let hex = hsvToHex(hsv);

  const svKnob = h('span', { class: 'cp-knob' });
  const sv = h('div', { class: 'cp-sv', role: 'slider', tabIndex: 0, 'aria-label': 'Saturation and brightness', 'data-squircle': '14' },
    h('span', { class: 'cp-sv-white' }), h('span', { class: 'cp-sv-black' }), svKnob);
  const hueKnob = h('span', { class: 'cp-knob cp-knob--hue' });
  const hue = h('div', { class: 'cp-hue', role: 'slider', tabIndex: 0, 'aria-label': 'Hue', 'aria-valuemin': '0', 'aria-valuemax': '360' }, hueKnob);
  const chip = h('span', { class: 'cp-chip' });
  const field = h('input', {
    class: 'cp-hex', type: 'text', value: hex, maxlength: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters',
    'aria-label': 'Hex colour code', enterkeyhint: 'done',
  });

  function paint(fromField) {
    hex = hsvToHex(hsv);
    sv.style.setProperty('--cp-hue', `hsl(${Math.round(hsv.h)}, 100%, 50%)`);
    svKnob.style.left = `${hsv.s * 100}%`;
    svKnob.style.top = `${(1 - hsv.v) * 100}%`;
    svKnob.style.background = hex;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    hueKnob.style.background = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;
    hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    sv.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    chip.style.background = hex;
    if (!fromField) field.value = hex;
  }

  /** Drag handling shared by the square and the hue bar. The rect is measured once per drag. */
  function drag(el, apply) {
    let rect = null, id = null;
    const at = (e) => apply(clamp((e.clientX - rect.left) / rect.width, 0, 1), clamp((e.clientY - rect.top) / rect.height, 0, 1));
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault();
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae.matches && ae.matches('input, textarea') && ae !== el) ae.blur();   // preventDefault keeps focus: close the keyboard by hand
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;      // not laid out (zero size): a division by zero would turn the colour to NaN
      id = e.pointerId;
      rect = r;
      try { el.setPointerCapture(id); } catch { /* synthetic pointer */ }
      el.classList.add('is-dragging');
      at(e); paint(); onInput && onInput(hex);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      e.preventDefault();
      at(e); paint(); onInput && onInput(hex);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('is-dragging');
      onCommit && onCommit(hex);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);     // capture taken away without an up event: never stay "dragging"
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });   // no scroll / callout while dragging
  }
  drag(sv, (x, y) => { hsv = { h: hsv.h, s: x, v: 1 - y }; });
  drag(hue, (x) => { hsv = { ...hsv, h: Math.min(359.9, x * 360) }; });

  let nudgeT = 0;
  const nudge = (e, fn) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    fn(d[0], d[1]); paint(); onInput && onInput(hex);
    clearTimeout(nudgeT);     // one "recent colour" per burst of key presses, not one per press
    nudgeT = setTimeout(() => onCommit && onCommit(hex), 600);
  };
  sv.addEventListener('keydown', (e) => nudge(e, (dx, dy) => { hsv = { h: hsv.h, s: clamp(hsv.s + dx * 0.02, 0, 1), v: clamp(hsv.v + dy * 0.02, 0, 1) }; }));
  hue.addEventListener('keydown', (e) => nudge(e, (dx, dy) => { hsv = { ...hsv, h: clamp(hsv.h + (dx + dy) * 3, 0, 359.9) }; }));

  field.addEventListener('input', () => {
    const c = normalizeHex(field.value);
    field.classList.toggle('is-invalid', !c && field.value.replace('#', '').length >= 6);
    if (!c || field.value.replace('#', '').length < 6) return;
    hsv = hexToHsv(c); paint(true); onInput && onInput(hex);
  });
  const commitField = () => {
    const c = normalizeHex(field.value);
    field.classList.remove('is-invalid');
    if (!c) { field.value = hex; return; }
    hsv = hexToHsv(c); paint(); onCommit && onCommit(hex);
  };
  field.addEventListener('change', commitField);
  field.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); field.blur(); } });

  const el = h('div', { class: 'cp' }, sv, hue, h('div', { class: 'cp-row' }, chip, field));
  paint();
  return {
    el,
    get: () => hex,
    set(c) { const n = hexToHsv(c); if (!n) return; hsv = n.s === 0 ? { ...n, h: hsv.h } : n; paint(); },
  };
}

/**
 * Swatch sections under a tool's colour: preset rows, "My colours" (saved; long-press to remove, + to
 * save the current colour) and "Recent". swatchSections({rows, memory, get, pick}) → {el, sync(), destroy()}
 */
export function swatchSections({ rows, memory, get, pick }) {
  const el = h('div', { class: 'pal' });
  const presets = h('div', { class: 'pal-grid', role: 'radiogroup', 'aria-label': 'Colour' });
  const savedRow = h('div', { class: 'pal-grid', role: 'group', 'aria-label': 'My colours' });
  const recentRow = h('div', { class: 'pal-grid', role: 'group', 'aria-label': 'Recent colours' });
  const recentLabel = h('div', { class: 'pal-label' }, 'Recent');
  const hint = h('span', { class: 'pal-hint' }, 'hold to remove');

  function swatch(c, { removable = false } = {}) {
    const b = h('button', {
      type: 'button', class: `swatch ${swatchClass(c)}`, role: 'radio', 'aria-label': `Colour ${c}`, 'data-color': c, title: c,
      style: { '--sw': c },
    });
    let timer = 0, held = false;
    // "My colours" swatches also react to a long press, so they pick on lift; the others pick on touch.
    fastTap(b, () => { if (held) { held = false; return; } pick(c); }, { deferred: removable });
    if (removable) {
      const remove = () => { held = true; memory.remove(c); toast('Colour removed', { icon: 'check', duration: 1600 }); };
      b.addEventListener('pointerdown', () => { held = false; clearTimeout(timer); timer = setTimeout(remove, LONG_PRESS_MS); });
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(t, () => clearTimeout(timer));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(timer); if (!held) remove(); });
    }
    return b;
  }

  for (const row of rows) for (const c of row) presets.append(swatch(c));

  function renderMemory() {
    clear(savedRow);
    const saved = memory.saved();
    for (const c of saved) savedRow.append(swatch(c, { removable: true }));
    savedRow.append(h('button', {
      type: 'button', class: 'swatch swatch--add', 'aria-label': 'Save this colour to My colours', title: 'Save this colour',
      onClick: () => {
        const c = get();
        if (saved.length >= MAX_SAVED && !saved.some((s) => sameColor(s, c))) toast('My colours is full. Hold one to remove it first.', { icon: 'info' });
        else if (!memory.save(c)) toast('That colour is already saved', { icon: 'check', duration: 1600 });
      },
    }, icon('plus', 18, 2.4)));
    hint.hidden = !saved.length;
    clear(recentRow);
    const recent = memory.recent();
    for (const c of recent) recentRow.append(swatch(c));
    recentLabel.hidden = recentRow.hidden = !recent.length;
    sync();
  }

  function sync() {
    const cur = get();
    for (const b of el.querySelectorAll('.swatch[data-color]')) b.setAttribute('aria-checked', String(sameColor(b.dataset.color, cur)));
  }

  el.append(presets, h('div', { class: 'pal-label' }, 'My colours', hint), savedRow, recentLabel, recentRow);
  renderMemory();
  const off = memory.onChange(renderMemory);
  return { el, sync, destroy: off };
}

/**
 * Stand-alone picker popover (lasso menu → Colour → More…).
 * openColorPicker(anchor, {color, memory, title, onPick(hex)}) — onPick fires for every committed choice.
 */
export function openColorPicker(anchor, { color, memory, title = 'Colour', onPick }) {
  let cur = normalizeHex(color) || '#1C1C1E';
  let sections = null;
  const choose = (c) => { cur = c; panel.set(c); sections.sync(); memory.use(c); onPick(c); };
  const panel = colorPanel({ color: cur, onInput: (c) => { cur = c; sections && sections.sync(); }, onCommit: (c) => { cur = c; memory.use(c); onPick(c); } });
  sections = swatchSections({ rows: [PALETTES.ink, PALETTES.pastel, PALETTES.deep], memory, get: () => cur, pick: choose });
  const content = h('div', { class: 'opt opt--ink opt--picker' }, h('div', { class: 'opt-title' }, title), panel.el, h('div', { class: 'opt-divider' }), sections.el);
  const pop = openPopover(anchor, content, { className: 'popover--opts', label: title, placement: 'top', onClose: () => sections.destroy() });
  return pop;
}
