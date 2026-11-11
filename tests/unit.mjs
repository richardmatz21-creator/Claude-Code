// Schnelle Tests der reinen Hilfsfunktionen (ohne Browser, ohne Modelle).
// Aufruf: node tests/unit.mjs
import assert from 'node:assert/strict';
import {
  planChunks, frameLevels, speechLevel, isQuiet, filterHallucinations, formatSrtTime,
  splitText, wrapLines, buildCues, toSrt, toTxt, clusterSpeakers, assignSpeakers,
  speakerTimeline, baseName, SAMPLE_RATE, planSpeechChunks, assembleChunk, chunkTimeToSource,
  groupParagraphs, activeSegments, findMatches, countMatches, replaceAll,
  buildScriptBlocks, shortenText, wordFrequencies, scriptDocxFiles, titleFromFileName, findForeignLyrics,
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

test('planSpeechChunks lässt lange Stille weg und packt Ton zusammen', () => {
  const sil = (sec) => new Float32Array(Math.round(sec * SAMPLE_RATE));
  const audio = concat(sil(10), tone(3), sil(1), tone(3), sil(8), tone(4), sil(20));
  const chunks = planSpeechChunks(audio, frameLevels(audio));
  assert.equal(chunks.length, 1, 'alles passt in ein Stück');
  const c = chunks[0];
  const sec = c.length / SAMPLE_RATE;
  assert.ok(sec > 10 && sec < 13.5, `Stück ${sec} s – Stille hätte entfernt werden sollen`);
  assert.equal(c.parts.length, 2, 'kurze Pause (1 s) bleibt drin, lange Pause (8 s) nicht');
  assert.equal(assembleChunk(audio, c).length, c.length);
  // Zeit im Stück → Originalzeit: Anfang ≈ 9,5 s (10 s Stille minus 0,5 s Rand)
  assert.ok(Math.abs(chunkTimeToSource(c, 0) - 9.5) < 0.15, String(chunkTimeToSource(c, 0)));
  const firstLen = c.parts[0].len / SAMPLE_RATE;
  assert.ok(chunkTimeToSource(c, firstLen + 1) > 25, 'Zeit im zweiten Teil liegt nach der langen Pause');
});

test('planSpeechChunks: leiser Sprecher (30 dB leiser) bleibt erhalten', () => {
  const sil = (sec) => new Float32Array(Math.round(sec * SAMPLE_RATE));
  const quiet = tone(4, 0.3 / 31.6); // −30 dB
  const audio = concat(tone(4), sil(5), quiet, sil(5), tone(4));
  const chunks = planSpeechChunks(audio, frameLevels(audio));
  const kept = chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
  assert.ok(kept >= 12, `nur ${kept} s behalten – leiser Teil fehlt`);
  assert.ok(kept < 17, `${kept} s behalten – Stille nicht entfernt`);
});

test('planSpeechChunks: nur Stille → keine Stücke, langer Ton → Stücke ≤ 29 s', () => {
  const silent = new Float32Array(30 * SAMPLE_RATE);
  assert.deepEqual(planSpeechChunks(silent, frameLevels(silent)), []);
  const long = tone(95);
  const chunks = planSpeechChunks(long, frameLevels(long));
  assert.ok(chunks.length >= 4);
  let total = 0;
  for (const c of chunks) { assert.ok(c.length <= 29 * SAMPLE_RATE + 1); total += c.length; }
  assert.equal(total, long.length, 'kein Ton geht verloren');
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

test('buildCues: Ansicht ohne Namen im Text hat dieselbe Aufteilung wie die SRT', () => {
  const segs = [{ start: 0, end: 9, text: 'Am wichtigsten ist uns, dass die Termine früher feststehen, damit wir planen können.', speaker: 0 }];
  const opts = { withSpeakers: true, names: ['Richard Mustermann-Langname'] };
  const srtCues = buildCues(segs, opts);
  const viewCues = buildCues(segs, { ...opts, labelInText: false });
  assert.equal(viewCues.length, srtCues.length);
  assert.ok(!viewCues[0].text.startsWith('Richard'));
  assert.ok(srtCues[0].text.startsWith('Richard Mustermann-Langname: '));
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

test('groupParagraphs behält jeden Abschnitt mit seiner Nummer', () => {
  const segs = [
    { start: 0, end: 2, text: 'Hallo.', speaker: 0 },
    { start: 2, end: 4, text: 'Wie geht es?', speaker: 0 },
    { start: 4, end: 6, text: 'Gut.', speaker: 1 },
  ];
  const groups = groupParagraphs(segs, { withSpeakers: true });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((it) => it.index), [0, 1]);
  assert.deepEqual(groups[1].items.map((it) => it.index), [2]);
  assert.equal(groups[1].label, 'Sprecher 2');
});

test('Geleerte Abschnitte fallen aus TXT und SRT heraus', () => {
  const segs = [
    { start: 0, end: 2, text: 'Erster Satz.' },
    { start: 2, end: 3, text: '   ' },
    { start: 3, end: 5, text: 'Dritter Satz.' },
  ];
  const live = activeSegments(segs);
  assert.equal(live.length, 2);
  assert.equal(toTxt(live), 'Erster Satz. Dritter Satz.\n');
  assert.equal(toSrt(live).split('\n\n').length, 2);
});

test('Suchen und Ersetzen: ohne Groß-/Kleinschreibung, Sonderzeichen wörtlich', () => {
  const segs = [
    { text: 'Gelen, am wichtigsten ist uns …' },
    { text: 'Das sagte gelen auch. (C++) kostet 5$.' },
  ];
  assert.equal(countMatches(segs, 'gelen'), 2);
  assert.deepEqual(findMatches(segs[0].text, 'GELEN'), [[0, 5]]);
  assert.equal(countMatches(segs, '(C++)'), 1);
  assert.equal(countMatches(segs, ''), 0);
  const n = replaceAll(segs, 'gelen', 'Gerne');
  assert.equal(n, 2);
  assert.equal(segs[0].text, 'Gerne, am wichtigsten ist uns …');
  assert.equal(segs[1].text, 'Das sagte Gerne auch. (C++) kostet 5$.');
  replaceAll(segs, '5$', '$& 10 €');
  assert.ok(segs[1].text.includes('$& 10 €'), 'Ersetzung wird wörtlich eingesetzt');
  assert.equal(countMatches([{ text: 'Über über ÜBER' }], 'über'), 3);
  const empty = [{ text: 'Ich ähm bin da ähm.' }];
  replaceAll(empty, 'ähm', '');
  assert.equal(empty[0].text, 'Ich bin da.', 'keine doppelten Leerzeichen nach Ersetzen durch leer');
});

// Alle Texte in diesen Tests sind frei erfunden.
test('Textgerüst: OFF bei Stille, OT bei langen Beiträgen, Sit bei Hin und Her', () => {
  const segs = [
    { start: 4, end: 10, text: 'Heute zeige ich euch meinen Garten.', speaker: 0 },
    { start: 10.5, end: 16, text: 'Hier wachsen die Tomaten am besten.', speaker: 0 }, // gleiche Stimme → ein OT (12 s)
    { start: 16.5, end: 30, text: 'Ich bin der Ben und zum ersten Mal auf dem Hof.', speaker: 1 }, // direkt danach, lang → eigenes OT
    { start: 36, end: 38, text: 'Grüß dich, Ben!', speaker: 0 },                       // nach 6 s Stille: Hin und Her → Sit
    { start: 38.2, end: 40, text: 'Hallo, schön hier.', speaker: 1 },
    { start: 40.3, end: 42, text: 'Komm rein.', speaker: 0 },
    { start: 43, end: 45, text: 'Danke, gerne.', speaker: 1 },
  ];
  const blocks = buildScriptBlocks(segs, { duration: 52 });
  assert.deepEqual(blocks.map((b) => b.type), ['OFF', 'OT', 'OT', 'OFF', 'Sit', 'OFF']);
  assert.deepEqual(blocks[1].speakers, [0]);
  assert.equal(blocks[1].full, 'Heute zeige ich euch meinen Garten. Hier wachsen die Tomaten am besten.');
  assert.deepEqual(blocks[2].speakers, [1]);
  assert.deepEqual(blocks[4].speakers.sort(), [0, 1]);
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks.at(-1).end, 52);
  // OFF-Grenze einstellbar: bei 8 s gibt es zwischen 30 s und 36 s kein OFF mehr
  assert.deepEqual(buildScriptBlocks(segs, { duration: 52, offGap: 8 }).map((b) => b.type), ['OT', 'OT', 'Sit']);
  // Leere Abschnitte zählen nicht; ohne Sprache ist alles OFF
  assert.deepEqual(buildScriptBlocks([{ start: 0, end: 2, text: ' ', speaker: 0 }], { duration: 10 }).map((b) => b.type), ['OFF']);
  // Ohne Sprecher-Erkennung: nur OT und OFF
  const noSpk = segs.map(({ speaker, ...r }) => r);
  assert.ok(buildScriptBlocks(noSpk, { duration: 52 }).every((b) => b.type !== 'Sit'));
});

test('Textgerüst: Pausen werden am Ton gemessen, nicht an den gepolsterten Abschnitten', () => {
  // Ton von 0–10 s und 13,8–20 s (3,8 s echte Stille); Whisper-Abschnitte sind je 0,5 s gepolstert.
  const levels = new Float32Array(200);
  for (let f = 0; f < 200; f++) levels[f] = (f < 100 || f >= 138) ? 0.2 : 0.001;
  const segs = [
    { start: 0, end: 10.5, text: 'Erster langer Beitrag über den Hof.', speaker: 0 },
    { start: 13.3, end: 20, text: 'Zweiter langer Beitrag über die Ernte.', speaker: 1 },
  ];
  assert.deepEqual(buildScriptBlocks(segs, { duration: 20, offGap: 3 }).map((b) => b.type), ['OT', 'OT']); // ohne Pegel: 2,8 s → kein OFF
  const blocks = buildScriptBlocks(segs, { duration: 20, levels, offGap: 3 });
  assert.deepEqual(blocks.map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.ok(Math.abs(blocks[1].start - 10) < 0.15 && Math.abs(blocks[1].end - 13.8) < 0.15, JSON.stringify(blocks[1]));
});

test('Textgerüst: kurzer Einwurf – nach langem OT fällt er weg, nach kurzem Block wird es ein Sit', () => {
  const lang = [
    { start: 0, end: 12, text: 'Ich erzähle jetzt ausführlich, wie mein Tag auf dem Hof beginnt.', speaker: 0 },
    { start: 12.2, end: 13, text: 'Ja.', speaker: 1 },
    { start: 13.2, end: 25, text: 'Zuerst füttere ich die Hühner und dann melke ich die Kühe.', speaker: 0 },
  ];
  const b1 = buildScriptBlocks(lang, { duration: 25 });
  assert.deepEqual(b1.map((b) => b.type), ['OT']);
  assert.deepEqual(b1[0].speakers, [0]);
  assert.ok(!/Ja\./.test(b1[0].full), b1[0].full);
  assert.match(b1[0].full, /Kühe\.$/);
  // Mehrere Einwürfe in einem langen Monolog teilen ihn nicht
  const mehrfach = [
    { start: 0, end: 20, text: 'Ich erzähle jetzt ganz ausführlich, wie mein Tag auf dem Hof beginnt und was alles anfällt.', speaker: 0 },
    { start: 20.2, end: 21, text: 'Ja.', speaker: 1 },
    { start: 21.2, end: 26, text: 'Dann geht es in den Stall.', speaker: 0 },
    { start: 26.2, end: 27, text: 'Genau.', speaker: 1 },
    { start: 27.2, end: 47, text: 'Danach fahre ich mit dem Traktor auf das Feld und bleibe dort bis zum Mittagessen.', speaker: 0 },
  ];
  assert.deepEqual(buildScriptBlocks(mehrfach, { duration: 47 }).map((b) => b.type), ['OT']);
  // Lücke nach einem Einwurf wird ab dem Einwurf gemessen: insgesamt nie 2 s still → ein OT
  const luecke = [
    { start: 0, end: 12, text: 'Ich erzähle jetzt ausführlich, wie mein Tag auf dem Hof beginnt.', speaker: 0 },
    { start: 12.3, end: 12.8, text: 'Ja.', speaker: 1 },
    { start: 14.3, end: 26, text: 'Zuerst füttere ich die Hühner und dann melke ich die Kühe.', speaker: 0 },
  ];
  assert.deepEqual(buildScriptBlocks(luecke, { duration: 26 }).map((b) => b.type), ['OT']);
  // … auch wenn danach eine dritte Stimme kommt: kein falsches OFF über dem Einwurf
  const drei = buildScriptBlocks([luecke[0], { start: 13.5, end: 14, text: 'Ja.', speaker: 1 },
    { start: 15.5, end: 20, text: 'Ich bringe gleich den Kaffee raus.', speaker: 2 }], { duration: 20 });
  assert.deepEqual(drei.map((b) => [b.type, b.start, b.end]), [['OT', 0, 14], ['OT', 15.5, 20]]);
  // Eine kurze Frage ist kein Einwurf: Frage und Antwort werden ein Sit
  const frage = [
    { start: 0, end: 12, text: 'Ich erzähle jetzt ausführlich, wie mein Tag auf dem Hof beginnt.', speaker: 0 },
    { start: 12.2, end: 13, text: 'Und warum?', speaker: 1 },
    { start: 13.3, end: 25, text: 'Weil die Tiere nicht warten können, die wollen pünktlich ihr Futter.', speaker: 0 },
  ];
  const bf = buildScriptBlocks(frage, { duration: 25 });
  assert.deepEqual(bf.map((b) => [b.type, b.start]), [['OT', 0], ['Sit', 12.2]]);
  assert.match(bf[1].full, /^Und warum\? Weil/);
  const kurz = [
    { start: 0, end: 4, text: 'Hier ist der neue Stall.', speaker: 0 },
    { start: 4.2, end: 5, text: 'Super!', speaker: 1 },
  ];
  const b2 = buildScriptBlocks(kurz, { duration: 5 });
  assert.deepEqual(b2.map((b) => b.type), ['Sit']);
  assert.match(b2[0].full, /Super!$/);
});

test('Textgerüst: spricht dieselbe Person weiter, gibt es erst ab 8 s Pause ein OFF', () => {
  const erst = { start: 0, end: 10, text: 'Ich zeige euch heute unseren Kräutergarten hinter dem Haus.', speaker: 0 };
  const dann = (start, speaker = 0) => ({ start, end: start + 6, text: 'Hier wachsen Minze, Salbei und ganz viel Schnittlauch.', speaker });
  assert.deepEqual(buildScriptBlocks([erst, dann(15)], { duration: 21 }).map((b) => b.type), ['OT']);          // 5 s Pause
  assert.deepEqual(buildScriptBlocks([erst, dann(18.5)], { duration: 24.5 }).map((b) => b.type), ['OT', 'OFF', 'OT']); // 8,5 s
  assert.deepEqual(buildScriptBlocks([erst, dann(15, 1)], { duration: 21 }).map((b) => b.type), ['OT', 'OFF', 'OT']); // andere Stimme: ab 2 s
  // Einstellbar; eine größere OFF-Länge gilt auch für dieselbe Person
  assert.deepEqual(buildScriptBlocks([erst, dann(15)], { duration: 21, offGapSame: 4 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.deepEqual(buildScriptBlocks([erst, dann(18.5)], { duration: 24.5, offGap: 10 }).map((b) => b.type), ['OT']);
  // Grenze genau bei 8 s
  assert.deepEqual(buildScriptBlocks([erst, dann(17.9)], { duration: 23.9 }).map((b) => b.type), ['OT']);
  assert.deepEqual(buildScriptBlocks([erst, dann(18)], { duration: 24 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  // Nach einem weggefallenen Einwurf gilt dieselbe Regel
  const lang = { start: 0, end: 12, text: 'Ich zeige euch heute ausführlich, wie wir hier den Käse machen.', speaker: 0 };
  const ja = { start: 12.2, end: 12.7, text: 'Ja.', speaker: 1 };
  assert.deepEqual(buildScriptBlocks([lang, ja, dann(17.7)], { duration: 23.7 }).map((b) => b.type), ['OT']);
  assert.deepEqual(buildScriptBlocks([lang, ja, dann(21.2)], { duration: 27.2 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  // Zwei Einwürfe derselben Stimme mit Pause dazwischen bleiben Einwürfe
  const genau = { start: 15.7, end: 16.2, text: 'Genau.', speaker: 1 };
  assert.deepEqual(buildScriptBlocks([lang, ja, genau, { ...dann(16.4), end: 28 }], { duration: 28 }).map((b) => b.type), ['OT']);
  // Zuschneiden auf die Zeitleiste macht bei derselben Person kein OFF aus 4 s Pause
  const zeit = buildScriptBlocks([
    { start: 0, end: 15, text: 'Die Ziegen sind heute schon draußen.', speaker: 0 },
    { start: 15, end: 20, text: 'Gleich holen wir sie wieder rein.', speaker: 0 },
  ], { duration: 20, speech: [[0, 6], [10, 20]] });
  assert.deepEqual(zeit.map((b) => b.type), ['OT']);
  // … auch wenn auf der anderen Seite eine andere Stimme spricht (Schwelle je Seite)
  const seite = buildScriptBlocks([
    { start: 0, end: 5, text: 'Die Ziegen sind heute schon draußen.', speaker: 0 },
    { start: 5, end: 20, text: 'Gleich holen wir sie wieder rein, bevor es regnet.', speaker: 0 },
    { start: 20.3, end: 23, text: 'Ich helfe dir dabei.', speaker: 1 },
  ], { duration: 23, speech: [[0, 6], [13.2, 20], [20.3, 23]] });
  assert.ok(!seite.some((b) => b.type === 'OFF'), JSON.stringify(seite.map((b) => b.type)));
  // Die Hauptsprache am Ende bleibt, auch wenn sie in eine andere Stimme weiterläuft
  const haupt = buildScriptBlocks([
    { start: 0, end: 5, text: 'Wie war der Markt?', speaker: 0 },
    { start: 5, end: 20, text: 'Der Markt war voll, wir haben fast alle Eier und den ganzen Käse verkauft.', speaker: 1 },
    { start: 20, end: 24, text: 'Das freut mich sehr.', speaker: 2 },
  ], { duration: 24, speech: [[0, 5.8], [6.2, 6.9], [12, 21.5], [21.8, 24]] });
  assert.ok(!haupt.some((b) => b.type === 'OFF'), JSON.stringify(haupt.map((b) => [b.type, b.start, b.end])));
  // Zwei kurze Abschnitte derselben Person ergeben zusammen einen langen Beitrag; „Ja.“ danach fällt weg
  assert.deepEqual(buildScriptBlocks([
    { start: 0, end: 5, text: 'Heute backen wir zusammen ein Brot.', speaker: 0 },
    { start: 5.5, end: 10.5, text: 'Dafür brauchen wir Mehl, Wasser und Salz.', speaker: 0 },
    { start: 10.7, end: 11.2, text: 'Ja.', speaker: 1 },
  ], { duration: 11.2 }).map((b) => b.type), ['OT']);
  // Überlappende Abschnitte zählen nicht doppelt: 7,5 s gesprochen = kurz → Einwurf macht ein Sit
  assert.deepEqual(buildScriptBlocks([
    { start: 0, end: 4.5, text: 'Heute backen wir zusammen ein Brot.', speaker: 0 },
    { start: 3, end: 7.5, text: 'Dafür brauchen wir Mehl und Wasser.', speaker: 0 },
    { start: 7.6, end: 8, text: 'Mhm.', speaker: 1 },
  ], { duration: 8 }).map((b) => b.type), ['Sit']);
  // Eine Frage mit „Mhm.“ derselben Stimme danach ist kein Einwurf und geht nicht verloren
  const echt = buildScriptBlocks([lang, { start: 12.2, end: 12.8, text: 'Echt?', speaker: 1 },
    { start: 17.8, end: 18.1, text: 'Mhm.', speaker: 1 }, { ...dann(18.5), end: 28 }], { duration: 28 });
  assert.ok(echt.some((b) => /Echt\?/.test(b.full)), JSON.stringify(echt.map((b) => [b.type, b.full])));
  // Nach einem weggefallenen Einwurf zählt die eigene Pause der Person: 11,7 s → OFF
  const eigenePause = buildScriptBlocks([
    { start: 0, end: 10, text: 'Ich zeige euch heute ausführlich, wie wir hier den Käse machen.', speaker: 0 },
    { start: 11.9, end: 13.8, text: 'Ja, genau.', speaker: 1 },
    { start: 21.7, end: 30, text: 'Jetzt kommt die Milch in den großen Kessel.', speaker: 0 },
  ], { duration: 30 });
  assert.deepEqual(eigenePause.map((b) => [b.type, b.start]), [['OT', 0], ['OFF', 13.8], ['OT', 21.7]]);
  // Ein Einwurf erst nach 3 s Pause ist kein Einwurf mehr, sondern ein eigener Block
  assert.deepEqual(buildScriptBlocks([lang, { ...ja, start: 15, end: 15.5 }], { duration: 15.5 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  // Ohne Sprecher-Erkennung gilt die gewählte OFF-Länge überall
  const ohne = [
    { start: 0, end: 9, text: 'Am Morgen fahren wir mit dem Traktor raus.', },
    { start: 12, end: 20, text: 'Dann wird das Heu gewendet.', },
  ];
  assert.deepEqual(buildScriptBlocks(ohne, { duration: 20 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.deepEqual(buildScriptBlocks(ohne, { duration: 20, offGap: 5 }).map((b) => b.type), ['OT']);
  // … auch bei Sprecher-Angabe null, und null/undefined gemischt ist dieselbe unbekannte Stimme
  const mitNull = ohne.map((x) => ({ ...x, speaker: null }));
  assert.deepEqual(buildScriptBlocks(mitNull, { duration: 20 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.deepEqual(buildScriptBlocks([mitNull[0], { ...ohne[1], start: 9.5 }], { duration: 20 }).map((b) => b.type), ['OT']);
});

test('Textgerüst: lang oder kurz zählt nach gesprochener Zeit, nicht nach Pausen dazwischen', () => {
  // A spricht nur 3 s (mit 5 s Pause dazwischen), B antwortet kurz → kurzes Hin und Her = Sit
  assert.deepEqual(buildScriptBlocks([
    { start: 0, end: 1.5, text: 'Schau mal da drüben.', speaker: 0 },
    { start: 6.5, end: 8, text: 'Da steht ein Reh.', speaker: 0 },
    { start: 8.3, end: 8.8, text: 'Oh ja!', speaker: 1 },
  ], { duration: 8.8 }).map((b) => b.type), ['Sit']);
  // A spricht 4 s, B antwortet ohne Pause lang → Wechsel ohne Pause = Sit
  assert.deepEqual(buildScriptBlocks([
    { start: 0, end: 2, text: 'Kommst du heute mit?', speaker: 0 },
    { start: 7, end: 9, text: 'Wir fahren zum See.', speaker: 0 },
    { start: 9.1, end: 20, text: 'Ja, gern, ich packe nur noch schnell die Badesachen und etwas zu essen ein.', speaker: 1 },
  ], { duration: 20 }).map((b) => b.type), ['Sit']);
});

test('Textgerüst: OFF ab 2 Sekunden (Standard), kürzere Pausen bleiben im Block', () => {
  const segs = [
    { start: 0, end: 9, text: 'Ich zeige euch heute den Weg hinauf zur Alm.', speaker: 0 },
    { start: 10.5, end: 19, text: 'Der Weg ist steil, aber oben gibt es frische Milch.', speaker: 0 }, // 1,5 s Pause
    { start: 21.2, end: 30, text: 'Ich bin die Wirtin und koche hier seit zwanzig Jahren.', speaker: 1 }, // 2,2 s Pause
  ];
  assert.deepEqual(buildScriptBlocks(segs, { duration: 30 }).map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.equal(buildScriptBlocks(segs, { duration: 30 })[0].end, 19);
});

test('Textgerüst: Pausen unter Musik zeigt die Sprach-Zeitleiste der Sprecher-Erkennung', () => {
  // Musik läuft durchgehend (die Lautstärke zeigt keine Pause); gesprochen wird 0–6 s und 14–20 s.
  const levels = new Float32Array(200).fill(0.2);
  const speech = [[0, 6], [14, 20]];
  // Whisper setzt die Grenze zu früh: Abschnitt 2 beginnt noch in der Sprache von Abschnitt 1
  const frueh = [
    { start: 0, end: 5, text: 'Die Boote liegen schon im Wasser.', speaker: 0 },
    { start: 5, end: 20, text: 'Gleich paddeln wir rüber zur kleinen Insel.', speaker: 1 },
  ];
  assert.deepEqual(buildScriptBlocks(frueh, { duration: 20, levels }).map((b) => b.type), ['Sit']);
  const b1 = buildScriptBlocks(frueh, { duration: 20, levels, speech });
  assert.deepEqual(b1.map((b) => [b.type, b.start, b.end]), [['OT', 0, 5], ['OFF', 5, 14], ['OT', 14, 20]]);
  // … oder zu spät: Abschnitt 1 reicht bis in die Sprache von Abschnitt 2
  const spaet = [
    { start: 0, end: 15, text: 'Die Boote liegen schon im Wasser.', speaker: 0 },
    { start: 15, end: 20, text: 'Gleich paddeln wir rüber.', speaker: 1 },
  ];
  const b2 = buildScriptBlocks(spaet, { duration: 20, levels, speech });
  assert.deepEqual(b2.map((b) => [b.type, b.start, b.end]), [['OT', 0, 6], ['OFF', 6, 15], ['OT', 15, 20]]);
  // Ohne Nachbarn bleibt ein Abschnitt mit Pausen ganz (welche Wörter wohin gehören, ist unbekannt)
  const allein = buildScriptBlocks([{ start: 0, end: 13, text: 'Erst holen wir die Ruder, dann die Westen, und am Ende schieben wir das Boot gemeinsam ins Wasser hinein.', speaker: 0 }],
    { duration: 13, speech: [[0, 3], [5, 8], [10, 13]] });
  assert.deepEqual(allein.map((b) => [b.type, b.start, b.end]), [['OT', 0, 13]]);
  // Am Anfang 8 s nur Musik → das Textgerüst beginnt mit OFF
  const intro = buildScriptBlocks([{ start: 0, end: 12, text: 'Hallo und herzlich willkommen auf dem Hof.', speaker: 0 }],
    { duration: 12, speech: [[8, 12]] });
  assert.deepEqual(intro.map((b) => b.type), ['OFF', 'OT']);
  assert.equal(intro[1].start, 8);
});

test('Textgerüst: Sprachbereiche, die nur knapp in einen Abschnitt ragen, zählen nicht', () => {
  const lang = { start: 0, end: 11, text: 'Den Zaun am Bienenhaus müssen wir vor dem Winter noch einmal komplett streichen.', speaker: 0 };
  const kurz = { start: 11, end: 15, text: 'Die grüne Farbe liegt schon im Schuppen.', speaker: 1 };
  // Whisper-Grenzen stoßen lückenlos aneinander, die Zeitleiste zeigt 0,8 s Pause → zwei OT
  const mitPause = buildScriptBlocks([lang, kurz], { duration: 15, speech: [[0, 11.2], [12, 15]] });
  assert.deepEqual(mitPause.map((b) => [b.type, b.start]), [['OT', 0], ['OT', 12]]);
  // Durchgehend gesprochen → Wechsel ohne Pause → Sit
  assert.deepEqual(buildScriptBlocks([lang, kurz], { duration: 15, speech: [[0, 15]] }).map((b) => b.type), ['Sit']);
  // Sehr kurze Antwort mitten in durchgehender Sprache zählt (kurzes Hin und Her = Sit)
  const schnell = buildScriptBlocks([
    { start: 0, end: 2, text: 'Kommst du mit?', speaker: 0 },
    { start: 2, end: 2.4, text: 'Nein.', speaker: 1 },
  ], { duration: 2.4, speech: [[0, 2.4]] });
  assert.deepEqual(schnell.map((b) => [b.type, b.ignored]), [['Sit', undefined]]);
  // Ohne lange Pause im Abschnitt wird nichts abgeschnitten, auch wenn Sprache in den Nachbarn reicht
  const ohnePause = buildScriptBlocks([
    { start: 0, end: 5, text: 'Schau mal, die Kühe.', speaker: 0 },
    { start: 5, end: 20, text: 'Die kommen jeden Abend von allein zurück in den Stall, wenn es dunkel wird.', speaker: 1 },
  ], { duration: 20, speech: [[0, 6], [6.5, 20]] });
  assert.deepEqual(ohnePause.map((b) => [b.type, b.start]), [['Sit', 0]]);
  // Nur die Sprache des Nachbarn wird abgeschnitten, eigene Sprache am Rand bleibt
  const rand = buildScriptBlocks([
    { start: 0, end: 10, text: 'Hier sieht man den alten Hof von vorne.', speaker: 0 },
    { start: 10, end: 30, text: 'Das Dach haben wir letztes Jahr neu gedeckt.', speaker: 1 },
  ], { duration: 30, speech: [[0, 10.5], [11, 14], [25, 30]] });
  assert.equal(rand.find((b) => b.speakers.includes(1)).start, 11);
  // Die Hauptsprache eines Abschnitts läuft ohne Pause in den nächsten weiter: kein falsches OFF
  const weiter = buildScriptBlocks([
    { start: 0, end: 5, text: 'Wir waren gestern am Markt.', speaker: 0 },
    { start: 5, end: 20, text: 'Dort gab es frische Erdbeeren und ganz viel Spargel.', speaker: 1 },
    { start: 20, end: 24, text: 'Und danach sind wir heim.', speaker: 1 },
  ], { duration: 24, speech: [[0, 5.8], [12, 21.5], [21.8, 24]] });
  assert.deepEqual(weiter.map((b) => [b.type, b.start, b.end]), [['OT', 0, 5], ['OFF', 5, 12], ['OT', 12, 24]]);
  // … auch wenn am Anfang ein Rest eigener Sprache übrig bleibt: die Hauptsprache bleibt ganz
  const rest = buildScriptBlocks([
    { start: 0, end: 5, text: 'Wir waren gestern am Markt.', speaker: 0 },
    { start: 5, end: 20, text: 'Dort gab es frische Erdbeeren und ganz viel Spargel.', speaker: 0 },
    { start: 20, end: 24, text: 'Und danach sind wir heim.', speaker: 0 },
  ], { duration: 24, speech: [[0, 5.8], [6.2, 6.9], [12, 21.5], [21.8, 24]] });
  assert.deepEqual(rest.map((b) => [b.type, b.start, b.end]), [['OT', 0, 24]]);
  // Hauptsprache am Anfang, die aus dem vorigen Abschnitt herüberläuft, bleibt ebenfalls
  const vorn = buildScriptBlocks([
    { start: 0, end: 5, text: 'Wie war die Ernte?', speaker: 0 },
    { start: 5, end: 20, text: 'Die Ernte war dieses Jahr richtig gut, vor allem bei den Äpfeln.', speaker: 1 },
  ], { duration: 20, speech: [[0, 12], [16, 17]] });
  assert.deepEqual(vorn.map((b) => [b.type, b.start, b.end]), [['Sit', 0, 17], ['OFF', 17, 20]]);
  // Kein Sprachbereich, der nur hauchdünn (unter 0,1 s) hineinragt
  const hauch = buildScriptBlocks([{ start: 5, end: 5.15, text: 'Ja.', speaker: 0 }], { duration: 6, speech: [[0, 5.08]] });
  assert.equal(hauch[0].ignored, 'Ja.');
  // Pause genau an der Grenze (Fließkomma: 4,6 − 3,1 = 1,4999…) zählt als OFF
  const grenze = buildScriptBlocks([
    { start: 0, end: 3.1, text: 'Erster Satz am Teich.', speaker: 0 },
    { start: 4.6, end: 8, text: 'Zweiter Satz am Teich.', speaker: 1 },
  ], { duration: 8, offGap: 1.5 });
  assert.deepEqual(grenze.map((b) => b.type), ['OT', 'OFF', 'OT']);
  // Kurze Antwort, die Whisper um mehr als ihre halbe Länge verschoben hat, zählt trotzdem
  const verschoben = buildScriptBlocks([
    { start: 0, end: 4, text: 'Kommst du morgen mit zum Markt?', speaker: 0 },
    { start: 4.5, end: 5.1, text: 'Ja, klar.', speaker: 1 },
  ], { duration: 5.5, speech: [[0, 4], [4.85, 5.45]] });
  assert.deepEqual(verschoben.map((b) => [b.type, b.ignored]), [['Sit', undefined]]);
  // Überlappende Sprachbereiche werden zusammengefasst
  const ueber = buildScriptBlocks([
    { start: 0, end: 20, text: 'Heute misten wir den ganzen Stall aus und streuen frisches Stroh ein.', speaker: 0 },
    { start: 24, end: 30, text: 'Jetzt sind die Ziegen wieder zufrieden.', speaker: 1 },
  ], { duration: 30, speech: [[0, 20], [5, 6], [24, 30]] });
  assert.deepEqual(ueber.map((b) => [b.type, b.start, b.end]), [['OT', 0, 20], ['OFF', 20, 24], ['OT', 24, 30]]);
  // Eigene Sprache am Ende, die nicht im Nachbarn liegt, bleibt
  const eigen = buildScriptBlocks([
    { start: 0, end: 14, text: 'Erst kommt der Teig in die Form, dann in den Ofen.', speaker: 0 },
    { start: 20, end: 25, text: 'Nach einer Stunde ist das Brot fertig.', speaker: 1 },
  ], { duration: 25, speech: [[0, 8], [12, 13], [20, 25]] });
  assert.equal(eigen[0].end, 13);
  // Kleiner eigener Sprachbereich ganz im Abschnitt zählt
  const blocks = buildScriptBlocks([{ start: 0, end: 4, text: 'Ja.', speaker: 0 }], { duration: 4, speech: [[2.5, 2.8]] });
  assert.deepEqual(blocks.map((b) => [b.type, b.start, b.end]), [['OFF', 0, 2.5], ['OT', 2.5, 2.8]]);
});

test('Textgerüst: Abschnitt ohne erkannte Stimme zählt nicht, bleibt aber als Hinweis sichtbar', () => {
  const segs = [
    { start: 0, end: 6, text: 'Morgen ernten wir die ersten Kürbisse.', speaker: 0 },
    { start: 8, end: 11, text: 'Bis zum nächsten Mal.', speaker: 0 }, // nur Musik, Whisper hat das erfunden
  ];
  const blocks = buildScriptBlocks(segs, { duration: 14, speech: [[0, 6]] });
  assert.deepEqual(blocks.map((b) => b.type), ['OT', 'OFF']);
  assert.equal(blocks[1].ignored, 'Bis zum nächsten Mal.');
  assert.equal(blocks[0].ignored, undefined);
  // Ohne Sprach-Zeitleiste bleibt der Abschnitt Sprache
  assert.deepEqual(buildScriptBlocks(segs, { duration: 14 }).map((b) => b.type), ['OT', 'OFF']);
  // Nur weggelassener Text: ein OFF über alles, mit Hinweis
  const nur = buildScriptBlocks([segs[1]], { duration: 1.5, speech: [[20, 21]] });
  assert.deepEqual(nur.map((b) => [b.type, b.ignored]), [['OFF', 'Bis zum nächsten Mal.']]);
});

test('Textgerüst: kurze Frage und Antwort sind ein Sit, auch wenn die Antwort lang ist', () => {
  const segs = [
    { start: 0, end: 3, text: 'Welches Brot backst du am liebsten?', speaker: 0 },
    { start: 3.8, end: 20, text: 'Am liebsten Roggenbrot mit Kümmel, das braucht zwar einen Tag Vorlauf, aber der Teig wird dann richtig gut.', speaker: 1 },
  ];
  const blocks = buildScriptBlocks(segs, { duration: 20 });
  assert.deepEqual(blocks.map((b) => b.type), ['Sit']);
  assert.deepEqual(blocks[0].speakers, [0, 1]);
  // Anführungszeichen nach dem Fragezeichen
  const zitiert = segs.map((s, i) => (i === 0 ? { ...s, text: 'Sie fragt: „Welches Brot backst du am liebsten?“' } : s));
  assert.deepEqual(buildScriptBlocks(zitiert, { duration: 20 }).map((b) => b.type), ['Sit']);
  // Ohne Fragezeichen bleibt es bei zwei OT
  const ohne = segs.map((s, i) => (i === 0 ? { ...s, text: 'Erzähl mal vom Backen.' } : s));
  assert.deepEqual(buildScriptBlocks(ohne, { duration: 20 }).map((b) => b.type), ['OT', 'OT']);
});

test('Textgerüst: Wechsel der Stimme ohne Pause ist ein Gespräch (Sit), mit Pause zwei OT', () => {
  const lang = { start: 0, end: 11, text: 'Den Zaun am Bienenhaus müssen wir vor dem Winter noch einmal komplett streichen.', speaker: 0 };
  const antwort = (start) => ({ start, end: start + 4, text: 'Die grüne Farbe liegt schon im Schuppen.', speaker: 1 });
  assert.deepEqual(buildScriptBlocks([lang, antwort(11.1)], { duration: 15.1 }).map((b) => b.type), ['Sit']);
  assert.deepEqual(buildScriptBlocks([lang, antwort(12)], { duration: 16 }).map((b) => b.type), ['OT', 'OT']);
  // Ein Sit enthält höchstens einen langen Beitrag
  const lang3 = { start: 15.1, end: 30, text: 'Und danach kommt noch der zweite Anstrich, damit das Holz den Regen gut übersteht.', speaker: 0 };
  const lsl = buildScriptBlocks([lang, antwort(11), lang3], { duration: 30 });
  assert.deepEqual(lsl.map((b) => [b.type, b.start]), [['Sit', 0], ['OT', 15.1]]);
  // … eine kurze Frage dazwischen geht mit zur Antwort
  const frage = { start: 11, end: 15, text: 'Und wie lange trocknet das dann?', speaker: 1 };
  const lql = buildScriptBlocks([lang, frage, lang3], { duration: 30 });
  assert.deepEqual(lql.map((b) => [b.type, b.start]), [['OT', 0], ['Sit', 11]]);
  // Zwei lange Beiträge direkt hintereinander bleiben zwei OT
  const lang2 = { start: 11.1, end: 21, text: 'Dafür brauchen wir zwei Leitern, drei Pinsel und am besten einen trockenen Samstag.', speaker: 1 };
  assert.deepEqual(buildScriptBlocks([lang, lang2], { duration: 21 }).map((b) => b.type), ['OT', 'OT']);
});

test('Textgerüst: englischer Liedtext in der Musik zählt nicht als Sprache', () => {
  const segs = [
    { start: 0, end: 8, text: 'Heute Abend grillen wir hinten im Garten.', speaker: 0 },
    // frei erfundene Liedzeilen (Whisper hört den Anfang oft halb deutsch)
    { start: 12, end: 15, text: 'Komm mit mir, I see the morning light', speaker: 1 },
    { start: 15, end: 18, text: 'And we keep running to the river', speaker: 1 },
    { start: 18, end: 21, text: 'They will never know my name', speaker: 0 },
    { start: 26, end: 32, text: 'Das Grillen war richtig gut, alle sind satt geworden.', speaker: 0 },
  ];
  assert.deepEqual([...findForeignLyrics(segs)], [1, 2, 3]);
  const blocks = buildScriptBlocks(segs, { duration: 32 });
  assert.deepEqual(blocks.map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.ok(!blocks.some((b) => /river/.test(b.full)));
  assert.match(blocks[1].ignored, /^Komm mit mir.*my name$/); // weggelassen, aber sichtbar
  // Nur bei eingestelltem Deutsch: bei „automatisch“ kann die Aufnahme jede Sprache haben
  assert.ok(buildScriptBlocks(segs, { duration: 32, language: 'auto' }).some((b) => /river/.test(b.full)));
  // Liedtext, den die Sprecher-Erkennung der nächsten Person zuordnet, verhindert das OFF nicht
  const zugeordnet = buildScriptBlocks([
    { start: 0, end: 9.9, text: 'Am Nachmittag haben wir die ganzen Kartoffeln auf dem Acker geerntet.', speaker: 1 },
    { start: 10, end: 10.8, text: 'You and me forever', speaker: 0 },
    { start: 10.8, end: 11.5, text: 'Never let me go', speaker: 0 },
    { start: 11.5, end: 25, text: 'Danach haben wir alle zusammen im Hof gesessen und noch lange über den Tag geredet.', speaker: 0 },
  ], { duration: 25, speech: [[0, 9.9], [10, 12], [15, 25]] });
  assert.deepEqual(zugeordnet.map((b) => b.type), ['OT', 'OFF', 'OT']);
  // Bei englischer Aufnahme bleibt alles
  assert.ok(buildScriptBlocks(segs, { duration: 32, language: 'en' }).some((b) => /river/.test(b.full)));
  // Ein einzelner englischer Satz (Zitat) bleibt
  const zitat = [segs[0], { start: 8.5, end: 10, text: 'You never know what you get.', speaker: 0 },
    { start: 10.2, end: 14, text: 'Das hat meine Tante immer gesagt.', speaker: 0 }];
  assert.equal(findForeignLyrics(zitat).size, 0);
  // … auch wenn danach ein Satz im Dialekt folgt
  assert.equal(findForeignLyrics([...zitat, { start: 14.5, end: 16, text: 'Das is echt so gewesen.', speaker: 0 }]).size, 0);
  // Englischer Liedtitel im deutschen Satz ist kein Liedtext
  const titel = [
    { start: 0, end: 3, text: 'Als Erstes spielt die Kapelle Over the Rainbow.', speaker: 0 },
    { start: 3.2, end: 6, text: 'Danach kommt noch Stand by Me.', speaker: 0 },
    { start: 6.5, end: 12, text: 'Und dann tanzen wir alle zusammen im Saal.', speaker: 0 },
  ];
  assert.equal(findForeignLyrics(titel).size, 0);
  // Bairisch („i“ = ich, „is“ = ist) ist kein Englisch
  const dialekt = [
    { start: 0, end: 3, text: 'I glaub, des is a Wahnsinn.', speaker: 0 },
    { start: 3.2, end: 6, text: 'Und des is a so gwesn, wia i des gsagt hab.', speaker: 0 },
    { start: 6.5, end: 10, text: 'Mia ham des Heu scho eina.', speaker: 1 },
  ];
  assert.equal(findForeignLyrics(dialekt).size, 0);
  assert.equal(findForeignLyrics([
    { start: 0, end: 3, text: 'I moan, i hob des scho gsagt.', speaker: 0 },
    { start: 3.2, end: 6, text: 'I hob recht, i woaß des.', speaker: 0 },
    { start: 6.5, end: 18, text: 'Dann sind wir alle zusammen heimgegangen, haben noch gegessen, den Hund gefüttert und dann den Abend gemütlich ausklingen lassen.', speaker: 1 },
  ]).size, 0);
  // Englisches Zitat + langer deutscher Satz mit einem englischen Ausdruck: beides bleibt Sprache
  assert.equal(findForeignLyrics([
    { start: 0, end: 3, text: 'Thank you so much for everything!', speaker: 0 },
    { start: 3.2, end: 13, text: 'Das hat der Verkäufer zu uns gesagt, oh my God, der hat sich richtig gefreut über unseren Besuch.', speaker: 0 },
    { start: 14, end: 20, text: 'Danach sind wir noch zum Bäcker gegangen.', speaker: 0 },
  ]).size, 0);
  // Lied aus zwei Zeilen + langer deutscher Satz mit einem englischen Wort danach: nur das Lied fällt weg
  assert.deepEqual([...findForeignLyrics([
    { start: 0, end: 3, text: 'And we keep running to the river', speaker: 0 },
    { start: 3, end: 6, text: 'They will never know my name', speaker: 0 },
    { start: 6.5, end: 16, text: 'Das Lied lief auf der Feier, und am Ende haben alle laut mitgesungen, das war echt so ein Moment, you know, für uns.', speaker: 1 },
    { start: 17, end: 24, text: 'Danach haben wir noch lange zusammen gesessen und geredet.', speaker: 1 },
  ])], [0, 1]);
  // Überwiegend englische Aufnahme: nichts entfernen
  assert.equal(findForeignLyrics(segs.slice(1, 4)).size, 0);
});

test('Kürzen: erste 3 … Schlagwörter … letzte 3, kurze Texte bleiben ganz', () => {
  const t = 'Wir sind heute ziemlich früh losgegangen, weil der Wetterbericht für den Nachmittag ein Gewitter angesagt hat. Auf dem Weg zur Hütte haben wir dann tatsächlich zwei Gämsen gesehen, das war für mich ein echtes Highlight, und oben angekommen gab es Kaiserschmarrn mit Zwetschkenröster, den hat sich nach dem langen Aufstieg wirklich jeder verdient gehabt.';
  const freq = wordFrequencies([t]);
  const short = shortenText(t, { freq });
  assert.ok(short.startsWith('Wir sind heute…'), short);
  assert.ok(short.endsWith('…jeder verdient gehabt.'), short);
  const kept = short.split(/…|\s+/).filter(Boolean).length;
  const total = t.split(/\s+/).length;
  assert.ok(kept / total < 0.35, `zu wenig gekürzt: ${kept}/${total}`);
  assert.ok(short.split('…').length >= 3, 'keine Schlagwörter in der Mitte');
  assert.ok(!/\.…/.test(short), 'Satzpunkt vor …');
  assert.equal(shortenText('Ja, das hat wirklich richtig gut geklappt.'), 'Ja, das hat wirklich richtig gut geklappt.');
});

test('Kürzen: der Regler wirkt auch bei langen Blöcken', () => {
  const long = [
    'Auf dem Markt verkaufen wir Kartoffeln, Karotten und frischen Salat aus dem eigenen Garten.',
    'Am Samstag kommen meistens die Stammkunden aus dem Dorf und fragen nach Eiern und Honig.',
    'Meine Schwester backt dafür jede Woche Brot im alten Holzofen hinter der Scheune.',
    'Im Sommer haben wir zusätzlich Erdbeeren, Kirschen und Marillen von den Bäumen am Hang.',
    'Der Stand lohnt sich, auch wenn wir um fünf Uhr früh aufstehen und alles aufladen müssen.',
    'Ohne die Hilfe der Nachbarn wäre das an manchen Tagen gar nicht zu schaffen, ehrlich gesagt.',
    'Nächstes Jahr wollen wir einen kleinen Hofladen eröffnen, direkt neben dem Kuhstall.',
    'Dafür brauchen wir noch eine Genehmigung von der Gemeinde und ein bisschen Glück beim Wetter.',
    'Die Kinder helfen am Wochenende mit und verkaufen selbstgemachte Marmelade an die Touristen.',
    'Am Abend sind alle müde, aber zufrieden, und wir sitzen noch lange auf der Bank vor dem Haus.',
  ].join(' '); // ca. 150 Wörter
  const freq = wordFrequencies([long]);
  const lens = [0.12, 0.22, 0.32, 0.45, 0.6].map((ratio, i) =>
    shortenText(long, { ratio, freq, ...[{ groupSize: 2, maxGroups: 2 }, { groupSize: 2, maxGroups: 3 }, { groupSize: 3, maxGroups: 5 }, { groupSize: 3, maxGroups: 8 }, { groupSize: 4, maxGroups: 12 }][i] })
      .split(/…|\s+/).filter(Boolean).length);
  for (let i = 1; i < lens.length; i++) assert.ok(lens[i] > lens[i - 1], `Stufe ${i + 1} nicht länger als Stufe ${i}: ${lens}`);
});

test('Kürzen: „…“ nur dort, wo wirklich etwas fehlt; Datum mit Punkt bleibt zusammen', () => {
  // Schlagwort direkt nach den ersten 3 Wörtern → kein „…“ dazwischen
  const t = 'Möchtest du noch Kaffee oder lieber einen Tee, wir haben auch Kakao und Kuchen da.';
  const s1 = shortenText(t);
  assert.ok(!s1.startsWith('Möchtest du noch…Kaffee'), s1);
  const d = shortenText('Wir fahren dann gemeinsam am 15. Mai mit dem Traktor zum großen Erntefest ins Nachbardorf hinüber.');
  assert.ok(!/…15…/.test(d), d);
  // Ein Wort aus Anfang oder Ende wird nicht noch einmal als Schlagwort gewählt
  const r = shortenText('Also mit Anna habe ich lange über Anna und ihre Pferde gesprochen und wie es mit Anna weitergeht.');
  assert.ok((r.match(/Anna/g) ?? []).length <= 2, r);
});

test('Word-Datei: Querformat, 3 Spalten, grüne Titelzeile, OFF fett, Timecode, Sonderzeichen sicher', () => {
  const files = scriptDocxFiles({
    title: 'Hof Anna & <Folge 3>\u000b',
    blocks: [
      { type: 'OFF', label: 'OFF', text: 'Sprechertext zum Hof.', start: 0, end: 4 },
      { type: 'OT', label: 'OT Anna', text: 'Heute zeige ich…Tomaten…am besten.', start: 4, end: 21 },
      { type: 'Sit', label: 'Sit', text: 'Grüß dich…komm rein.', start: 26, end: 33 },
    ],
  });
  const doc = files['word/document.xml'];
  for (const k of ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml']) assert.ok(files[k], k);
  assert.match(doc, /w:orient="landscape"/);
  assert.equal((doc.match(/<w:gridCol /g) ?? []).length, 3);
  assert.match(doc, /w:fill="8DD873"/);
  assert.match(doc, /Hof Anna &amp; &lt;Folge 3&gt;</);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(doc), 'Steuerzeichen im XML');
  assert.match(doc, /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">OFF<\/w:t>/);
  assert.match(doc, /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Sprechertext zum Hof\.<\/w:t>/, 'OFF-Text nicht fett');
  assert.match(doc, /OT Anna/);
  assert.match(doc, /00:04 – 00:21/);
  assert.equal((doc.match(/<w:tr>/g) ?? []).length, 4);
  assert.equal((doc.match(/<w:tc>/g) ?? []).length, (doc.match(/<\/w:tc>/g) ?? []).length);
});

test('Titel aus Dateiname', () => {
  assert.equal(titleFromFileName('Folge_3_Anna mit Kamera.mp4'), 'Folge 3 Anna mit Kamera');
});

test('clusterSpeakers trennt zwei Stimmen und hält feste Anzahl ein', () => {
  const a = () => Float32Array.from([1, 0.1 * Math.random(), 0, 0.05]);
  const b = () => Float32Array.from([0, 0.1 * Math.random(), 1, 0.05]);
  const embs = [a(), b(), a(), b(), a()];
  assert.deepEqual(clusterSpeakers(embs), [0, 1, 0, 1, 0]);
  assert.deepEqual(clusterSpeakers(embs, { numSpeakers: 1 }), [0, 0, 0, 0, 0]);
  assert.equal(new Set(clusterSpeakers(embs, { numSpeakers: 3 })).size, 3);
});

test('clusterSpeakers: kurze Stimm-Schnipsel werden keine eigene Person', () => {
  const embs = [
    Float32Array.from([1, 0, 0]), Float32Array.from([0.95, 0.1, 0]), // Person A, 12 s
    Float32Array.from([0, 1, 0]), Float32Array.from([0.1, 0.95, 0]), // Person B, 12 s
    Float32Array.from([0.3, 0.1, 1]),                                 // 1 s Schnipsel, am ähnlichsten zu A
  ];
  const weights = [6, 6, 6, 6, 1];
  assert.deepEqual(clusterSpeakers(embs, { weights, threshold: 0.4 }), [0, 0, 1, 1, 2]);
  assert.deepEqual(clusterSpeakers(embs, { weights, threshold: 0.4, minWeight: 2 }), [0, 0, 1, 1, 0]);
  // … zur ähnlichsten großen Gruppe, nicht einfach zur ersten
  const zuB = [...embs.slice(0, 4), Float32Array.from([0.05, 0.4, 1])];
  assert.deepEqual(clusterSpeakers(zuB, { weights, threshold: 0.4, minWeight: 2 }), [0, 0, 1, 1, 1]);
  // Genau 2 s Gewicht reichen für eine eigene Person
  assert.deepEqual(clusterSpeakers(embs, { weights: [6, 6, 6, 6, 2], threshold: 0.4, minWeight: 2 }), [0, 0, 1, 1, 2]);
  // Lange eigene Stimme bleibt eine eigene Person
  const lang = [...weights.slice(0, 4), 5];
  assert.deepEqual(clusterSpeakers(embs, { weights: lang, threshold: 0.4, minWeight: 2 }), [0, 0, 1, 1, 2]);
  // Feste Anzahl: Mindestgewicht spielt keine Rolle
  assert.equal(new Set(clusterSpeakers(embs, { weights, numSpeakers: 3, minWeight: 2 })).size, 3);
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
