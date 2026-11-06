// Echter Ende-zu-Ende-Test im Browser (Chromium, Prozessor-Modus):
// Seite öffnen → Testdateien hochladen → umwandeln → Ergebnis prüfen → herunterladen → abbrechen.
// Voraussetzung: `npm run build` (mit Modellen). Aufruf: node tests/e2e.mjs [--screens <ordner>]
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../scripts/serve.mjs';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const PORT = 8790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const screensArg = process.argv.indexOf('--screens');
const SCREENS = screensArg > 0 ? process.argv[screensArg + 1] : null;
const TIMEOUT = 15 * 60 * 1000;

// Kernwörter der Testaufnahme (gesprochen von zwei Computerstimmen).
const EXPECTED = ['Guten Morgen', 'Ablauf', 'Termine', 'Freitag', 'Vorschlag', 'Lieferung', 'Montag', 'Büro', 'Vielen Dank'];

const server = await startServer(PORT);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
// Für den Abbruch-Test lässt sich das Einlesen künstlich verlangsamen (wie bei großen Dateien auf schwachen Laptops).
await page.addInitScript(() => {
  const orig = OfflineAudioContext.prototype.decodeAudioData;
  OfflineAudioContext.prototype.decodeAudioData = async function (...args) {
    if (self.__slowDecode) await new Promise((r) => setTimeout(r, 6000));
    return orig.apply(this, args);
  };
});
const foreign = [];
const failures = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u);
});
page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => console.log('[Seitenfehler]', e.message));
// Rückfragen („Ergebnisse verwerfen?“) immer bestätigen.
page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('console', (m) => { if (m.type() === 'error') console.log('[Konsole]', m.text().slice(0, 500)); });

async function shot(name) {
  if (!SCREENS) return;
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
}

async function readDownload(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), data: await readFile(path) };
}

const results = {};
let ok = true;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    ok = false;
    console.error(`FAIL ${name}\n     ${err.message}`);
    await shot(`fehler-${name.replace(/\W+/g, '-')}`);
  }
}

try {
  await step('Seite lädt, Mehrkern-Modus aktiv, Prozessor erkannt', async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30000 });
    await page.waitForFunction(() => /Kerne|Kern\.|Grafikkarte wird/.test(document.getElementById('mode-info').textContent), null, { timeout: 30000 });
    const mode = await page.textContent('#mode-info');
    assert.match(mode, /Prozessor rechnet \((\d+ Kerne|1 Kern)\)/, mode);
    await shot('1-start');
  });

  await step('Zwei Dateien (MP3 + MP4) mit Sprecher-Erkennung umwandeln', async () => {
    await page.setInputFiles('#file-input', [join(FIX, 'gespraech.mp3'), join(FIX, 'gespraech.mp4')]);
    await page.waitForSelector('#file-list .file-item >> nth=1');
    await page.click('label.switch');
    assert.equal(await page.isChecked('#set-diarize'), true);
    assert.equal(await page.isVisible('#field-speakers'), true);
    assert.equal(await page.inputValue('#set-model'), 'small');
    assert.match(await page.textContent('#start-btn'), /2 Dateien umwandeln/);
    await shot('2-dateien');
    const t0 = Date.now();
    await page.click('#start-btn');
    await page.waitForSelector('#step2:not([hidden])');
    await page.waitForFunction(() => /wird umgewandelt|Sprecher werden erkannt/.test(document.getElementById('progress-title').textContent), null, { timeout: TIMEOUT });
    await shot('3-umwandeln');
    await page.waitForSelector('#step3:not([hidden])', { timeout: TIMEOUT });
    results.zweiDateienSekunden = (Date.now() - t0) / 1000;
    await shot('4-ergebnis-text');
  });

  await step('Text enthält die gesprochenen Kernwörter', async () => {
    const text = await page.textContent('#transcript');
    const missing = EXPECTED.filter((w) => !text.includes(w));
    results.fehlendeWoerter = missing;
    assert.ok(missing.length <= 2, `fehlen: ${missing.join(', ')}\nText: ${text}`);
    assert.ok(!/Untertitel|Amara|ZDF/i.test(text), 'erfundener Satz im Text');
  });

  await step('Zwei Sprecher erkannt und abwechselnd zugeordnet', async () => {
    assert.match(await page.textContent('#result-sub'), /2 Sprecher/);
    const labels = await page.$$eval('#transcript .who', (els) => els.map((e) => e.textContent));
    results.sprecherFolge = labels.join(' ');
    assert.ok(labels.length >= 5, `nur ${labels.length} Redebeiträge`);
    assert.deepEqual(labels.slice(0, 4), ['Sprecher 1:', 'Sprecher 2:', 'Sprecher 1:', 'Sprecher 2:']);
  });

  await step('Untertitel-Tab: Zeitleiste, Umbenennen, Blöcke', async () => {
    await page.click('#tab-subs');
    await page.waitForSelector('#panel-subs:not([hidden])');
    assert.ok(await page.isVisible('#timeline-wrap'));
    const cues = await page.$$('#cues .cue');
    assert.ok(cues.length >= 7, `nur ${cues.length} Untertitel`);
    await page.fill('#name-0', 'Richard');
    await page.waitForFunction(() => document.getElementById('legend').textContent.includes('Richard'));
    assert.match(await page.textContent('#cues'), /Richard/);
    await shot('5-ergebnis-untertitel');
    await page.click('#tab-text');
    assert.match(await page.textContent('#transcript'), /Richard:/);
  });

  await step('SRT-Download ist gültig und enthält Namen', async () => {
    const { name, data } = await readDownload(() => page.click('[data-action="dl-srt"]'));
    const srt = data.toString('utf8').replace(/^\ufeff/, '');
    assert.equal(name, 'gespraech.srt');
    assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n/);
    assert.match(srt, /Richard: /);
    for (const block of srt.trim().split('\n\n')) {
      const lines = block.split('\n');
      assert.ok(lines.length >= 3 && lines.length <= 4, `Block mit ${lines.length} Zeilen`);
      for (const l of lines.slice(2)) assert.ok(l.length <= 50, `Zeile zu lang: ${l}`);
    }
  });

  await step('TXT-Download und Kopieren', async () => {
    const { name, data } = await readDownload(() => page.click('[data-action="dl-txt"]'));
    assert.equal(name, 'gespraech.txt');
    assert.match(data.toString('utf8'), /Richard: Guten Morgen/);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('[data-action="copy"]');
    await page.waitForFunction(() => document.getElementById('copy-status').textContent.includes('kopiert'));
  });

  await step('ZIP enthält beide Dateien (MP4-Tonspur wurde gelesen)', async () => {
    const { name, data } = await readDownload(() => page.click('[data-action="dl-zip"]'));
    assert.equal(name, 'transkripte.zip');
    const files = unzipSync(new Uint8Array(data));
    const names = Object.keys(files).sort();
    assert.deepEqual(names, ['gespraech (2).srt', 'gespraech (2).txt', 'gespraech.srt', 'gespraech.txt']);
    assert.match(strFromU8(files['gespraech (2).txt']), /Vorschlag/);
  });

  await step('Abbrechen bringt zurück zu Schritt 1', async () => {
    await page.click('[data-action="reset"]');
    await page.waitForSelector('#step1:not([hidden])');
    await page.selectOption('#set-model', 'base');
    if (await page.isChecked('#set-diarize')) await page.click('label.switch');
    assert.equal(await page.isChecked('#set-diarize'), false);
    await page.setInputFiles('#file-input', [join(FIX, 'gespraech.mp3')]);
    await page.click('#start-btn');
    await page.waitForSelector('#step2:not([hidden])');
    await page.click('#cancel-btn');
    await page.waitForSelector('#step1:not([hidden])', { timeout: 20000 });
    assert.match(await page.textContent('#file-list'), /Abgebrochen/);
  });

  await step('Schnell-Modell nach Abbruch erneut starten', async () => {
    const t0 = Date.now();
    await page.click('#start-btn');
    await page.waitForSelector('#step3:not([hidden])', { timeout: TIMEOUT });
    results.schnellSekunden = (Date.now() - t0) / 1000;
    assert.match(await page.textContent('#transcript'), /Morgen/);
    assert.doesNotMatch(await page.textContent('#result-sub'), /Sprecher/);
  });

  await step('Abbrechen während langsamem Einlesen: kein heimlicher Weiterlauf', async () => {
    await page.click('[data-action="reset"]');
    await page.waitForSelector('#step1:not([hidden])');
    await page.setInputFiles('#file-input', [join(FIX, 'gespraech.mp3')]);
    await page.evaluate(() => { self.__slowDecode = true; });
    await page.click('#start-btn');
    await page.waitForSelector('#step2:not([hidden])');
    await page.click('#cancel-btn');
    await page.waitForSelector('#step1:not([hidden])', { timeout: 10000 });
    await page.evaluate(() => { self.__slowDecode = false; });
    // Nach dem Abbruch darf die Seite nicht von selbst zum Ergebnis springen.
    await page.waitForTimeout(20000);
    assert.equal(await page.isVisible('#step1'), true, 'Seite ist ungefragt weitergesprungen');
    assert.match(await page.textContent('#file-list'), /Abgebrochen/);
  });

  await step('Fehlerhafte Datei wird im Ergebnis gemeldet', async () => {
    await page.setInputFiles('#file-input', [{ name: 'kaputt.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('das ist kein Ton') }]);
    await page.click('#start-btn');
    await page.waitForSelector('#step3:not([hidden])', { timeout: TIMEOUT });
    const box = await page.textContent('#failed-box');
    assert.match(box, /kaputt\.mp3/);
    assert.match(box, /nicht lesen/);
    assert.match(await page.textContent('#transcript'), /Morgen/);
  });

  await step('Lizenztexte werden mitgeliefert', async () => {
    const res = await page.request.get(`${ORIGIN}/licenses/LIZENZEN.txt`);
    assert.equal(res.status(), 200);
    const text = await res.text();
    for (const w of ['CC BY 4.0', 'Microsoft Corporation', 'Apache', 'fflate', 'Open Font License']) assert.ok(text.includes(w), `fehlt: ${w}`);
  });

  await step('Keine Anfragen an fremde Server, keine fehlenden Dateien', async () => {
    assert.deepEqual(foreign, [], `fremde Anfragen: ${foreign.join(', ')}`);
    assert.deepEqual(failures, [], `Fehler: ${failures.join(', ')}`);
  });
} finally {
  await browser.close();
  server.close();
}

console.log('\nMessung (Testrechner, nur Anhaltspunkt):', JSON.stringify(results, null, 2));
if (!ok) { console.error('\nE2E-Test fehlgeschlagen'); process.exit(1); }
console.log('\nE2E-Test bestanden');
