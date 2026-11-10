// Turns the single-file build (apps/web/dist/index.html) into a page body for hosts that
// add their own <html>/<head>/<body> skeleton (e.g. a claude.ai artifact).
// Usage: node tools/publish/make-artifact.mjs [in] [out]
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'apps/web/dist/index.html';
const output = process.argv[3] ?? 'apps/web/dist/artifact.html';
let html = readFileSync(input, 'utf8');
html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<html[^>]*>/i, '')
  .replace(/<\/html>\s*$/i, '')
  .replace(/<head>/i, '')
  .replace(/<\/head>/i, '')
  .replace(/<body>/i, '')
  .replace(/<\/body>/i, '')
  .replace(/<meta charset="UTF-8"\s*\/?>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '')
  .replace(/(<title>[^<]*<\/title>)/i, '$1\n<meta name="claude:viewport-fit-sides" content="cover">');
writeFileSync(output, html.trim() + '\n');
console.log(`wrote ${output} (${(html.length / 1024).toFixed(0)} KB)`);
