// Reine Hilfsfunktionen ohne Browser-Abhängigkeiten.
// Werden von der Seite, vom Hintergrund-Thread und von den Tests genutzt.

export const SAMPLE_RATE = 16000;

// ---------- Audio-Analyse ----------

function meanSquare(audio, from, to) {
  let sum = 0;
  const end = Math.min(to, audio.length);
  for (let i = from; i < end; i++) sum += audio[i] * audio[i];
  return end > from ? sum / (end - from) : 0;
}

/** Lautstärke (RMS) je 100-ms-Abschnitt. */
export function frameLevels(audio, sr = SAMPLE_RATE, frameSec = 0.1) {
  const frame = Math.max(1, Math.round(sr * frameSec));
  const levels = new Float32Array(Math.ceil(audio.length / frame));
  for (let f = 0; f < levels.length; f++) {
    levels[f] = Math.sqrt(meanSquare(audio, f * frame, (f + 1) * frame));
  }
  return levels;
}

/** Typische Sprach-Lautstärke der Datei (95. Perzentil der Abschnitte). */
export function speechLevel(levels) {
  if (levels.length === 0) return 0;
  const sorted = Array.from(levels).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/** Ist dieser Bereich praktisch still (mehr als 20 dB leiser als die Sprache)? */
export function isQuiet(levels, startSec, endSec, refLevel, frameSec = 0.1) {
  const a = Math.max(0, Math.floor(startSec / frameSec));
  const b = Math.min(levels.length, Math.ceil(endSec / frameSec));
  let max = 0;
  for (let i = a; i < b; i++) if (levels[i] > max) max = levels[i];
  return max < Math.max(0.003, refLevel * 0.1);
}

/** Mittlere Lautstärke eines Bereichs im Verhältnis zur Sprach-Lautstärke. */
export function relativeLoudness(levels, startSec, endSec, refLevel, frameSec = 0.1) {
  const a = Math.max(0, Math.floor(startSec / frameSec));
  const b = Math.min(levels.length, Math.max(a + 1, Math.ceil(endSec / frameSec)));
  let sum = 0;
  for (let i = a; i < b; i++) sum += levels[i];
  const mean = b > a ? sum / (b - a) : 0;
  return refLevel > 0 ? mean / refLevel : 0;
}

/**
 * Teilt das Audio in Stücke von höchstens maxSec Sekunden (Whisper verarbeitet 30 s).
 * Geschnitten wird an der leisesten Stelle zwischen minSec und maxSec, damit möglichst
 * kein Wort zerschnitten wird. Gibt [startSample, endSample]-Paare zurück.
 */
export function planChunks(audio, sr = SAMPLE_RATE, { maxSec = 29, minSec = 18 } = {}) {
  const chunks = [];
  const frame = Math.round(sr * 0.1);
  const hop = Math.round(sr * 0.05);
  const maxLen = Math.round(maxSec * sr);
  const minLen = Math.round(minSec * sr);
  let start = 0;
  while (start < audio.length) {
    if (audio.length - start <= maxLen) {
      chunks.push([start, audio.length]);
      break;
    }
    let best = start + maxLen;
    let bestEnergy = Infinity;
    for (let s = start + minLen; s + frame <= start + maxLen; s += hop) {
      const e = meanSquare(audio, s, s + frame);
      if (e < bestEnergy) {
        bestEnergy = e;
        best = s + Math.round(frame / 2);
      }
    }
    chunks.push([start, best]);
    start = best;
  }
  return chunks;
}

/**
 * Lautstärke, ab der ein Abschnitt als „Ton“ gilt: ca. 34 dB unter der lautesten Sprache, damit auch
 * leise Sprecher erhalten bleiben; bei Rauschen etwas über dem Grundrauschen, aber nie höher als 26 dB
 * unter der Sprache.
 */
export function speechThreshold(levels) {
  const ref = speechLevel(levels);
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  return Math.max(0.0015, Math.min(ref * 0.05, Math.max(noise * 3, ref * 0.02)));
}

/**
 * Stille-Erkennung: Findet die Bereiche mit Ton und lässt längere Stille (≥ minGapSec) weg.
 * Die Tonbereiche werden zu Stücken von höchstens maxSec Sekunden zusammengesetzt.
 * Jedes Stück enthält eine Zuordnung zurück zur Originalzeit.
 * @returns [{ parts: [{ src, len }], length }] – src/len in Samples
 */
export function planSpeechChunks(audio, levels, sr = SAMPLE_RATE, {
  maxSec = 29, minGapSec = 2, padSec = 0.5, frameSec = 0.1,
} = {}) {
  const threshold = speechThreshold(levels);
  const minGap = Math.round(minGapSec / frameSec);
  // 1. Tonbereiche in Abschnitten (100 ms)
  const regions = [];
  let start = -1, lastSpeech = -Infinity;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < threshold) continue;
    if (start < 0) start = f;
    else if (f - lastSpeech > minGap) { regions.push([start, lastSpeech + 1]); start = f; }
    lastSpeech = f;
  }
  if (start >= 0) regions.push([start, lastSpeech + 1]);
  // 2. In Samples umrechnen, etwas Rand dazu, Überlappungen zusammenfassen
  const pad = Math.round(padSec * sr);
  const frame = Math.round(frameSec * sr);
  const spans = [];
  for (const [a, b] of regions) {
    const s = Math.max(0, a * frame - pad);
    const e = Math.min(audio.length, b * frame + pad);
    if (spans.length && s <= spans.at(-1)[1]) spans.at(-1)[1] = Math.max(spans.at(-1)[1], e);
    else spans.push([s, e]);
  }
  // 3. Zu Stücken ≤ maxSec packen; zu lange Bereiche an leisen Stellen teilen
  const maxLen = Math.round(maxSec * sr);
  const pieces = [];
  for (const [s, e] of spans) {
    if (e - s <= maxLen) pieces.push([s, e]);
    else for (const [a, b] of planChunks(audio.subarray(s, e), sr, { maxSec })) pieces.push([s + a, s + b]);
  }
  const chunks = [];
  let cur = null;
  for (const [s, e] of pieces) {
    const len = e - s;
    if (!cur || cur.length + len > maxLen) {
      cur = { parts: [], length: 0 };
      chunks.push(cur);
    }
    cur.parts.push({ src: s, len });
    cur.length += len;
  }
  return chunks;
}

/** Setzt die Tonbereiche eines Stücks zu einem Puffer zusammen. */
export function assembleChunk(audio, chunk) {
  if (chunk.parts.length === 1) {
    const p = chunk.parts[0];
    return audio.subarray(p.src, p.src + p.len);
  }
  const out = new Float32Array(chunk.length);
  let o = 0;
  for (const p of chunk.parts) { out.set(audio.subarray(p.src, p.src + p.len), o); o += p.len; }
  return out;
}

/** Rechnet eine Zeit im zusammengesetzten Stück (Sekunden) in die Originalzeit um. */
export function chunkTimeToSource(chunk, t, sr = SAMPLE_RATE) {
  let pos = Math.max(0, Math.round(t * sr));
  for (const p of chunk.parts) {
    if (pos <= p.len) return (p.src + pos) / sr;
    pos -= p.len;
  }
  const last = chunk.parts.at(-1);
  return (last.src + last.len) / sr;
}

// ---------- Filter für erfundene Sätze ----------

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[„“”"'’‚«»()\[\]*♪♫…]/g, ' ')
    .replace(/[.,!?;:–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Typische Whisper-Erfindungen aus den Trainingsdaten (deutsche Fernseh-Untertitel).
// Diese Sätze werden immer entfernt.
const STRONG_PATTERNS = [
  /amara ?org/,
  /im auftrag (des|von) (zdf|ard|funk|wdr|swr|ndr|br|mdr|hr)/,
  /zdf f[uü]r funk/,
  /untertitel(ung)? (des|vom) (zdf|ard|wdr|swr|ndr|br|mdr|hr)/,
  /untertitel(ung)? von stephanie geiges/,
  /ard text im auftrag/,
  /copyright (wdr|swr|ndr|zdf|ard|br)/,
  /^(swr|wdr|ndr|zdf) \d{4}$/,
  /untertitel(ung)? (durch|aufgrund) (der|die)/,
];

// Diese Sätze sind oft erfunden, können aber auch echt gesagt werden.
// Sie werden nur entfernt, wenn die Stelle im Audio leise ist.
const WEAK_PATTERNS = [
  /^(vielen )?dank (f[uü]rs|f[uü]r das|f[uü]rs) zu(schauen|sehen|h[oö]ren)/,
  /^danke (f[uü]rs|f[uü]r das) zu(schauen|sehen|h[oö]ren)/,
  /^bis zum n[aä]chsten mal/,
  /^(tsch[uü]ss|ciao|bye)$/,
  /^untertitel(ung)?$/,
  /^(musik|applaus|lachen|stille)$/,
  /^thank(s| you) for watching/,
  /^$/,
];

function collapseRepeats(text) {
  // Erkennt Wortfolgen, die sich vier- oder mehrmals direkt wiederholen
  // („ja ja ja ja ja …“ oder ganze Sätze in Schleife) und kürzt sie.
  const words = text.split(/\s+/).filter(Boolean);
  let changed = false;
  for (let n = 1; n <= 8; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const key = normalize(words.slice(i, i + n).join(' '));
      if (!key) continue;
      let count = 1;
      while (
        i + (count + 1) * n <= words.length &&
        normalize(words.slice(i + count * n, i + (count + 1) * n).join(' ')) === key
      ) count++;
      if (count >= 4) {
        const keep = n <= 2 ? 2 : 1;
        words.splice(i + keep * n, (count - keep) * n);
        changed = true;
      }
    }
  }
  return { text: words.join(' '), changed };
}

/**
 * Entfernt erfundene Sätze und Wiederholungsschleifen.
 * @param segments [{start, end, text}]
 * @param levels Lautstärke-Abschnitte (frameLevels), optional
 * @returns {{segments, removed}}
 */
export function filterHallucinations(segments, levels = null) {
  const ref = levels ? speechLevel(levels) : 0;
  const out = [];
  let removed = 0;
  for (const seg of segments) {
    const norm = normalize(seg.text);
    if (STRONG_PATTERNS.some((p) => p.test(norm))) { removed++; continue; }
    const quiet = levels ? relativeLoudness(levels, seg.start, seg.end, ref) < 0.15 : false;
    if (WEAK_PATTERNS.some((p) => p.test(norm)) && (quiet || norm === '')) { removed++; continue; }
    if (norm === '') continue;
    const { text, changed } = collapseRepeats(seg.text.trim());
    if (changed) removed++;
    // Derselbe Satz dreimal oder öfter hintereinander: nur den ersten behalten.
    const prev = out.at(-1);
    const prev2 = out.at(-2);
    if (prev && prev2 && normalize(prev.text) === normalize(text) && normalize(prev2.text) === normalize(text)) {
      removed++;
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }
    out.push({ ...seg, text });
  }
  return { segments: out, removed };
}

// ---------- Untertitel (SRT) und Text (TXT) ----------

export function formatSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function formatClock(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Teilt einen Text in Stücke von höchstens maxLen Zeichen: erst an Satzenden, dann an Kommas, dann an Wörtern. */
export function splitText(text, maxLen) {
  text = text.trim();
  if (text.length <= maxLen) return [text];
  for (const re of [/(?<=[.!?…])\s+/, /(?<=[,;:])\s+/]) {
    const parts = text.split(re);
    if (parts.length > 1) {
      const pieces = [];
      let cur = '';
      for (const part of parts) {
        if (!cur) cur = part;
        else if ((cur + ' ' + part).length <= maxLen) cur += ' ' + part;
        else { pieces.push(cur); cur = part; }
      }
      if (cur) pieces.push(cur);
      if (pieces.length > 1) return pieces.flatMap((p) => splitText(p, maxLen));
    }
  }
  const words = text.split(/\s+/);
  const pieces = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxLen) cur += ' ' + w;
    else { pieces.push(cur); cur = w; }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** Bricht eine Untertitelzeile möglichst mittig an einem Leerzeichen um. */
export function wrapLines(text, maxLine = 42) {
  if (text.length <= maxLine) return [text];
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let d = 0; d < text.length; d++) {
    for (const i of [mid - d, mid + d]) {
      if (i > 0 && i < text.length && text[i] === ' ') { best = i; break; }
    }
    if (best >= 0) break;
  }
  if (best < 0) return [text];
  return [text.slice(0, best), text.slice(best + 1)];
}

export function speakerName(names, id) {
  if (id === undefined || id === null) return null;
  const n = names?.[id];
  return n && n.trim() ? n.trim() : `Sprecher ${id + 1}`;
}

/**
 * Baut Untertitel-Blöcke aus Whisper-Abschnitten: höchstens 2 Zeilen à 42 Zeichen,
 * lange Abschnitte werden aufgeteilt und die Zeit anteilig verteilt.
 */
export function buildCues(segments, { names = null, withSpeakers = false, maxLine = 42, labelInText = true } = {}) {
  const cues = [];
  for (const seg of segments) {
    const label = withSpeakers ? `${speakerName(names, seg.speaker ?? 0)}: ` : '';
    // Die Aufteilung berücksichtigt den Namen immer, damit Ansicht und SRT-Datei gleich nummeriert sind.
    const prefix = labelInText ? label : '';
    const pieces = splitText(seg.text, Math.max(30, maxLine * 2 - label.length));
    const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
    const dur = Math.max(0.5, seg.end - seg.start);
    let t = seg.start;
    pieces.forEach((piece, i) => {
      const share = (piece.length / totalChars) * dur;
      const start = t;
      const end = i === pieces.length - 1 ? seg.end : t + share;
      t = end;
      cues.push({ start, end, text: prefix + piece, speaker: seg.speaker });
    });
  }
  // Mindestdauer und keine Überlappung.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.end - c.start < 0.7) c.end = c.start + 0.7;
    const next = cues[i + 1];
    if (next && c.end > next.start) c.end = Math.max(c.start + 0.1, next.start);
  }
  return cues;
}

export function toSrt(segments, opts = {}) {
  const cues = buildCues(segments, opts);
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${wrapLines(c.text, opts.maxLine ?? 42).join('\n')}\n`)
    .join('\n');
}

/**
 * Fasst Abschnitte zu Absätzen zusammen, behält aber die Abschnitte einzeln (für die Bearbeitung).
 * Mit Sprechern: ein Absatz pro Redebeitrag. Sonst: neuer Absatz nach Pausen > 1,5 s oder ab 600 Zeichen.
 * @returns [{ speaker, start, end, label, items: [{ index, seg }] }]
 */
export function groupParagraphs(segments, { names = null, withSpeakers = false } = {}) {
  const groups = [];
  segments.forEach((seg, index) => {
    const last = groups.at(-1);
    const len = last ? last.items.reduce((n, it) => n + it.seg.text.length + 1, 0) : 0;
    const sameSpeaker = last && (!withSpeakers || last.speaker === seg.speaker);
    const smallGap = last && seg.start - last.end < 1.5 && len < 600;
    if (last && sameSpeaker && (withSpeakers || smallGap)) {
      last.items.push({ index, seg });
      last.end = seg.end;
    } else {
      groups.push({ speaker: seg.speaker, start: seg.start, end: seg.end, items: [{ index, seg }] });
    }
  });
  return groups.map((g) => ({ ...g, label: withSpeakers ? speakerName(names, g.speaker ?? 0) : null }));
}

/** Fließtext in Absätzen. Mit Sprechern: ein Absatz pro Redebeitrag. */
export function toParagraphs(segments, opts = {}) {
  return groupParagraphs(segments, opts).map(({ items, ...g }) => ({
    ...g,
    text: items.map((it) => it.seg.text.trim()).filter(Boolean).join(' '),
  }));
}

/** Nur Abschnitte mit Text – geleerte Abschnitte fallen aus Text, TXT und SRT heraus. */
export function activeSegments(segments) {
  return segments.filter((s) => s.text && s.text.trim());
}

// ---------- Suchen und Ersetzen ----------

function searchRegExp(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

/** Fundstellen in einem Text (ohne Beachtung von Groß-/Kleinschreibung) als [start, end]. */
export function findMatches(text, query) {
  if (!query) return [];
  return Array.from(text.matchAll(searchRegExp(query)), (m) => [m.index, m.index + m[0].length]);
}

export function countMatches(segments, query) {
  if (!query) return 0;
  return segments.reduce((n, s) => n + findMatches(s.text, query).length, 0);
}

/** Ersetzt alle Fundstellen in den Abschnitten. Gibt die Anzahl der Ersetzungen zurück. */
export function replaceAll(segments, query, replacement) {
  if (!query) return 0;
  let count = 0;
  for (const s of segments) {
    let hits = 0;
    const text = s.text.replace(searchRegExp(query), () => { hits++; return replacement; });
    // Doppelte Leerzeichen aufräumen (z. B. beim Ersetzen durch leeren Text).
    if (hits) s.text = text.replace(/ {2,}/g, ' ').replace(/ ([,.!?;:])/g, '$1').trim();
    count += hits;
  }
  return count;
}

export function toTxt(segments, opts = {}) {
  return toParagraphs(segments, opts)
    .map((p) => (p.label ? `${p.label}: ${p.text}` : p.text))
    .join('\n\n') + '\n';
}

/** Zusammenhängende Redeanteile je Sprecher für die Zeitleiste. */
export function speakerTimeline(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out.at(-1);
    if (last && last.speaker === seg.speaker) last.end = seg.end;
    else out.push({ speaker: seg.speaker, start: seg.start, end: seg.end });
  }
  return out;
}

export function baseName(fileName) {
  return fileName.replace(/\.[^./\\]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'transkript';
}

// ---------- Sprecher-Erkennung: Stimmen gruppieren ----------

function l2normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

/**
 * Fasst Stimm-Fingerabdrücke zu Sprechern zusammen (agglomerativ, Schwerpunkt-Verfahren).
 * @param embeddings Array von Float32Array
 * @param weights Gewicht je Fingerabdruck (z. B. Dauer in Sekunden)
 * @param numSpeakers feste Anzahl oder null für automatisch
 * @param threshold Mindest-Ähnlichkeit zum Zusammenfassen (nur bei automatisch)
 * @returns Sprecher-Nummer je Fingerabdruck, nummeriert in Reihenfolge des ersten Auftretens
 */
export function clusterSpeakers(embeddings, { weights = null, numSpeakers = null, threshold = 0.5 } = {}) {
  const n = embeddings.length;
  if (n === 0) return [];
  let clusters = embeddings.map((e, i) => {
    const w = weights ? weights[i] : 1;
    const v = l2normalize(e);
    for (let k = 0; k < v.length; k++) v[k] *= w;
    return { sum: v, members: [i] };
  });
  const target = numSpeakers ? Math.max(1, Math.min(numSpeakers, n)) : 1;
  while (clusters.length > target) {
    let bi = -1, bj = -1, best = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = cosine(clusters[i].sum, clusters[j].sum);
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    if (!numSpeakers && best < threshold) break;
    const a = clusters[bi], b = clusters[bj];
    const sum = new Float32Array(a.sum.length);
    for (let k = 0; k < sum.length; k++) sum[k] = a.sum[k] + b.sum[k];
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push({ sum, members: [...a.members, ...b.members] });
  }
  const label = new Array(n).fill(0);
  clusters.forEach((c, ci) => c.members.forEach((m) => { label[m] = ci; }));
  // Neu nummerieren nach erstem Auftreten.
  const map = new Map();
  return label.map((l) => {
    if (!map.has(l)) map.set(l, map.size);
    return map.get(l);
  });
}

/**
 * Ordnet jedem Whisper-Abschnitt den Sprecher mit der größten zeitlichen Überlappung zu.
 * @param segments [{start, end, text}]
 * @param turns [{start, end, speaker}]
 */
export function assignSpeakers(segments, turns) {
  return segments.map((seg) => {
    const overlap = new Map();
    let nearest = null, nearestDist = Infinity;
    for (const t of turns) {
      const o = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
      const dist = Math.max(0, Math.max(t.start - seg.end, seg.start - t.end));
      if (dist < nearestDist) { nearestDist = dist; nearest = t.speaker; }
    }
    let speaker = nearest ?? 0, best = 0;
    for (const [s, o] of overlap) if (o > best) { best = o; speaker = s; }
    return { ...seg, speaker };
  });
}

// ---------- Textgerüst (OT / Sit / OFF) ----------

/** Timecode für das Textgerüst: MM:SS bzw. H:MM:SS. */
export function formatTimecode(sec) {
  return formatClock(sec);
}

// Abschnittsgrenzen auf den tatsächlichen Ton zuschneiden (Whisper-Abschnitte sind gepolstert).
function trimToSpeech(seg, levels, threshold, frameSec = 0.1) {
  let a = Math.max(0, Math.floor(seg.start / frameSec));
  let b = Math.min(levels.length, Math.ceil(seg.end / frameSec));
  while (a < b && levels[a] < threshold) a++;
  while (b > a && levels[b - 1] < threshold) b--;
  if (a >= b) return seg;
  return { ...seg, start: Math.max(seg.start, a * frameSec), end: Math.min(seg.end, b * frameSec) };
}

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

/**
 * Teilt das Transkript in Blöcke eines Textgerüsts ein:
 *  - OFF: mindestens offGap Sekunden ohne Sprache (dort kommt der Sprechertext hin)
 *  - OT:  eine Person spricht länger am Stück (ab longTurn Sekunden) – oder allein
 *  - Sit: Hin und Her von zwei oder mehr Stimmen; ein kurzer Einwurf einer zweiten Stimme
 *         („Ja.“) macht aus dem Block davor ebenfalls ein Sit
 * @param segments [{start, end, text, speaker}] – nur Abschnitte mit Text werden genutzt
 * @param levels Lautstärke je 100 ms (frameLevels); damit werden Pausen am Ton statt an Whisper gemessen
 * @returns [{ type: 'OFF'|'OT'|'Sit', speakers: number[], start, end, full }]
 */
export function buildScriptBlocks(segments, { offGap = 3, longTurn = 8, duration = null, levels = null } = {}) {
  const threshold = levels?.length ? speechThreshold(levels) : 0;
  const segs = activeSegments(segments)
    .map((s) => (levels?.length ? trimToSpeech(s, levels, threshold) : s))
    .sort((a, b) => a.start - b.start);
  const total = Math.max(duration ?? 0, segs.at(-1)?.end ?? 0);
  const blocks = [];
  const off = (start, end) => blocks.push({ type: 'OFF', speakers: [], start, end, full: '' });

  // 1. Zusammenhängende Redebeiträge derselben Stimme
  const turns = [];
  for (const s of segs) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker && s.start - last.end < offGap) {
      last.end = Math.max(last.end, s.end);
      last.texts.push(s.text.trim());
    } else {
      turns.push({ speaker: s.speaker, start: s.start, end: s.end, texts: [s.text.trim()] });
    }
  }
  if (!turns.length) {
    if (total >= offGap) off(0, total);
    return blocks;
  }

  // 2. Beiträge ohne längere Pause bilden eine Strecke; zwischen Strecken liegt ein OFF
  const runs = [];
  for (const t of turns) {
    const run = runs.at(-1);
    if (run && t.start - run.at(-1).end < offGap) run.push(t);
    else runs.push([t]);
  }
  const textOf = (t) => t.texts.join(' ');
  const ot = (t) => blocks.push({ type: 'OT', speakers: [t.speaker], start: t.start, end: t.end, full: textOf(t) });
  const sit = (ts) => blocks.push({
    type: 'Sit',
    speakers: [...new Set(ts.map((t) => t.speaker))],
    start: ts[0].start,
    end: ts.at(-1).end,
    full: ts.map(textOf).join(' '),
  });
  const isInterjection = (t) => t.end - t.start < 2 && wordCount(textOf(t)) <= 3;

  if (runs[0][0].start >= offGap) off(0, runs[0][0].start);
  runs.forEach((run, ri) => {
    if (ri > 0) off(runs[ri - 1].at(-1).end, run[0].start);
    const runStart = blocks.length;
    // 3. Kurze Beiträge mehrerer Stimmen nacheinander = Sit; lange Beiträge = eigenes OT
    let pending = [];
    const flush = () => {
      if (pending.length >= 2 && new Set(pending.map((t) => t.speaker)).size >= 2) sit(pending);
      else pending.forEach(ot);
      pending = [];
    };
    for (const t of run) {
      const prev = blocks.length > runStart ? blocks.at(-1) : null;
      if (!pending.length && prev && prev.type !== 'OFF' && isInterjection(t)) {
        // Kurzer Einwurf („Ja.“) gehört zum Block davor; zwei Stimmen = Sit
        prev.full += ' ' + textOf(t);
        prev.end = t.end;
        if (!prev.speakers.includes(t.speaker)) prev.speakers.push(t.speaker);
        if (prev.speakers.length >= 2) prev.type = 'Sit';
      } else if (t.end - t.start >= longTurn) {
        flush();
        ot(t);
      } else {
        pending.push(t);
      }
    }
    flush();
  });
  const lastEnd = runs.at(-1).at(-1).end;
  if (total - lastEnd >= offGap) off(lastEnd, total);
  return blocks;
}

// Häufige deutsche Wörter, die als Schlagwort nichts aussagen.
const STOPWORDS = new Set(`
aber alle allem allen aller alles also am an ander andere anderen anders auch auf aus bei beim bin bis bist bisschen bloß
da dabei dadurch dafür dagegen daher damit dann daran darauf darum das dass dein deine dem den denn der des deshalb dich die
dies diese diesem diesen dieser dieses dir doch dort du durch eben ebenso ehrlich eigentlich ein eine einem einen einer eines
einfach einmal er es etwas euch euer eure für gar gegen gehabt gell genau gerade gewesen gibt ging glaube habe haben hab hast
hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre im immer in ins irgendwie ist ja jede jedem jeden jeder jetzt
kann kannst kein keine keinen klar können könnte mach machen macht mal man manchmal mehr mein meine meinem meinen mich mir mit
muss müssen nach natürlich nein nicht nichts noch nun nur ob oder ohne okay ok schon sehr sein seine seinem seinen sich sie
sind so solche soll sollen sondern sowas sozusagen über um und uns unser unsere unter viel vielleicht voll vom von vor wahrscheinlich
war waren warum was weil weiß weiter welche wenn wer werde werden wie wieder will wir wird wirklich wo wollen worden würde
würden zu zum zur zwar zwischen äh ähm hm mhm na naja halt quasi tja
als ganz total irgendwann echt eh sowieso nämlich trotzdem überhaupt drauf dran drin sagen sag sagt gesagt find finde
glaub weißt meinst gemacht sein worden bisl bissl
`.trim().split(/\s+/));

const WORD_CORE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const coreWord = (w) => w.replace(WORD_CORE, '');

/** Zählt, wie oft jedes Wort im ganzen Transkript vorkommt (für die Seltenheit). */
export function wordFrequencies(texts) {
  const freq = new Map();
  for (const t of texts) {
    for (const w of t.split(/\s+/)) {
      const c = coreWord(w).toLowerCase();
      if (c) freq.set(c, (freq.get(c) ?? 0) + 1);
    }
  }
  return freq;
}

// Allerweltswörter, die als Hauptwort zwar groß geschrieben sind, aber wenig Inhalt tragen.
const GENERIC = new Set(`
anfang augen beginn ding dinge ende fall ganze mal moment leute sache sachen seite stück teil tag tage weise zeit
woche wochen jahr jahre mensch menschen art punkt frage antwort gefühl leben
`.trim().split(/\s+/));

// Endet ein Wort einen Satz? „15.“ (Datum) zählt nicht als Satzende.
const endsSentence = (w) => /[.!?…]$/.test(w ?? '') && !/^\d+\.$/.test(w ?? '');
const endsClause = (w) => endsSentence(w) || /[,;:]$/.test(w ?? '');

/**
 * Kürzt einen Text wie in einem Textgerüst: erste 3 Wörter … Schlagwort-Gruppen … letzte 3 Wörter.
 * Nur wo wirklich etwas fehlt, steht „…“. Kurze Texte (bis keepUpTo Wörter) bleiben ganz.
 * @param ratio Anteil der Wörter, der ungefähr stehen bleiben soll (z. B. 0.22)
 * @param groupSize Wörter je Schlagwort-Gruppe (2 = „Kühe melken“, 3–4 = längere Satzteile)
 * @param maxGroups höchstens so viele Gruppen
 * @param freq Worthäufigkeiten im ganzen Transkript (seltene Wörter sind bessere Schlagwörter)
 */
export function shortenText(text, { ratio = 0.22, keepUpTo = 10, freq = null, groupSize = 2, maxGroups = 3 } = {}) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= keepUpTo) return words.join(' ');
  const n = words.length;
  const head = 3;
  const tailStart = n - 3;
  const lower = (w) => coreWord(w).toLowerCase();
  const isStop = (w) => { const c = lower(w); return !c || STOPWORDS.has(c); };
  // Wörter aus Anfang und Ende nicht noch einmal als Schlagwort wählen
  const used = new Set([...words.slice(0, head), ...words.slice(tailStart)].map(lower));

  // Schlagwort-Kandidaten in der Mitte bewerten
  const candidates = [];
  for (let i = head; i < tailStart; i++) {
    const c = coreWord(words[i]);
    if (!c || STOPWORDS.has(c.toLowerCase()) || used.has(c.toLowerCase())) continue;
    let score = 0;
    if (/^\p{Lu}/u.test(c)) score += endsSentence(words[i - 1]) ? 1 : 3; // Hauptwort oder Name
    if (/\p{N}/u.test(c)) score += 2;                                      // Zahlen, Uhrzeiten, Daten
    if (c.length >= 7) score += 1;
    if (c.length >= 10) score += 1;
    if (freq && (freq.get(c.toLowerCase()) ?? 0) <= 1) score += 1;        // selten = aussagekräftig
    if (GENERIC.has(c.toLowerCase())) score -= 2;
    if (score >= 2) candidates.push({ i, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);

  // Wenige kurze Wortgruppen statt vieler Einzelwörter; mehr und längere Gruppen bei schwächerer Kürzung
  const budget = Math.max(1, Math.round(ratio * n) - 6);
  const groups = Math.max(1, Math.min(maxGroups, Math.round(budget / groupSize)));
  const picks = [];
  for (const cand of candidates) {
    if (picks.length >= groups) break;
    const w = lower(words[cand.i]);
    // nicht zu dicht beieinander, und dasselbe Wort nicht kurz hintereinander
    if (picks.some((p) => Math.abs(p - cand.i) <= groupSize || (lower(words[p]) === w && Math.abs(p - cand.i) < 30))) continue;
    picks.push(cand.i);
  }
  const keep = new Set();
  for (const i of picks) {
    keep.add(i);
    let lo = i, hi = i;
    // Gruppe um das Schlagwort bilden, ohne über Satz- oder Teilsatzgrenzen zu springen
    while (hi - lo + 1 < groupSize) {
      const canNext = hi + 1 < tailStart && !endsClause(words[hi]) && (groupSize > 2 || !isStop(words[hi + 1]));
      const canPrev = lo - 1 >= head && !endsClause(words[lo - 1]) && (groupSize > 2 || !isStop(words[lo - 1]));
      if (canNext) keep.add(++hi);
      else if (canPrev) keep.add(--lo);
      else break;
    }
  }

  // Zusammenhängende Wörter bilden Stücke; nur zwischen getrennten Stücken steht „…“
  const all = [...Array(head).keys(), ...[...keep].sort((a, b) => a - b), ...Array.from({ length: 3 }, (_, k) => tailStart + k)];
  const runs = [];
  for (const i of all) {
    const run = runs.at(-1);
    if (run && i === run.at(-1) + 1) run.push(i);
    else if (!run || i > run.at(-1)) runs.push([i]);
  }
  const clean = (piece) => piece.replace(/[\s,;:–—-]+$/u, '').replace(/^[\s,;:–—-]+/u, '');
  return runs
    .map((run, k) => {
      const piece = clean(run.map((i) => words[i]).join(' '));
      // Satzzeichen vor „…“ weglassen; das Satzende am Schluss bleibt.
      return k < runs.length - 1 ? piece.replace(/(?<!\d)[.!?]+$/u, '') : piece;
    })
    .filter(Boolean)
    .join('…');
}

// ---------- Word-Datei (.docx) im Layout der Textgerüst-Vorlage ----------

// Steuerzeichen sind in Word-XML ungültig und werden entfernt.
const xmlEsc = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const COLS = [846, 8788, 3261]; // wie in der Vorlage: schmal | Text | Timecode

function para(text, { bold = false } = {}) {
  const rPr = bold ? '<w:rPr><w:b/><w:bCs/></w:rPr>' : '';
  if (!text) return `<w:p><w:pPr>${rPr}</w:pPr></w:p>`;
  return `<w:p><w:pPr>${rPr}</w:pPr><w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}
function cell(width, paras, fill = null) {
  const shd = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shd}</w:tcPr>${paras.join('') || para('')}</w:tc>`;
}
function row(cells) { return `<w:tr>${cells.join('')}</w:tr>`; }

/**
 * Alle Dateien einer Word-Datei für das Textgerüst (als Texte). Querformat, Arial 11,
 * Tabelle mit grüner Titelzeile, OFF fett, OT/Sit mit Text darunter, Timecode rechts.
 * @param blocks [{ type, label, text, start, end }]
 */
export function scriptDocxFiles({ title, blocks }) {
  const head = row([
    cell(COLS[0], [para('', { bold: true })], '8DD873'),
    cell(COLS[1], [para(title, { bold: true })], '8DD873'),
    cell(COLS[2], [para('', { bold: true })], '8DD873'),
  ]);
  const body = blocks.map((b) => {
    const lines = (b.text ?? '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const main = b.type === 'OFF'
      ? [para('OFF', { bold: true }), ...lines.map((l) => para(l, { bold: true }))] // Sprechertext fett wie in der Vorlage
      : [para(b.label), ...lines.map((l) => para(l))];
    const tc = `${formatTimecode(b.start)} – ${formatTimecode(b.end)}`;
    return row([cell(COLS[0], [para('')]), cell(COLS[1], main), cell(COLS[2], [para(tc)])]);
  }).join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body><w:tbl><w:tblPr><w:tblStyle w:val="Tabellenraster"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${COLS.map((c) => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl><w:p/><w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="NormaleTabelle"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="Tabellenraster"><w:name w:val="Table Grid"/><w:basedOn w:val="NormaleTabelle"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${borders}</w:tblBorders></w:tblPr></w:style></w:styles>`;
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': styles,
  };
}

/** Vorschlag für die Titelzeile aus dem Dateinamen („Folge_3_Hof.mp4“ → „Folge 3 Hof“). */
export function titleFromFileName(name) {
  return baseName(name).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
