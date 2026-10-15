// Builds the bookmarklet from layer-scanner.js: minifies it and writes
//   layer-scanner.bookmarklet.txt   the javascript: URL
//   layer-scanner.min.js            the minified scanner (can also be pasted into the browser console)
//   Install unmanaged layer scanner.html   a page with a link to drag to the favourites bar
// Run: npm run build (or node build-bookmarklet.mjs; uses terser from ./node_modules)
//
// Optional: scanner.settings.json next to this file names your own environments (see the README):
//   { "developmentEnvironments": "^contoso-dev\\d*$", "productionEnvironments": "^contoso(-preprod)?$" }
// Each value is a regular expression (case-insensitive) matched against the environment's name, the first part of
// its address. Deleting is turned off in development environments; the delete confirmation names production ones in
// red. The file is never published (.gitignore), and a build made with it is for your own organization only.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'package.json'))
const { minify } = require('terser')
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))

let src = fs.readFileSync(path.join(here, 'layer-scanner.js'), 'utf8')
const put = (from, to) => { if (!src.includes(from)) throw new Error(`layer-scanner.js no longer contains: ${from}`); src = src.replace(from, to) }
put("const VERSION = '__VERSION__'", `const VERSION = ${JSON.stringify(version)}`)
const settingsFile = path.join(here, 'scanner.settings.json')
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
for (const key of ['developmentEnvironments', 'productionEnvironments']) {
  const pattern = settings[key]
  if (pattern == null || pattern === '') continue
  if (typeof pattern !== 'string') throw new Error(`scanner.settings.json: ${key} must be a regular expression written as a string`)
  new RegExp(pattern, 'i')   // stops the build on an invalid pattern
  put(`${key}: null,`, `${key}: new RegExp(${JSON.stringify(pattern)}, 'i'),`)
}
const local = Object.keys(settings).length > 0
if (local) console.log('Built with your environment rules from scanner.settings.json: for your organization only, do not publish this build.')
const min = await minify(src, { ecma: 2020, compress: { passes: 2 }, mangle: true, format: { comments: false } })
// The line breaks and indentation kept in the HTML and CSS templates become single spaces.
const code = min.code.replace(/\\n +/g, ' ')
fs.writeFileSync(path.join(here, 'layer-scanner.min.js'), code)

// The link carries the scanner compressed (deflate, base64) and unpacks it with the browser's own
// DecompressionStream, so it stays far below Edge's limit of about 100 KB. Environment pages have no script policy
// and the maker portal allows eval, so the unpacked code runs with eval; if a page ever forbids eval, it is loaded
// as a script from a blob: address instead, and if that is refused too, an alert says so.
const packed = zlib.deflateRawSync(Buffer.from(code, 'utf8'), { level: 9 }).toString('base64')
const loader = `void (async()=>{try{const t=await new Response(new Blob([Uint8Array.from(atob('${packed}'),(c)=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();try{(0,eval)(t)}catch(e){if(!(e instanceof EvalError))throw e;const s=document.createElement('script');s.src=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));s.onerror=()=>alert('This page does not allow the unmanaged layer scanner to run.');document.head.appendChild(s)}}catch(e){alert('The unmanaged layer scanner could not start: '+e.message)}})()`
// Only what a javascript: link needs is escaped: % (so decoding gives back exactly the code), # and ? and characters
// outside printable ASCII (the base64 text has none of them).
const bookmarklet = 'javascript:' + loader.replace(/[%#?\x00-\x1f\x7f-\u{10ffff}]/gu, (c) => encodeURIComponent(c))
fs.writeFileSync(path.join(here, 'layer-scanner.bookmarklet.txt'), bookmarklet)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unmanaged layer scanner</title>
<style>
  body{font:15px/1.55 "Segoe UI",system-ui,sans-serif;color:#242424;background:#f5f5f5;margin:0}
  main{max-width:760px;margin:40px auto;padding:0 20px}
  h1{font-size:26px;margin:0 0 6px} h2{font-size:18px;margin-top:28px}
  .lede{color:#424242;margin-top:0}
  .card{background:#fff;border-radius:8px;padding:20px 22px;box-shadow:0 0 2px rgba(0,0,0,.12),0 2px 4px rgba(0,0,0,.14)}
  a.bm{display:inline-block;background:#0f6cbd;color:#fff;text-decoration:none;padding:8px 16px;border-radius:4px;font-weight:600;cursor:grab}
  ol li{margin:6px 0} code{background:#f0f0f0;padding:1px 5px;border-radius:4px;font-size:13px}
  textarea{width:100%;height:90px;font:12px Consolas,monospace;border:1px solid #d1d1d1;border-radius:4px;padding:8px;box-sizing:border-box}
  button{font:inherit;border:1px solid #d1d1d1;background:#fff;border-radius:4px;padding:5px 12px;cursor:pointer}
  .note{border-left:4px solid #c50f1f;background:#fdf3f4;padding:10px 14px;border-radius:4px}
</style></head><body><main>
<h1>Unmanaged layer scanner</h1>
<p class="lede">Finds the components of the managed solutions you choose that have an unmanaged layer on top, shows what changed, and deletes the layers you select. It runs in Edge with your own sign-in; nothing is installed in the environment.</p>
<div class="card">
<h2 style="margin-top:0">Install</h2>
<ol>
  <li>Show the favourites bar (Ctrl+Shift+B).</li>
  <li>Drag this button onto the favourites bar: <a class="bm" href="${esc(bookmarklet)}">Unmanaged layers</a></li>
</ol>
<p>If dragging does not work: create a new favourite named <b>Unmanaged layers</b> and paste this as its URL.</p>
<textarea id="code" readonly>${esc(bookmarklet)}</textarea>
<p><button id="copy">Copy</button> <span id="copied"></span></p>
</div>
<h2>Use</h2>
<ol>
  <li>Open a page of the environment (for example <code>https://contoso.crm.dynamics.com</code>) or its Solutions page in the maker portal (make.powerapps.com).</li>
  <li>Click <b>Unmanaged layers</b> in the favourites bar, choose the managed solutions (and, if you like, object types or tables), then <b>Scan</b>.</li>
  <li>Filter any column, open a component's solution layers or its changes, export, or tick components and select <b>Delete unmanaged layer</b>.</li>
</ol>
<p class="note"><b>Deleting an unmanaged layer cannot be undone.</b> It is the same as "Remove active customizations" in the maker portal: the component goes back to what its managed solution defines. Each component is checked before and after, and a log of the removed changes can be downloaded.${settings.developmentEnvironments ? ' Deleting is turned off in development environments.' : ''}</p>
<p style="color:#616161;font-size:13px">Version ${esc(version)} · built ${new Date().toISOString().slice(0, 10)} · ${(bookmarklet.length / 1024).toFixed(1)} KB link (${(code.length / 1024).toFixed(1)} KB unpacked)</p>
</main>
<script>document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('code').value);document.getElementById('copied').textContent='Copied.'}</script>
</body></html>`
fs.writeFileSync(path.join(here, 'Install unmanaged layer scanner.html'), html)
console.log(`bookmarklet ${version}: ${bookmarklet.length} characters (${(code.length / 1024).toFixed(1)} KB unpacked)`)
