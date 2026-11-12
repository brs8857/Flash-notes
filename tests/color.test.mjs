// Node tests for the colour maths (js/ui/color.js) and the brush table (js/canvas/brushes.js).
//   node tests/color.test.mjs
import assert from 'node:assert/strict';
import * as C from '../js/ui/color.js';
import * as B from '../js/canvas/brushes.js';
import { normalizeItems } from '../js/canvas/items.js';
import { strokeBBox, eraseFromStroke } from '../js/canvas/strokes.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok  ', name); };

ok('normalizeHex', () => {
  assert.equal(C.normalizeHex('#abc'), '#AABBCC');
  assert.equal(C.normalizeHex('1c1c1e'), '#1C1C1E');
  assert.equal(C.normalizeHex(' #FFE066 '), '#FFE066');
  for (const bad of ['', '#12', '#12345', 'zzzzzz', '#1234567', null, undefined, 'rgb(1,2,3)']) assert.equal(C.normalizeHex(bad), null);
});

ok('known conversions', () => {
  assert.deepEqual(C.hexToRgb('#3B5BDB'), { r: 59, g: 91, b: 219 });
  assert.deepEqual(C.rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, v: 1 });
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 255, b: 0 }), { h: 120, s: 1, v: 1 });
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 0, b: 255 }), { h: 240, s: 1, v: 1 });
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });
  assert.deepEqual(C.rgbToHsv({ r: 255, g: 255, b: 255 }), { h: 0, s: 0, v: 1 });
  assert.equal(C.hsvToHex({ h: 60, s: 1, v: 1 }), '#FFFF00');
  assert.equal(C.hsvToHex({ h: 300, s: 1, v: 0.5 }), '#800080');
  assert.equal(C.hsvToHex({ h: 360, s: 1, v: 1 }), '#FF0000');
  assert.equal(C.hsvToHex({ h: -120, s: 1, v: 1 }), '#0000FF');
  assert.equal(C.hsvToHex({ h: 10, s: 2, v: 9 }), C.hsvToHex({ h: 10, s: 1, v: 1 }));
});

ok('hex → HSV → hex round-trips exactly for every palette colour and a colour-cube sweep', () => {
  const all = Object.values(C.PALETTES).flat();
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 51) all.push(C.rgbToHex({ r, g, b }));
  for (const hex of all) assert.equal(C.hsvToHex(C.hexToHsv(hex)), C.normalizeHex(hex), hex);
});

ok('palettes: 8 valid, distinct colours per row; engine colours are all present', () => {
  for (const [name, row] of Object.entries(C.PALETTES)) {
    assert.equal(row.length, 8, name);
    assert.equal(new Set(row.map(C.normalizeHex)).size, 8, name);
    for (const c of row) assert.ok(C.normalizeHex(c), c);
  }
});

ok('recent and saved colours', () => {
  let r = [];
  for (const c of ['#111111', '#222222', '#111111', '#abc']) r = C.pushRecent(r, c);
  assert.deepEqual(r, ['#AABBCC', '#111111', '#222222']);
  for (let i = 0; i < 20; i++) r = C.pushRecent(r, '#0000' + (10 + i));
  assert.equal(r.length, 8);
  assert.deepEqual(C.pushRecent(r, 'nope'), r);
  let s = [];
  for (let i = 0; i < 30; i++) s = C.addSaved(s, '#00' + (10 + i) + '00');
  assert.equal(s.length, 24);
  assert.equal(s[23], '#003900');
  assert.equal(C.addSaved(s, '#003900').length, 24);
  assert.equal(C.removeSaved(s, '#003900').length, 23);
});

ok('brush table', () => {
  const ids = new Set();
  const pens = B.BRUSHES.filter((b) => b.kind === 'pen'), hls = B.BRUSHES.filter((b) => b.kind === 'highlighter');
  assert.ok(pens.length >= 8 && pens.length <= 9, 'pens');
  assert.equal(hls.length, 3);
  for (const b of B.BRUSHES) {
    assert.ok(!ids.has(b.id), 'duplicate ' + b.id); ids.add(b.id);
    assert.ok(b.label && b.min > 0 && b.min <= b.size && b.size <= b.max, b.id + ' size range');
    assert.equal(b.sizes.length, 3);
    for (const s of b.sizes) assert.ok(s >= b.min && s <= b.max, b.id + ' quick size');
    assert.ok(b.sizes[0] < b.sizes[1] && b.sizes[1] < b.sizes[2]);
    assert.ok(b.alpha > 0 && b.alpha <= 1);
    if (b.grain) assert.ok(B.GRAINS[b.grain], b.id + ' grain');
    if (b.kind === 'pen') {
      const o = B.freehandOptions(b, 4, true, false);
      assert.ok(o.streamline <= B.freehandOptions(b, 4, false, false).streamline, b.id + ': fingers get no more smoothing than Pencil');
      assert.ok(o.thinning >= 0 && o.thinning < 1 && o.simulatePressure === true);
    }
  }
  assert.equal(B.getBrush('pencil', 'pen').id, 'pencil');
  assert.equal(B.getBrush('pencil', 'highlighter'), null);
  assert.equal(B.getBrush('chisel', 'pen'), null);
  assert.equal(B.getBrush('nope'), null);
  assert.deepEqual(B.listBrushes().map((b) => b.id), B.BRUSHES.map((b) => b.id));
});

ok('strokes without a brush keep the v1.1 parameters', () => {
  const pen = B.brushOf({ tool: 'pen' }), hl = B.brushOf({ tool: 'highlighter' });
  assert.deepEqual(B.freehandOptions(pen, 3, true, true), { size: 3, thinning: 0.6, smoothing: 0.5, streamline: 0.45, simulatePressure: true, last: true });
  assert.deepEqual(B.freehandOptions(pen, 3, false, true), { size: 3, thinning: 0.6, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last: true });
  assert.equal(pen.alpha, 1); assert.equal(pen.grain, null);
  assert.equal(hl.tip, 'round'); assert.equal(hl.alpha, 0.45);
  assert.equal(B.brushOf({ tool: 'pen', brush: 'chisel' }), pen);          // a highlighter brush on a pen stroke is ignored
  assert.deepEqual(strokeBBox({ tool: 'pen', size: 4, points: [[10, 10, 0.5]] }), [6.1, 6.1, 13.9, 13.9]);
  assert.deepEqual(strokeBBox({ tool: 'highlighter', size: 20, points: [[10, 10, 0.5]] }), [-0.5, -0.5, 20.5, 20.5]);
});

ok('opacity: pressure makes pencils darker, fingers get the plain brush opacity', () => {
  const p = B.getBrush('pencil');
  assert.ok(B.strokeOpacity(p, 0.1, false) < B.strokeOpacity(p, 0.5, false));
  assert.ok(B.strokeOpacity(p, 0.5, false) < B.strokeOpacity(p, 0.9, false));
  assert.equal(B.strokeOpacity(p, 0.1, true), p.alpha);
  assert.equal(B.strokeOpacity(B.getBrush('fineliner'), 0.1, false), 1);
  assert.equal(B.tintColor('#000000', 0.5), '#808080');
  assert.equal(B.tintColor('#FF0000', 0), '#FF0000');
});

ok('grain: seamless tile, values in range, deterministic', () => {
  for (const [id, g] of Object.entries(B.GRAINS)) {
    assert.ok(Number.isInteger(g.period * g.cells[0]) && Number.isInteger(g.period * g.cells[1]), id + ' lattice');
    let sum = 0, cnt = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i * 0.731) % g.period, y = (i * 1.377) % g.period;
      const a = B.grainAlpha(g, x, y);
      assert.ok(a >= g.floor - 1e-9 && a <= 1 + 1e-9);
      assert.ok(Math.abs(a - B.grainAlpha(g, x + g.period, y - 2 * g.period)) < 1e-6, id + ' periodic');
      assert.equal(a, B.grainAlpha(g, x, y));
      sum += a; cnt++;
    }
    const mean = sum / cnt;
    assert.ok(mean > 0.35 && mean < 0.97, `${id} mean coverage ${mean.toFixed(2)}`);
    assert.ok([32, 64, 128, 256, 512].includes(B.grainResolution(g, 2.8)));
    assert.ok(B.grainResolution(g, 40) <= 512);
  }
});

ok('brush id survives normalizeItems and the precise eraser; unknown ids are dropped', () => {
  const pts = Array.from({ length: 30 }, (_, i) => [10 + i * 4, 50, 0.5]);
  const raw = [
    { id: 'a', type: 'stroke', tool: 'pen', brush: 'pencil', color: '#1C1C1E', size: 3, points: pts },
    { id: 'b', type: 'stroke', tool: 'highlighter', brush: 'chisel', color: '#FFE066', size: 20, points: pts },
    { id: 'c', type: 'stroke', tool: 'pen', brush: 'chisel', color: '#1C1C1E', size: 3, points: pts },
    { id: 'd', type: 'stroke', tool: 'pen', brush: 'from-the-future', color: '#1C1C1E', size: 3, points: pts },
    { id: 'e', type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, points: pts },
    { id: 'f', type: 'stroke', tool: 'pen', brush: 'marker', uniform: true, shape: { kind: 'line' }, color: '#1C1C1E', size: 7, points: [[0, 0, 0.5], [50, 0, 0.5]] },
  ];
  const out = normalizeItems(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(out.map((it) => it.brush), ['pencil', 'chisel', undefined, undefined, undefined, 'marker']);
  assert.ok(!('brush' in out[4]));
  assert.equal(out[5].uniform, true);
  const pieces = eraseFromStroke(out[0], 60, 40, 60, 60, 4);
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.equal(p.brush, 'pencil');
  // the brush pen reaches further from its centre line than the classic pen
  const bb = strokeBBox({ tool: 'pen', brush: 'brush', size: 10, points: [[0, 0, 0.5]] });
  assert.ok(bb[2] >= 9.5);
});

console.log(`\ncolor + brushes: all ${n} checks passed`);
