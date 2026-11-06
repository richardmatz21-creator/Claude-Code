// Schnelle Tests der reinen Hilfsfunktionen (ohne Browser, ohne Modelle).
// Aufruf: node tests/unit.mjs
import assert from 'node:assert/strict';
import {
  planChunks, frameLevels, speechLevel, isQuiet, filterHallucinations, formatSrtTime,
  splitText, wrapLines, buildCues, toSrt, toTxt, clusterSpeakers, assignSpeakers,
  speakerTimeline, baseName, SAMPLE_RATE,
} from '../site/core.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok  ', name); }
  catch (err) { failed++; console.error('FAIL', name, '\n    ', err.message); }
}

function tone(sec, amp = 0.3) {
  const a = new Float32Array(Math.round(sec * SAMPLE_RATE));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(i / 8);
  return a;
}
function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('planChunks: kurzes Audio bleibt ein Stück', () => {
  assert.deepEqual(planChunks(tone(10)), [[0, 10 * SAMPLE_RATE]]);
});

test('planChunks: schneidet an der Pause und nie über 29 s', () => {
  const audio = concat(tone(22), new Float32Array(SAMPLE_RATE), tone(20), new Float32Array(SAMPLE_RATE), tone(15));
  const chunks = planChunks(audio);
  assert.ok(chunks.length >= 2);
  for (const [a, b] of chunks) assert.ok(b - a <= 29 * SAMPLE_RATE + 1, 'Stück zu lang');
  assert.equal(chunks[0][0], 0);
  assert.equal(chunks.at(-1)[1], audio.length);
  const cut = chunks[0][1] / SAMPLE_RATE;
  assert.ok(cut > 22 && cut < 23, `Schnitt bei ${cut} s sollte in der Pause liegen`);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i][0], chunks[i - 1][1], 'Lücke zwischen Stücken');
});

test('planChunks: Dauerton ohne Pause wird trotzdem geteilt', () => {
  const chunks = planChunks(tone(100));
  assert.ok(chunks.length >= 4);
  for (const [a, b] of chunks) assert.ok(b - a <= 29 * SAMPLE_RATE + 1);
});

test('isQuiet erkennt Stille', () => {
  const audio = concat(tone(3), new Float32Array(3 * SAMPLE_RATE), tone(3));
  const levels = frameLevels(audio);
  const ref = speechLevel(levels);
  assert.equal(isQuiet(levels, 3.2, 5.8, ref), true);
  assert.equal(isQuiet(levels, 0, 3, ref), false);
});

test('Filter entfernt ZDF- und Amara-Sätze immer', () => {
  const { segments, removed } = filterHallucinations([
    { start: 0, end: 3, text: 'Hallo zusammen.' },
    { start: 3, end: 6, text: 'Untertitel im Auftrag des ZDF für funk, 2017' },
    { start: 6, end: 9, text: 'Untertitel der Amara.org-Community' },
    { start: 9, end: 12, text: 'Weiter geht es.' },
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(segments.map((s) => s.text), ['Hallo zusammen.', 'Weiter geht es.']);
});

test('Filter: „Vielen Dank fürs Zuschauen“ nur bei Stille entfernen', () => {
  const audio = concat(tone(4), new Float32Array(4 * SAMPLE_RATE));
  const levels = frameLevels(audio);
  const segs = [
    { start: 0, end: 4, text: 'Vielen Dank fürs Zuschauen!' },
    { start: 4, end: 8, text: 'Vielen Dank fürs Zuschauen!' },
  ];
  const { segments, removed } = filterHallucinations(segs, levels);
  assert.equal(removed, 1);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 0);
});

test('Filter: Wiederholungsschleifen werden gekürzt', () => {
  const { segments, removed } = filterHallucinations([
    { start: 0, end: 5, text: 'Ja, ja, ja, ja, ja, ja, ja, ja.' },
    { start: 5, end: 9, text: 'Das ist gut. Das ist gut. Das ist gut. Das ist gut. Das ist gut.' },
  ]);
  assert.ok(removed >= 2);
  assert.ok(segments[0].text.split(' ').length <= 3, segments[0].text);
  assert.ok(segments[1].text.length < 30, segments[1].text);
});

test('Filter: gleicher Satz dreimal hintereinander → einmal', () => {
  const { segments } = filterHallucinations([
    { start: 0, end: 2, text: 'Okay.' },
    { start: 2, end: 4, text: 'Okay.' },
    { start: 4, end: 6, text: 'Okay.' },
    { start: 6, end: 8, text: 'Okay.' },
  ]);
  assert.equal(segments.length, 2);
});

test('formatSrtTime', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(3723.456), '01:02:03,456');
});

test('splitText bevorzugt Satzenden und hält die Länge ein', () => {
  const text = 'Das ist der erste Satz. Hier kommt ein zweiter, etwas längerer Satz mit mehr Wörtern. Und ein dritter.';
  const parts = splitText(text, 60);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 60, p);
  assert.equal(parts.join(' '), text);
});

test('wrapLines bricht mittig um', () => {
  const lines = wrapLines('Am wichtigsten ist uns, dass die Termine früher feststehen.', 42);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.length <= 42);
});

test('buildCues: keine Überlappung, Mindestdauer, Sprecher-Präfix', () => {
  const cues = buildCues([
    { start: 0, end: 0.3, text: 'Hallo.', speaker: 0 },
    { start: 0.5, end: 9, text: 'Am wichtigsten ist uns, dass die Termine früher feststehen, damit wir besser planen können und nichts vergessen.', speaker: 1 },
  ], { withSpeakers: true, names: ['Richard'] });
  assert.ok(cues.length >= 3);
  assert.ok(cues[0].text.startsWith('Richard: '));
  assert.ok(cues[1].text.startsWith('Sprecher 2: '));
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9);
  for (const c of cues) assert.ok(c.text.length <= 84, c.text);
});

test('toSrt erzeugt gültiges Format', () => {
  const srt = toSrt([{ start: 1.2, end: 6.8, text: 'Guten Morgen.' }]);
  assert.equal(srt, '1\n00:00:01,200 --> 00:00:06,800\nGuten Morgen.\n');
});

test('toTxt: Absätze je Sprecher', () => {
  const txt = toTxt([
    { start: 0, end: 2, text: 'Hallo.', speaker: 0 },
    { start: 2, end: 4, text: 'Wie geht es?', speaker: 0 },
    { start: 4, end: 6, text: 'Gut.', speaker: 1 },
  ], { withSpeakers: true, names: ['Anna', ''] });
  assert.equal(txt, 'Anna: Hallo. Wie geht es?\n\nSprecher 2: Gut.\n');
});

test('clusterSpeakers trennt zwei Stimmen und hält feste Anzahl ein', () => {
  const a = () => Float32Array.from([1, 0.1 * Math.random(), 0, 0.05]);
  const b = () => Float32Array.from([0, 0.1 * Math.random(), 1, 0.05]);
  const embs = [a(), b(), a(), b(), a()];
  assert.deepEqual(clusterSpeakers(embs), [0, 1, 0, 1, 0]);
  assert.deepEqual(clusterSpeakers(embs, { numSpeakers: 1 }), [0, 0, 0, 0, 0]);
  assert.equal(new Set(clusterSpeakers(embs, { numSpeakers: 3 })).size, 3);
});

test('assignSpeakers nimmt größte Überlappung', () => {
  const segs = assignSpeakers(
    [{ start: 0, end: 4, text: 'a' }, { start: 4, end: 8, text: 'b' }, { start: 20, end: 21, text: 'c' }],
    [{ start: 0, end: 3.5, speaker: 0 }, { start: 3.5, end: 9, speaker: 1 }],
  );
  assert.deepEqual(segs.map((s) => s.speaker), [0, 1, 1]);
  assert.deepEqual(speakerTimeline(segs).map((t) => t.speaker), [0, 1]);
});

test('baseName entfernt Endung und Sonderzeichen', () => {
  assert.equal(baseName('Interview: Kunde.m4a'), 'Interview_ Kunde');
});

if (failed) { console.error(`\n${failed} Test(s) fehlgeschlagen`); process.exit(1); }
console.log('\nAlle Tests bestanden');
