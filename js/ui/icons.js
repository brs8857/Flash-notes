// Inline SVG icons (drawn for Flash Notes; 24×24, stroke = currentColor).

function gearPath() {
  const teeth = 8, ro = 9.6, ri = 7.3, cx = 12, cy = 12;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const pts = [[ri, a - step * 0.28], [ro, a - step * 0.16], [ro, a + step * 0.16], [ri, a + step * 0.28]];
    pts.forEach(([r, ang], j) => {
      d += `${i === 0 && j === 0 ? 'M' : 'L'}${(cx + r * Math.cos(ang)).toFixed(2)} ${(cy + r * Math.sin(ang)).toFixed(2)}`;
    });
  }
  return d + 'Z';
}

const P = {
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  gear: `<path d="${gearPath()}" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.9"/>`,
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.500a5.500 5.500 0 0 0 0 11H13"/>',
  pages: '<rect x="4" y="4" width="6.800" height="6.800" rx="2"/><rect x="13.200" y="4" width="6.800" height="6.800" rx="2"/><rect x="4" y="13.200" width="6.800" height="6.800" rx="2"/><rect x="13.200" y="13.200" width="6.800" height="6.800" rx="2"/>',
  pen: '<path d="M4 20l1.100-4.600L16.400 4.100a2.050 2.050 0 0 1 2.900 0l.6.6a2.050 2.050 0 0 1 0 2.900L8.600 18.900 4 20z"/><path d="M14.300 6.200l3.500 3.500"/>',
  highlighter: '<path d="M14.200 3.800l6 6-8.200 8.200H8.800l-2.800-2.800v-3.200z"/><path d="M6.300 15.500L3.500 20.300h4.800l1.200-1.600"/><path d="M11 7l6 6"/>',
  eraser: '<path d="M8.600 19.500L3.900 14.800a1.800 1.800 0 0 1 0-2.550l8.100-8.100a1.800 1.800 0 0 1 2.550 0l5.700 5.700a1.800 1.800 0 0 1 0 2.550L13.100 19.500z"/><path d="M7.700 8.500l7.800 7.800"/><path d="M8.600 19.500H20.500"/>',
  lasso: '<ellipse cx="12" cy="9.800" rx="8.300" ry="5.800" stroke-dasharray="3.200 2.600"/><path d="M8.200 15c-2.300 1.300-1.900 4.300.9 5.300"/><circle cx="7.600" cy="14.800" r="1.500"/>',
  text: '<path d="M5 6.500V4.500h14v2"/><path d="M12 4.500v15"/><path d="M9 19.500h6"/>',
  image: '<rect x="3.500" y="5" width="17" height="14" rx="3"/><circle cx="8.800" cy="9.800" r="1.600"/><path d="M4 17l5-4.500 3.800 3.300 3.200-2.600 4.300 3.800"/>',
  hand: '<path d="M8 13V6.300a1.400 1.400 0 0 1 2.800 0V11"/><path d="M10.800 10.800V4.800a1.400 1.400 0 0 1 2.800 0v6"/><path d="M13.600 10.800V5.800a1.400 1.400 0 0 1 2.800 0v5.700"/><path d="M16.400 11.500V8.300a1.400 1.400 0 0 1 2.800 0v6.200c0 3.600-2.700 6.500-6.300 6.500h-1.100c-2.300 0-3.800-1-5.100-2.800l-2.400-3.500a1.450 1.450 0 0 1 2.300-1.750L8 14.600"/>',
  magnify: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/><path d="M11 8.500v5M8.500 11h5"/>',
  trash: '<path d="M5 7h14"/><path d="M10 4h4"/><path d="M7 7l.8 12a1.500 1.500 0 0 0 1.500 1.400h5.400a1.500 1.500 0 0 0 1.500-1.400L17 7"/><path d="M10 11v5.500M14 11v5.500"/>',
  copy: '<rect x="8.500" y="8.500" width="11.500" height="11.500" rx="2.800"/><path d="M5.500 15.500A1.500 1.500 0 0 1 4 14V6.500A2.500 2.500 0 0 1 6.500 4H14a1.500 1.500 0 0 1 1.500 1.500"/>',
  share: '<path d="M12 15V3.500"/><path d="M8 7l4-4 4 4"/><path d="M7 11H6a2 2 0 0 0-2 2v5.500a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V13a2 2 0 0 0-2-2h-1"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  close: '<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>',
  book: '<path d="M5 5.500a2 2 0 0 1 2-2h10.500a1.500 1.500 0 0 1 1.500 1.500v15.500H7.500a2.500 2.500 0 0 1 0-5H19"/><path d="M9 3.500v12"/>',
  board: '<rect x="3.500" y="4.500" width="17" height="12.500" rx="2.500"/><path d="M8 20.500h8"/><path d="M7.500 13l3-3.500 2.500 2 3.500-3.800"/>',
  paper: '<path d="M7 3.500h7l4.500 4.500v11a1.500 1.500 0 0 1-1.500 1.500H7A1.500 1.500 0 0 1 5.500 19V5A1.500 1.500 0 0 1 7 3.500z"/><path d="M9 12h6M9 15.500h6"/>',
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19.500h14"/>',
  upload: '<path d="M12 15.500V4"/><path d="M8 8l4-4 4 4"/><path d="M5 19.500h14"/>',
  shield: '<path d="M12 3.500l7 2.500v5.500c0 4.300-2.900 7.600-7 9-4.100-1.400-7-4.700-7-9V6z"/><path d="M9 12l2.200 2.200L15 10.400"/>',
  fit: '<path d="M4 9V6a2 2 0 0 1 2-2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M9 20H6a2 2 0 0 1-2-2v-3"/>',
  arrowUp: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
  addHome: '<rect x="4" y="4" width="16" height="16" rx="4.500"/><path d="M12 8.500v7M8.500 12h7"/>',
  pdf: '<path d="M7 3.500h7l4.500 4.500v11a1.500 1.500 0 0 1-1.500 1.500H7A1.500 1.500 0 0 1 5.500 19V5A1.500 1.500 0 0 1 7 3.500z"/><path d="M14 3.500V8h4.500"/>',
  pencilOnly: '<path d="M5 19l.9-3.900L15.600 5.400a1.900 1.900 0 0 1 2.700 0l.3.3a1.900 1.900 0 0 1 0 2.700L8.900 18.100 5 19z"/><path d="M3.500 4.500l17 17" opacity=".0"/><circle cx="18.500" cy="18" r="2.600"/><path d="M16.700 19.800l3.600-3.600"/>',
  sparkle: '<path d="M12 4l1.700 4.800L18.500 10.500l-4.800 1.700L12 17l-1.700-4.800L5.500 10.500l4.800-1.700z"/><path d="M18.500 16.500v3M17 18h3"/>',
  sun: '<circle cx="12" cy="12" r="3.800"/><path d="M12 3.500v2M12 18.500v2M3.500 12h2M18.500 12h2M6 6l1.400 1.400M16.600 16.600L18 18M18 6l-1.400 1.400M7.400 16.600L6 18"/>',
  info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500"/><circle cx="12" cy="7.800" r=".6" fill="currentColor"/>',
};

export function icon(name, size = 22, strokeWidth = 1.9) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
  return tpl.content.firstChild;
}
