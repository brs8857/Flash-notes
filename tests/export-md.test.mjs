// Markdown export: content, ordering and escaping. Pure Node.   node tests/export-md.test.mjs
import { ok, eq, done } from './lib/check.mjs';
import { mdEscape, notesToMarkdown } from '../js/export-md.js';

const text = (t, x = 0, y = 0) => ({ id: 'i' + Math.random(), type: 'text', x, y, text: t });
const stroke = () => ({ id: 's' + Math.random(), type: 'stroke', points: [[0, 0, 1]] });
const image = () => ({ id: 'm' + Math.random(), type: 'image', src: 'data:image/png;base64,AAAA' });

// ---------------------------------------------------------------- escaping
eq(mdEscape('<script>alert(1)</script>'), '&lt;script&gt;alert\\(1\\)&lt;/script&gt;', 'HTML is neutralised');
eq(mdEscape('[click](javascript:alert(1))'), '\\[click\\]\\(javascript:alert\\(1\\)\\)', 'links cannot be created');
eq(mdEscape('![x](http://t.example/p.png)'), '\\!\\[x\\]\\(http://t\\.example/p\\.png\\)', 'remote images cannot be created');
eq(mdEscape('# not a heading'), '\\# not a heading', 'headings cannot be created');
eq(mdEscape('**bold** _it_ `code` ~~x~~'), '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~x\\~\\~', 'emphasis and code are literal');
eq(mdEscape('a | b'), 'a \\| b', 'table pipes are literal');
eq(mdEscape('1. one - two + three'), '1\\. one \\- two \\+ three', 'lists cannot be created');
eq(mdEscape('back\\slash'), 'back\\\\slash', 'backslashes are escaped first');
eq(mdEscape('AT&T &lt;'), 'AT&amp;T &amp;lt;', 'ampersands are escaped, so entities stay literal');
eq(mdEscape('a\u0000b\u0007c'), 'abc', 'control characters are removed');
eq(mdEscape(null), '', 'null is empty');
eq(mdEscape(42), '42', 'numbers are text');

// ---------------------------------------------------------------- document
const md = notesToMarkdown([
  { doc: { kind: 'notebook', title: 'Maths\n# Injected <b>title</b>' }, pages: [
    { items: [text('second (lower)', 0, 200), text('first (higher)', 0, 10), text('same row, right', 300, 10), stroke(), stroke(), image()] },
    { items: [] },
    { items: [stroke()] },
    { items: [text('line one\nline two\n    indented <img src=x onerror=alert(1)>\n> quote?')] },
  ] },
  { doc: { kind: 'whiteboard', title: '' }, pages: [{ items: [text('   '), text('board text')] }] },
], { exportedAt: Date.UTC(2026, 10, 12) });

ok(md.startsWith('# Flash Notes export\n'), 'starts with a title');
ok(md.includes('Exported 2026-11-12.'), 'has the export date');
ok(/Handwriting, shapes, highlighter and pictures cannot be written as Markdown/.test(md), 'says what is not included');
ok(md.includes('## Maths \\# Injected &lt;b&gt;title&lt;/b&gt;\n'), 'a notebook title is one escaped heading line (no injected heading or HTML)');
eq(md.split('\n').filter(l => /^#{1,6} /.test(l)), ['# Flash Notes export', '## Maths \\# Injected &lt;b&gt;title&lt;/b&gt;', '### Page 1', '### Page 2', '### Page 3', '### Page 4', '## Untitled'], 'the only headings are the ones the exporter wrote');
ok(md.indexOf('first \\(higher\\)') < md.indexOf('same row, right') && md.indexOf('same row, right') < md.indexOf('second \\(lower\\)'), 'text boxes are ordered top to bottom, then left to right');
ok(md.includes('_Not included: 2 handwriting strokes and 1 picture._'), 'strokes and pictures are counted, not exported');
ok(md.includes('### Page 2\n\n_Empty page._'), 'an empty page is marked');
ok(md.includes('### Page 3\n\n_Not included: 1 handwriting stroke._'), 'singular wording');
ok(md.includes('line one  \nline two  \n'), 'line breaks inside a text box are kept');
ok(md.includes('&lt;img src=x onerror=alert\\(1\\)&gt;') && !/<img|<b>|<script/i.test(md), 'no raw HTML anywhere in the output');
ok(!/^ {4}/m.test(md), 'no line can become a code block');
ok(!/^\t| {4}/m.test(notesToMarkdown([{ doc: { kind: 'whiteboard', title: 't' }, pages: [{ items: [text('\tTabbed <b>\n\t\t  deeper')] }] }]).split('\n').slice(4).join('\n')), 'tab-indented text cannot become a code block either');
ok(md.includes('&gt; quote?') && !/^>/m.test(md), 'no line can become a block quote');
ok(md.includes('_Whiteboard_') && md.includes('board text') && !md.includes('### Page 1\n\nboard'), 'whiteboards have no page headings');
ok(!md.includes('data:image'), 'image data never leaks into Markdown');
ok(md.endsWith('\n') && !/\n{3,}/.test(md), 'tidy spacing');
eq(notesToMarkdown([]).includes('_No notebooks yet._'), true, 'an empty library exports a valid document');
ok(notesToMarkdown([{ doc: null, pages: [{ items: 'junk' }, null] }]).includes('## Untitled'), 'malformed input does not throw');

done('export-md');
