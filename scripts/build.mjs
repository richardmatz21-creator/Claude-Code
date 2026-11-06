// Baut die veröffentlichte Seite nach dist/:
//  1. kopiert site/ (Oberfläche)
//  2. kopiert Bibliotheken (transformers.js, ONNX-Runtime-WASM, fflate, coi-serviceworker, Schrift)
//  3. lädt die Modelle in fester Version (Cache in .cache/models) und prüft Prüfsummen
//  4. bricht ab, wenn die Seite größer als 1 GB wird (Grenze von GitHub Pages)
//
// Aufruf: node scripts/build.mjs [--skip-models]

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache', 'models');
const NM = join(ROOT, 'node_modules');
const SIZE_LIMIT = 1_000_000_000; // 1 GB, mit etwas Sicherheitsabstand zu GitHubs Grenze
const skipModels = process.argv.includes('--skip-models');

function log(...args) { console.log('[build]', ...args); }

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}

// Liefert für jede Datei im Repo { size, sha256 (nur LFS) } zur festen Revision.
async function listRepoFiles(id, revision) {
  const out = new Map();
  for (const sub of ['', 'onnx']) {
    const url = `https://huggingface.co/api/models/${id}/tree/${revision}${sub ? '/' + sub : ''}`;
    const entries = await fetchJson(url);
    for (const e of entries) {
      if (e.type !== 'file') continue;
      out.set(e.path, { size: e.lfs?.size ?? e.size, sha256: e.lfs?.oid ?? null });
    }
  }
  return out;
}

async function download(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
      const tmp = dest + '.part';
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await rename(tmp, dest);
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      log(`Download fehlgeschlagen (${err.message}), neuer Versuch …`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}

// Versionskennung für Bibliotheken und Modelle: ändert sich, sobald sich Modelle oder Pakete ändern.
// Dadurch bekommen Browser nach einem Update neue Adressen und mischen nie alte und neue Teile.
async function assetsVersion() {
  const hash = createHash('sha256');
  hash.update(await readFile(join(ROOT, 'scripts', 'models.json')));
  hash.update(await readFile(join(ROOT, 'package-lock.json')));
  return 'a-' + hash.digest('hex').slice(0, 10);
}

async function fetchModels(assetsDir) {
  const { models } = JSON.parse(await readFile(join(ROOT, 'scripts', 'models.json'), 'utf8'));
  for (const model of models) {
    const remote = await listRepoFiles(model.id, model.revision);
    for (const file of model.files) {
      const meta = remote.get(file);
      if (!meta) throw new Error(`${model.id}: Datei ${file} gibt es in Revision ${model.revision} nicht`);
      const cached = join(CACHE, model.id, model.revision, file);
      await mkdir(dirname(cached), { recursive: true });
      let ok = false;
      if (existsSync(cached)) {
        const s = await stat(cached);
        ok = s.size === meta.size && (!meta.sha256 || (await sha256(cached)) === meta.sha256);
      }
      if (!ok) {
        log(`lade ${model.id}/${file} (${(meta.size / 1e6).toFixed(1)} MB)`);
        await download(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`, cached);
        const s = await stat(cached);
        if (s.size !== meta.size) throw new Error(`${file}: falsche Größe ${s.size} statt ${meta.size}`);
        if (meta.sha256 && (await sha256(cached)) !== meta.sha256) throw new Error(`${file}: Prüfsumme stimmt nicht`);
      }
      const target = join(assetsDir, 'models', model.id, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(cached, target);
    }
  }
}

async function copyVendor(assetsDir) {
  const vendor = join(assetsDir, 'vendor');
  await mkdir(vendor, { recursive: true });
  const ortDist = join(NM, 'onnxruntime-web', 'dist');
  const files = [
    [join(NM, '@huggingface', 'transformers', 'dist', 'transformers.min.js'), 'transformers.min.js'],
    [join(ortDist, 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs'],
    [join(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm'), 'ort-wasm-simd-threaded.asyncify.wasm'],
    [join(NM, 'fflate', 'esm', 'browser.js'), 'fflate.js'],
  ];
  for (const [src, name] of files) await cp(src, join(vendor, name));

  // coi-serviceworker muss im Hauptordner liegen, sonst gilt er nicht für die ganze Seite.
  await cp(join(NM, 'coi-serviceworker', 'coi-serviceworker.min.js'), join(DIST, 'coi-serviceworker.min.js'));

  // Schrift Figtree (SIL Open Font License), lokal statt Google Fonts.
  const fontDir = join(DIST, 'fonts');
  await mkdir(fontDir, { recursive: true });
  for (const w of [400, 600, 700, 800]) {
    for (const subset of ['latin', 'latin-ext']) {
      const name = `figtree-${subset}-${w}-normal.woff2`;
      await cp(join(NM, '@fontsource', 'figtree', 'files', name), join(fontDir, name));
    }
  }
}

function mitLicense(copyright) {
  return `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

// Lizenztexte der mitgelieferten Software und Hinweise zu den Modellen.
async function writeLicenses() {
  const { models } = JSON.parse(await readFile(join(ROOT, 'scripts', 'models.json'), 'utf8'));
  const parts = [
    'Audio zu Text – Lizenzen der mitgelieferten Software und Modelle',
    '='.repeat(64),
    '',
    'MODELLE',
    ...models.map((m) => `- ${m.id} (Revision ${m.revision}) – ${m.license} – https://huggingface.co/${m.id}`),
    '',
    'Whisper (https://github.com/openai/whisper): siehe Lizenztext „Whisper“ unten.',
    'pyannote segmentation-3.0 (https://huggingface.co/pyannote/segmentation-3.0): siehe Lizenztext „pyannote“ unten.',
    'wespeaker-voxceleb-resnet34-LM: WeSpeaker-Projekt (https://github.com/wenet-e2e/wespeaker), bereitgestellt von pyannote',
    '  (https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM), Lizenz CC BY 4.0',
    '  (https://creativecommons.org/licenses/by/4.0/). Änderung: ins ONNX-Format umgewandelt von onnx-community.',
    '',
  ];
  const libs = [
    ['Whisper (Modell)', null, mitLicense('Copyright (c) 2022 OpenAI')],
    ['pyannote segmentation-3.0 (Modell)', null, mitLicense('Copyright (c) 2020 CNRS')],
    ['Transformers.js (@huggingface/transformers)', join(NM, '@huggingface', 'transformers', 'LICENSE')],
    // Das npm-Paket enthält keine LICENSE-Datei; MIT laut https://github.com/microsoft/onnxruntime/blob/main/LICENSE
    ['ONNX Runtime Web (onnxruntime-web)', join(NM, 'onnxruntime-web', 'LICENSE'), mitLicense('Copyright (c) Microsoft Corporation')],
    ['fflate', join(NM, 'fflate', 'LICENSE')],
    ['coi-serviceworker', join(NM, 'coi-serviceworker', 'LICENSE')],
    ['Schrift Figtree (@fontsource/figtree)', join(NM, '@fontsource', 'figtree', 'LICENSE')],
  ];
  for (const [name, file, fallback] of libs) {
    let text;
    try { text = file ? await readFile(file, 'utf8') : fallback; } catch { text = fallback ?? null; }
    if (!text) throw new Error(`Lizenztext fehlt: ${file}`);
    parts.push('', '-'.repeat(64), name, '-'.repeat(64), text.trim());
  }
  await mkdir(join(DIST, 'licenses'), { recursive: true });
  await writeFile(join(DIST, 'licenses', 'LIZENZEN.txt'), parts.join('\n') + '\n');
}

// Platzhalter in den eigenen Dateien ersetzen (nicht in Bibliotheken und Modellen).
async function replacePlaceholders(values) {
  for (const entry of await readdir(DIST, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(html|js|css)$/.test(entry.name)) continue;
    const p = join(DIST, entry.name);
    let text = await readFile(p, 'utf8');
    for (const [key, value] of Object.entries(values)) text = text.replaceAll(key, value);
    await writeFile(p, text);
  }
}

async function dirSize(dir) {
  let total = 0;
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const p = join(entry.parentPath ?? entry.path, entry.name);
    const s = (await stat(p)).size;
    total += s;
    files.push([relative(dir, p), s]);
  }
  return { total, files };
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await cp(join(ROOT, 'site'), DIST, { recursive: true });
  const assets = await assetsVersion();
  const assetsDir = join(DIST, assets);
  await copyVendor(assetsDir);
  await writeLicenses();
  if (!skipModels) await fetchModels(assetsDir);

  // Build-Kennung, damit Browser nach Updates die neue Version laden.
  const buildId = process.env.GITHUB_SHA?.slice(0, 7) ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  await replacePlaceholders({ __BUILD__: buildId, __ASSETS__: assets });
  log(`Version ${buildId}, Bibliotheken und Modelle unter ${assets}/`);

  const { total, files } = await dirSize(DIST);
  files.sort((a, b) => b[1] - a[1]);
  log('größte Dateien:');
  for (const [f, s] of files.slice(0, 12)) log(`  ${(s / 1e6).toFixed(1).padStart(7)} MB  ${f}`);
  log(`Gesamtgröße: ${(total / 1e6).toFixed(1)} MB (Grenze ${(SIZE_LIMIT / 1e6).toFixed(0)} MB)`);
  if (total > SIZE_LIMIT) {
    console.error('[build] FEHLER: Die Seite ist größer als 1 GB und würde von GitHub Pages abgelehnt.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[build] FEHLER:', err);
  process.exit(1);
});
