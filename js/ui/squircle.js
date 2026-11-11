// Squircles: Figma-style smoothed corners applied as a clip-path.
// squircle(el, {radius, smoothing}) keeps the path in sync with the element's size (ResizeObserver).
// squircleAll(root) applies it to every [data-squircle="<radius>"] element, including ones added later.
// radius may be one number or four ("tl tr br bl"). Because clip-path cuts box-shadows, shadows live on a
// separate sibling/wrapper. Never use on glass (backdrop-filter) surfaces.

const registry = new WeakMap();   // el -> {radius:[4], smoothing}
const cache = new Map();          // key -> path string
const rad = d => (d * Math.PI) / 180;
const r2 = n => Math.round(n * 100) / 100;

function cornerParams(radius, smoothing, budget) {
  radius = Math.min(radius, budget);
  if (radius <= 0) return { a: 0, b: 0, c: 0, d: 0, p: 0, arc: 0, r: 0 };
  let s = Math.min(smoothing, budget / radius - 1);
  if (s < 0) s = 0;
  const p = Math.min((1 + s) * radius, budget);
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin(rad(arcMeasure / 2)) * radius * Math.SQRT2;
  const angleAlpha = (90 - arcMeasure) / 2;
  const p3ToP4 = radius * Math.tan(rad(angleAlpha / 2));
  const angleBeta = 45 * s;
  const c = p3ToP4 * Math.cos(rad(angleBeta));
  const d = c * Math.tan(rad(angleBeta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  return { a, b, c, d, p, arc, r: radius };
}

/** SVG path for a w×h rect with smoothed corners. radii = [tl, tr, br, bl]. */
export function squirclePath(w, h, radii, smoothing = 0.6) {
  const budget = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map(r => cornerParams(r, smoothing, budget));
  const f = (...n) => n.map(r2).join(' ');
  let d = `M ${f(w - tr.p, 0)}`;
  if (tr.r) d += ` c ${f(tr.a, 0, tr.a + tr.b, 0, tr.a + tr.b + tr.c, tr.d)} a ${f(tr.r, tr.r)} 0 0 1 ${f(tr.arc, tr.arc)} c ${f(tr.d, tr.c, tr.d, tr.b + tr.c, tr.d, tr.a + tr.b + tr.c)}`;
  d += ` L ${f(w, h - br.p)}`;
  if (br.r) d += ` c ${f(0, br.a, 0, br.a + br.b, -br.d, br.a + br.b + br.c)} a ${f(br.r, br.r)} 0 0 1 ${f(-br.arc, br.arc)} c ${f(-br.c, br.d, -(br.b + br.c), br.d, -(br.a + br.b + br.c), br.d)}`;
  d += ` L ${f(bl.p, h)}`;
  if (bl.r) d += ` c ${f(-bl.a, 0, -(bl.a + bl.b), 0, -(bl.a + bl.b + bl.c), -bl.d)} a ${f(bl.r, bl.r)} 0 0 1 ${f(-bl.arc, -bl.arc)} c ${f(-bl.d, -bl.c, -bl.d, -(bl.b + bl.c), -bl.d, -(bl.a + bl.b + bl.c))}`;
  d += ` L ${f(0, tl.p)}`;
  if (tl.r) d += ` c ${f(0, -tl.a, 0, -(tl.a + tl.b), tl.d, -(tl.a + tl.b + tl.c))} a ${f(tl.r, tl.r)} 0 0 1 ${f(tl.arc, -tl.arc)} c ${f(tl.c, -tl.d, tl.b + tl.c, -tl.d, tl.a + tl.b + tl.c, -tl.d)}`;
  return d + ' Z';
}

function parseRadius(v) {
  const nums = (Array.isArray(v) ? v : String(v).trim().split(/[\s,]+/)).map(Number).filter(n => !Number.isNaN(n));
  if (!nums.length) return [16, 16, 16, 16];
  if (nums.length === 1) return [nums[0], nums[0], nums[0], nums[0]];
  if (nums.length === 2) return [nums[0], nums[1], nums[0], nums[1]];
  if (nums.length === 3) return [nums[0], nums[1], nums[2], nums[1]];
  return nums.slice(0, 4);
}

function apply(el, w, h) {
  const o = registry.get(el);
  if (!o || w < 1 || h < 1) return;
  w = r2(w); h = r2(h);
  const key = `${w}|${h}|${o.radius.join(',')}|${o.smoothing}`;
  if (o.key === key) return;
  o.key = key;
  let path = cache.get(key);
  if (!path) {
    path = squirclePath(w, h, o.radius, o.smoothing);
    if (cache.size > 400) cache.clear();
    cache.set(key, path);
  }
  const value = `path('${path}')`;
  el.style.webkitClipPath = value;
  el.style.clipPath = value;
}

const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
  for (const e of entries) {
    const box = e.borderBoxSize && e.borderBoxSize[0];
    if (box) apply(e.target, box.inlineSize, box.blockSize);
    else apply(e.target, e.target.offsetWidth, e.target.offsetHeight);
  }
}) : null;

export function squircle(el, { radius = 16, smoothing = 0.6 } = {}) {
  if (!ro || !el) return el;
  registry.set(el, { radius: parseRadius(radius), smoothing, key: '' });
  ro.observe(el);
  if (el.offsetWidth) apply(el, el.offsetWidth, el.offsetHeight);
  return el;
}

export function unsquircle(el) {
  if (!ro || !el) return;
  ro.unobserve(el); registry.delete(el);
  el.style.clipPath = ''; el.style.webkitClipPath = '';
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.hasAttribute('data-squircle')) squircle(node, { radius: node.getAttribute('data-squircle') || 16 });
  if (node.firstElementChild) node.querySelectorAll('[data-squircle]').forEach(el => {
    squircle(el, { radius: el.getAttribute('data-squircle') || 16 });
  });
}

let mo = null;
export function squircleAll(root = document) {
  const base = root === document ? document.documentElement : root;
  scan(base);
  if (mo || typeof MutationObserver === 'undefined') return;
  mo = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        if (m.target.hasAttribute('data-squircle')) squircle(m.target, { radius: m.target.getAttribute('data-squircle') || 16 });
      } else {
        m.addedNodes.forEach(scan);
      }
    }
  });
  mo.observe(base, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-squircle'] });
}
