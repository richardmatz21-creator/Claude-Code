// Schnelle Tests der reinen Hilfsfunktionen (ohne Browser, ohne Modelle).
// Aufruf: node tests/unit.mjs
import assert from 'node:assert/strict';
import {
  planChunks, frameLevels, speechLevel, isQuiet, filterHallucinations, formatSrtTime,
  splitText, wrapLines, buildCues, toSrt, toTxt, clusterSpeakers, assignSpeakers,
  speakerTimeline, baseName, SAMPLE_RATE, planSpeechChunks, assembleChunk, chunkTimeToSource,
  groupParagraphs, activeSegments, findMatches, countMatches, replaceAll,
  buildScriptBlocks, shortenText, wordFrequencies, scriptDocxFiles, titleFromFileName,
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
    { start: 36, end: 38, text: 'Grüß dich!', speaker: 1 },                            // nach 6 s Stille: Hin und Her → Sit
    { start: 38.2, end: 40, text: 'Hallo, schön dass du da bist.', speaker: 0 },
    { start: 40.3, end: 42, text: 'Danke, gerne.', speaker: 1 },
    { start: 43, end: 45, text: 'Komm rein.', speaker: 0 },
  ];
  const blocks = buildScriptBlocks(segs, { duration: 52 });
  assert.deepEqual(blocks.map((b) => b.type), ['OFF', 'OT', 'OT', 'OFF', 'Sit', 'OFF']);
  assert.deepEqual(blocks[1].speakers, [0]);
  assert.equal(blocks[1].full, 'Heute zeige ich euch meinen Garten. Hier wachsen die Tomaten am besten.');
  assert.deepEqual(blocks[2].speakers, [1]);
  assert.deepEqual(blocks[4].speakers.sort(), [0, 1]);
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks.at(-1).end, 52);
  // OFF-Grenze einstellbar: bei 8 s gibt es zwischen 30 s und 36 s kein OFF mehr (Bens Beiträge verschmelzen)
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
    { start: 13.3, end: 20, text: 'Zweiter langer Beitrag über die Ernte.', speaker: 0 },
  ];
  assert.deepEqual(buildScriptBlocks(segs, { duration: 20 }).map((b) => b.type), ['OT']); // ohne Pegel: 2,8 s → kein OFF
  const blocks = buildScriptBlocks(segs, { duration: 20, levels });
  assert.deepEqual(blocks.map((b) => b.type), ['OT', 'OFF', 'OT']);
  assert.ok(Math.abs(blocks[1].start - 10) < 0.15 && Math.abs(blocks[1].end - 13.8) < 0.15, JSON.stringify(blocks[1]));
});

test('Textgerüst: kurzer Einwurf einer zweiten Stimme macht aus dem Block ein Sit', () => {
  const segs = [
    { start: 0, end: 12, text: 'Ich erzähle jetzt ausführlich, wie mein Tag auf dem Hof beginnt.', speaker: 0 },
    { start: 12.2, end: 13, text: 'Ja.', speaker: 1 },
    { start: 13.2, end: 25, text: 'Zuerst füttere ich die Hühner und dann melke ich die Kühe.', speaker: 0 },
  ];
  const blocks = buildScriptBlocks(segs, { duration: 25 });
  assert.deepEqual(blocks.map((b) => b.type), ['Sit', 'OT']);
  assert.match(blocks[0].full, /Ja\.$/);
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
