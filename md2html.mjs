/**
 * MANUAL.md -> MANUAL.html, styled for print. Tiny markdown subset, no dependencies.
 *
 *   node md2html.mjs [input.md] [output.html]
 *
 * Print to PDF from a browser (headless Chrome: `page.pdf({format:'A4'})`).
 * Handles: headings, tables, fenced code, inline code, bold, links, hr, quotes, lists.
 */
import { readFile, writeFile } from 'node:fs/promises';

const [, , srcPath = 'MANUAL.md', outPath = 'MANUAL.html'] = process.argv;
const src = await readFile(srcPath, 'utf8');
const lines = src.replace(/\r\n/g, '\n').split('\n');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return out;
}

const splitRow = (line) =>
  line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const html = [];
let i = 0;
let para = [];

const flush = () => {
  if (para.length) {
    html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  }
};

while (i < lines.length) {
  const line = lines[i];

  if (/^```/.test(line)) {
    flush();
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++;
    html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    continue;
  }

  if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
    flush();
    const head = splitRow(line);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
    html.push(
      `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table>',
    );
    continue;
  }

  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    flush();
    const lvl = h[1].length;
    const id = h[2].toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    html.push(`<h${lvl} id="${id}">${inline(h[2])}</h${lvl}>`);
    i++;
    continue;
  }

  if (/^\s*---+\s*$/.test(line)) { flush(); html.push('<hr>'); i++; continue; }

  if (/^\s*>\s?/.test(line)) {
    flush();
    const buf = [];
    while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
    html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    continue;
  }

  if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
    flush();
    const ordered = /^\s*\d+\./.test(line);
    const items = [];
    while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      let text = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '');
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        text += ' ' + lines[i++].trim();
      }
      items.push(`<li>${inline(text)}</li>`);
    }
    html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    continue;
  }

  if (!line.trim()) { flush(); i++; continue; }

  para.push(line.trim());
  i++;
}
flush();

const doc = `<!doctype html>
<meta charset="utf-8">
<title>CORPORATION 001 — Manual</title>
<style>
  @page { size: A4; margin: 19mm 16mm 17mm; }
  :root{ --ink:#17161a; --dim:#5d5a55; --rule:#d9d4c9; --accent:#8a2f35; --code:#f4f1ea; }
  *{ box-sizing:border-box; }
  body{
    margin:0; color:var(--ink); background:#fdfcfa;
    font:10.6pt/1.55 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
    -webkit-font-smoothing:antialiased;
  }
  h1,h2,h3,h4{ font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; letter-spacing:-.01em; page-break-after:avoid; }
  h1{ font-size:23pt; margin:0 0 4pt; letter-spacing:-.02em; }
  h2{ font-size:14.5pt; margin:22pt 0 7pt; padding-bottom:4pt; border-bottom:1.2pt solid var(--ink); }
  h3{ font-size:11.6pt; margin:15pt 0 5pt; }
  h4{ font-size:10.6pt; margin:12pt 0 4pt; color:var(--dim); }
  p{ margin:0 0 7pt; }
  a{ color:var(--accent); text-decoration:none; }
  hr{ border:0; border-top:.6pt solid var(--rule); margin:16pt 0; }
  blockquote{
    margin:9pt 0; padding:7pt 11pt; border-left:2pt solid var(--accent);
    background:#faf6f4; color:#3a3631; font-style:italic;
  }
  code{
    font:.86em/1.4 "SF Mono",Menlo,Consolas,monospace; background:var(--code);
    padding:1pt 3pt; border-radius:2pt;
  }
  pre{
    background:#12141a; color:#e6e3dc; padding:9pt 11pt; border-radius:3pt;
    overflow:auto; page-break-inside:avoid; margin:8pt 0 10pt;
    white-space:pre-wrap; overflow-wrap:anywhere;
  }
  pre code{ background:none; padding:0; color:inherit; font-size:8.4pt; line-height:1.45; }
  table{
    width:100%; border-collapse:collapse; margin:8pt 0 11pt; font-size:9.2pt;
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
    page-break-inside:auto;            /* long tables must be allowed to split ... */
  }
  tr{ page-break-inside:avoid; }        /* ... but never mid-row */
  thead{ display:table-header-group; }  /* ... and repeat the header on each page */
  th{ text-align:left; border-bottom:1pt solid var(--ink); padding:4pt 6pt 4pt 0; font-weight:600; }
  td{ border-bottom:.5pt solid var(--rule); padding:4pt 6pt 4pt 0; vertical-align:top; }
  td code, th code{ font-size:.88em; }
  ul,ol{ margin:0 0 8pt; padding-left:16pt; }
  li{ margin:0 0 3pt; }
  li > ul, li > ol{ margin-top:3pt; }
  em{ color:#3a3631; }
  h2 + table, h3 + table{ margin-top:6pt; }
</style>
${html.join('\n')}
`;

await writeFile(outPath, doc, 'utf8');
console.log(`${outPath} — ${doc.length} bytes, ${html.length} blocks`);
