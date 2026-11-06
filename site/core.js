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
 * Stille-Erkennung: Findet die Bereiche mit Ton und lässt längere Stille (≥ minGapSec) weg.
 * Die Tonbereiche werden zu Stücken von höchstens maxSec Sekunden zusammengesetzt.
 * Jedes Stück enthält eine Zuordnung zurück zur Originalzeit.
 * @returns [{ parts: [{ src, len }], length }] – src/len in Samples
 */
export function planSpeechChunks(audio, levels, sr = SAMPLE_RATE, {
  maxSec = 29, minGapSec = 2, padSec = 0.5, frameSec = 0.1,
} = {}) {
  const ref = speechLevel(levels);
  // Schwelle: ca. 34 dB unter der lautesten Sprache, damit auch leise Sprecher erhalten bleiben;
  // bei Rauschen etwas über dem Grundrauschen, aber nie höher als 26 dB unter der Sprache.
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  const threshold = Math.max(0.0015, Math.min(ref * 0.05, Math.max(noise * 3, ref * 0.02)));
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
