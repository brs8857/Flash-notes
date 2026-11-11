// Minimal pure-JS PDF writer: one A4 page per JPEG (no print dialog, works offline and in iOS standalone).
// buildPdf([{blob, w, h}]) → Promise<Blob>. JPEG bytes are embedded as-is (/DCTDecode), so memory stays low.

const A4_W = 595.28, A4_H = 841.89;
const n2 = v => (Math.round(v * 100) / 100).toString();

export async function buildPdf(images) {
  if (!images || !images.length) throw new Error('Nothing to export');
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];       // byte offset of each object, index = object number
  let offset = 0;

  const push = data => {
    const part = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(part);
    offset += part instanceof Blob ? part.size : part.byteLength;   // BYTE lengths, never string lengths
  };
  const obj = (num, body) => { offsets[num] = offset; push(`${num} 0 obj\n${body}\nendobj\n`); };

  // Header + binary marker (tells tools the file contains binary data).
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  const count = images.length;
  const pageObj = i => 3 + i * 3, contentObj = i => 4 + i * 3, imageObj = i => 5 + i * 3;
  const total = 2 + count * 3;

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${count} /Kids [${images.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);

  images.forEach((img, i) => {
    const k = Math.min(A4_W / img.w, A4_H / img.h);
    const dw = img.w * k, dh = img.h * k;
    const dx = (A4_W - dw) / 2, dy = (A4_H - dh) / 2;
    const content = `q ${n2(dw)} 0 0 ${n2(dh)} ${n2(dx)} ${n2(dy)} cm /Im0 Do Q`;
    const contentBytes = enc.encode(content);

    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] ` +
      `/Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contentObj(i)} 0 R >>`);

    offsets[contentObj(i)] = offset;
    push(`${contentObj(i)} 0 obj\n<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    push(contentBytes);
    push('\nendstream\nendobj\n');

    offsets[imageObj(i)] = offset;
    push(`${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.blob.size} >>\nstream\n`);
    push(img.blob);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
