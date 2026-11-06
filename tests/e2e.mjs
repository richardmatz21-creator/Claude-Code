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

  await step('Text direkt korrigieren: markiert, in SRT und Untertiteln übernommen', async () => {
    await page.click('#tab-text');
    const span = page.locator('#transcript .seg[data-seg="1"]');
    await span.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Gerne, am wichtigsten ist uns, dass die Termine früher feststehen.');
    await page.waitForFunction(() => document.querySelector('#transcript .seg[data-seg="1"]').classList.contains('edited'));
    assert.equal(await page.isVisible('#seg-tools [data-action="seg-reset"]'), true, 'Knopf „Original“ fehlt');
    assert.equal(await page.isVisible('#unsaved-hint'), true, 'Hinweis „nicht heruntergeladen“ fehlt');
    // Enter springt zum nächsten Abschnitt statt eine neue Zeile zu machen.
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.seg), '2');
    assert.equal((await span.textContent()).includes('\n'), false);
    const { data } = await readDownload(() => page.click('[data-action="dl-srt"]'));
    assert.match(data.toString('utf8'), /Gerne, am wichtigsten/);
    assert.equal(await page.isVisible('#unsaved-hint'), false, 'Hinweis bleibt nach dem Download');
    await page.click('#tab-subs');
    assert.match(await page.textContent('#cues'), /Gerne, am wichtigsten/);
    await page.click('#tab-text');
    await shot('6-korrigiert');
  });

  await step('Original wiederherstellen', async () => {
    await page.click('#transcript .seg[data-seg="0"]');
    await page.keyboard.press('End');
    await page.keyboard.type(' Test');
    await page.click('#seg-tools [data-action="seg-reset"]');
    assert.equal(await page.locator('#transcript .seg[data-seg="0"]').getAttribute('class'), 'seg');
    assert.doesNotMatch(await page.textContent('#transcript .seg[data-seg="0"]'), /Test$/);
  });

  await step('Anhören: Knopf und Strg+Leertaste spielen genau den Abschnitt ab', async () => {
    await page.click('#transcript .seg[data-seg="2"]');
    await page.click('#seg-tools [data-action="seg-play"]');
    await page.waitForSelector('#transcript .seg[data-seg="2"].playing', { timeout: 5000 });
    assert.match(await page.textContent('#seg-tools'), /Stopp/);
    // Der Abschnitt dauert ca. 5 s – danach hört die Wiedergabe von selbst auf.
    await page.waitForSelector('#transcript .seg.playing', { state: 'detached', timeout: 12000 });
    await page.click('#transcript .seg[data-seg="3"]');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('#transcript .seg[data-seg="3"].playing', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#transcript .seg.playing', { state: 'detached', timeout: 3000 });
  });

  await step('Suchen und Ersetzen mit Rückgängig', async () => {
    await page.click('[data-action="search-toggle"]');
    await page.fill('#search-q', 'sprechen wir');
    await page.waitForFunction(() => document.getElementById('search-count').textContent === '2 Treffer');
    await page.fill('#search-r', 'reden wir');
    await page.click('#replace-all');
    await page.waitForFunction(() => document.getElementById('search-count').textContent.includes('2 Stellen ersetzt'));
    const replaced = await page.textContent('#transcript');
    assert.equal((replaced.match(/reden wir/g) ?? []).length, 2);
    await page.click('#replace-undo');
    const back = await page.textContent('#transcript');
    assert.equal((back.match(/sprechen wir/g) ?? []).length, 2);
    assert.equal(back.includes('reden wir'), false);
    await page.click('[data-action="search-toggle"]');
  });

  await step('Korrektur-Modus Satz für Satz, Abschnitt leeren entfernt ihn aus TXT', async () => {
    await page.click('#transcript .seg[data-seg="0"]');
    await page.click('[data-action="corr-start"]');
    await page.waitForSelector('#correct:not([hidden])');
    assert.equal(await page.isVisible('.tabs'), false);
    assert.equal(await page.textContent('#corr-pos'), 'Abschnitt 1 von 7');
    assert.match(await page.inputValue('#corr-text'), /Guten Morgen/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+Enter');
    assert.equal(await page.textContent('#corr-pos'), 'Abschnitt 2 von 7');
    assert.match(await page.inputValue('#corr-text'), /^Gerne, am wichtigsten/, 'frühere Korrektur fehlt');
    await page.click('#corr-next');
    await page.fill('#corr-text', 'Das lässt sich machen. Ich schicke Ihnen bis Freitag einen Vorschlag.');
    assert.equal(await page.isVisible('#corr-orig'), true);
    await page.click('#corr-next');
    await page.click('#corr-next');
    await page.click('#corr-next');
    await page.click('#corr-next');
    assert.equal(await page.textContent('#corr-pos'), 'Abschnitt 7 von 7');
    await page.fill('#corr-text', '');
    await shot('7-korrektur-modus');
    await page.click('#corr-next'); // auf dem letzten Abschnitt = Fertig
    await page.waitForSelector('#correct', { state: 'hidden' });
    assert.match(await page.textContent('#transcript'), /einen Vorschlag/);
    assert.match(await page.textContent('#transcript'), /\(entfernt\)|Bescheid/);
    const { data } = await readDownload(() => page.click('[data-action="dl-txt"]'));
    const txt = data.toString('utf8');
    assert.match(txt, /bis Freitag einen Vorschlag/);
    assert.doesNotMatch(txt, /Vielen Dank und bis bald/, 'geleerter Abschnitt steht noch im TXT');
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
  await step('Warnung beim Schließen, solange Ergebnisse nicht heruntergeladen sind', async () => {
    let warned = false;
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => { if (d.type() === 'beforeunload') warned = true; d.dismiss().catch(() => {}); });
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(warned, true, 'keine Warnung beim Schließen');
  });
} finally {
  await browser.close();
  server.close();
}

console.log('\nMessung (Testrechner, nur Anhaltspunkt):', JSON.stringify(results, null, 2));
if (!ok) { console.error('\nE2E-Test fehlgeschlagen'); process.exit(1); }
console.log('\nE2E-Test bestanden');
