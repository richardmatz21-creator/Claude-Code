// Hintergrund-Thread: Whisper-Umwandlung und Sprecher-Erkennung.
// Läuft getrennt von der Oberfläche, damit die Seite nicht einfriert.
// __ASSETS__ und __BUILD__ ersetzt der Build (versionierte Pfade, damit Updates sicher ankommen).
import {
  pipeline, env, AutoProcessor, AutoModel, AutoModelForAudioFrameClassification,
} from './__ASSETS__/vendor/transformers.min.js';
import {
  SAMPLE_RATE, frameLevels, planSpeechChunks, assembleChunk, chunkTimeToSource, filterHallucinations,
  clusterSpeakers, assignSpeakers,
} from './core.js?v=__BUILD__';

const ASSETS = '__ASSETS__';
const ASSET_URL = new URL(`./${ASSETS}/`, self.location.href);

// Alles kommt von der eigenen Seite – nie von Hugging Face oder einem CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Nur der Pfad, keine volle URL: transformers.js 4.3 prüft lokale Dateien sonst nicht.
env.localModelPath = new URL('models/', ASSET_URL).pathname;
env.useBrowserCache = true;
// Firmen-Proxys liefern bei gesperrten Downloads oft eine HTML-Seite (403) oder einen Serverfehler.
// transformers.js würde diese wie eine Modelldatei lesen – deshalb hier klar als Ladefehler melden.
const defaultFetch = env.fetch;
env.fetch = async (input, init) => {
  const res = await defaultFetch(input, init);
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (url.includes(`/${ASSETS}/`)) {
    const type = res.headers.get('content-type') || '';
    if (res.status === 403 || res.status >= 500 || (res.ok && type.includes('text/html'))) {
      throw new Error(`Ladefehler (HTTP ${res.status}): ${url.split('/').pop()} wurde blockiert`);
    }
  }
  return res;
};
const wasm = env.backends.onnx.wasm;
wasm.wasmPaths = {
  mjs: new URL('vendor/ort-wasm-simd-threaded.asyncify.mjs', ASSET_URL).href,
  wasm: new URL('vendor/ort-wasm-simd-threaded.asyncify.wasm', ASSET_URL).href,
};
const CORES = self.navigator.hardwareConcurrency || 2;
// Etwa die echten Kerne nutzen (logische Kerne / 2), bei kleinen Geräten alle, höchstens 4.
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, CORES >= 4 ? Math.ceil(CORES / 2) : CORES)) : 1;
wasm.numThreads = THREADS;

const WHISPER = {
  small: 'onnx-community/whisper-small',
  base: 'onnx-community/whisper-base',
};
const SEGMENTATION = 'onnx-community/pyannote-segmentation-3.0';
const EMBEDDING = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

class Cancelled extends Error {}
let cancelled = false;
let asr = null;
let asrKey = null;
let segmentation = null;
let embedding = null;
let jobChain = Promise.resolve();

// Alte Modell- und Programmdateien früherer Versionen aus dem Browser-Speicher löschen.
async function cleanOldCache() {
  try {
    if (!self.caches) return;
    const cache = await caches.open(env.cacheKey ?? 'transformers-cache');
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (/\/a-[0-9a-f]+\//.test(path) && !path.includes(`/${ASSETS}/`)) await cache.delete(req);
    }
  } catch { /* nicht wichtig */ }
}
cleanOldCache();

function checkCancel() {
  if (cancelled) throw new Cancelled();
}

// Markiert Fehler, die bei der Grafikkarten-Rechnung passiert sind.
class GpuStageError extends Error {
  constructor(cause) {
    super(String(cause?.message ?? cause));
    this.cause = cause;
  }
}
async function gpuStage(mode, fn) {
  if (mode !== 'gpu') return fn();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Cancelled) throw err;
    throw new GpuStageError(err);
  }
}
// Ladefehler (Netz weg, Datei nicht erreichbar) sind keine Grafikkarten-Probleme.
const NETWORK_ERROR = /fetch|network|Failed to load|Load failed|not found locally|Could not locate|ModelFileNotFound|Ladefehler|blockiert|is not valid JSON|Unexpected token '<'|protobuf|\b40[34]\b|\b50\d\b|ERR_/i;

// Lade-Fortschritt über alle Dateien eines Modells zusammenfassen.
function progressReporter(ctx, what) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    } else if (p.status === 'done' && p.file && files.has(p.file)) {
      const f = files.get(p.file);
      f.loaded = f.total;
    } else {
      return;
    }
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    ctx.post({ type: 'load-progress', what, loaded, total });
  };
}

function asrOptions(mode, encoderDtype = 'fp16') {
  if (mode === 'gpu') {
    // Encoder (rechenintensiv) auf der Grafikkarte, Decoder auf dem Prozessor.
    // encoderDtype wird nur von Tests geändert (Test-Grafikkarte ohne fp16).
    return {
      device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
      dtype: { encoder_model: encoderDtype, decoder_model_merged: 'q8' },
    };
  }
  return {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  };
}

async function getAsr(ctx, model, mode, encoderDtype) {
  const key = `${model}|${mode}|${encoderDtype ?? ''}`;
  if (asr && asrKey === key) return asr;
  if (asr) {
    try { await asr.dispose(); } catch { /* egal */ }
    asr = null;
    asrKey = null;
  }
  ctx.post({ type: 'status', phase: 'loading', what: 'whisper' });
  asr = await pipeline('automatic-speech-recognition', WHISPER[model], {
    ...asrOptions(mode, encoderDtype),
    progress_callback: progressReporter(ctx, 'whisper'),
  });
  asrKey = key;
  return asr;
}

async function getDiarizationModels(ctx) {
  if (!segmentation) {
    ctx.post({ type: 'status', phase: 'loading', what: 'speakers' });
    const report = progressReporter(ctx, 'speakers');
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(SEGMENTATION, { progress_callback: report }),
      AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION, { device: 'wasm', dtype: 'fp32', progress_callback: report }),
    ]);
    segmentation = { processor, model };
  }
  if (!embedding) {
    ctx.post({ type: 'status', phase: 'loading', what: 'speakers' });
    const report = progressReporter(ctx, 'speakers');
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(EMBEDDING, { progress_callback: report }),
      AutoModel.from_pretrained(EMBEDDING, { device: 'wasm', dtype: 'fp32', progress_callback: report }),
    ]);
    embedding = { processor, model };
  }
}

async function transcribe(ctx, { audio, model, language, mode, encoderDtype }) {
  const pipe = await gpuStage(mode, () => getAsr(ctx, model, mode, encoderDtype));
  checkCancel();
  const levels = frameLevels(audio);
  // Längere Stille wird gar nicht erst an Whisper gegeben (weniger erfundene Sätze, schneller).
  const chunks = planSpeechChunks(audio, levels);
  const total = audio.length / SAMPLE_RATE;
  const speechTotal = chunks.reduce((n, c) => n + c.length, 0) || 1;
  const segments = [];
  ctx.post({ type: 'status', phase: 'transcribing' });
  ctx.post({ type: 'progress', phase: 'transcribing', done: 0, total });
  let processed = 0;
  for (const chunk of chunks) {
    checkCancel();
    const lenSec = chunk.length / SAMPLE_RATE;
    const out = await gpuStage(mode, () => pipe(assembleChunk(audio, chunk), {
      language: language === 'auto' ? null : language,
      task: 'transcribe',
      return_timestamps: true,
    }));
    const parts = out.chunks?.length ? out.chunks : [{ timestamp: [0, lenSec], text: out.text }];
    for (const part of parts) {
      let [s, e] = part.timestamp ?? [0, lenSec];
      s = Math.max(0, Math.min(s ?? 0, lenSec));
      e = e == null || e <= s ? Math.min(lenSec, s + 5) : Math.min(e, lenSec);
      const text = (part.text ?? '').trim();
      if (text) segments.push({ start: chunkTimeToSource(chunk, s), end: chunkTimeToSource(chunk, e), text });
    }
    processed += chunk.length;
    // Fortschritt in Audio-Sekunden, damit die Restzeit-Schätzung passt.
    ctx.post({ type: 'progress', phase: 'transcribing', done: total * (processed / speechTotal), total });
  }
  segments.sort((a, b) => a.start - b.start);
  // Die Lautstärke-Werte gehen mit zurück: Das Textgerüst misst Pausen daran.
  return { ...filterHallucinations(segments, levels), levels };
}

function concatRegions(audio, regions, maxSec = 10) {
  const maxLen = Math.round(maxSec * SAMPLE_RATE);
  let len = 0;
  const parts = [];
  for (const r of regions) {
    const a = Math.max(0, Math.round(r.start * SAMPLE_RATE));
    const b = Math.min(audio.length, Math.round(r.end * SAMPLE_RATE));
    if (b <= a) continue;
    const take = Math.min(b - a, maxLen - len);
    if (take <= 0) break;
    parts.push(audio.subarray(a, a + take));
    len += take;
  }
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function diarize(ctx, { audio, segments, numSpeakers }) {
  await getDiarizationModels(ctx);
  checkCancel();
  ctx.post({ type: 'status', phase: 'diarizing' });
  const total = audio.length / SAMPLE_RATE;
  const window = 10 * SAMPLE_RATE;

  // 1. In 10-Sekunden-Fenstern erkennen, wann jemand spricht (lokale Sprecher je Fenster).
  //    Nebenbei entsteht eine Sprach-Zeitleiste, die auch bei Musik im Hintergrund stimmt
  //    (das Textgerüst misst seine OFF-Pausen daran).
  const groups = new Map();
  const speech = [];
  for (let a = 0; a < audio.length; a += window) {
    checkCancel();
    const b = Math.min(audio.length, a + window);
    // Ein sehr kurzes letztes Stück auf 1 s auffüllen (Stille), damit auch das Ende in der Zeitleiste steht
    let piece = audio.subarray(a, b);
    if (piece.length < SAMPLE_RATE) {
      const padded = new Float32Array(SAMPLE_RATE);
      padded.set(piece);
      piece = padded;
    }
    const inputs = await segmentation.processor(piece);
    const { logits } = await segmentation.model(inputs);
    const result = segmentation.processor.post_process_speaker_diarization(logits, piece.length)[0];
    for (const r of result) {
      // 0 = niemand spricht, 1–3 = ein Sprecher, 4–6 = zwei gleichzeitig (nur für die Zeitleiste)
      if (r.id >= 1) speech.push([a / SAMPLE_RATE + r.start, a / SAMPLE_RATE + r.end]);
      if (r.id < 1 || r.id > 3) continue;
      const key = `${a}:${r.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ start: a / SAMPLE_RATE + r.start, end: a / SAMPLE_RATE + r.end });
    }
    ctx.post({ type: 'progress', phase: 'diarizing', done: (b / SAMPLE_RATE) * 0.5, total });
  }

  // 2. Für jeden lokalen Sprecher einen Stimm-Fingerabdruck berechnen.
  const keys = [], embs = [], weights = [];
  let n = 0;
  for (const [key, regions] of groups) {
    checkCancel();
    n++;
    const dur = regions.reduce((s, r) => s + (r.end - r.start), 0);
    if (dur < 0.8) continue;
    const pcm = concatRegions(audio, regions);
    const inputs = await embedding.processor(pcm);
    const output = await embedding.model(inputs);
    const tensor = output.embeddings ?? output.last_hidden_state ?? Object.values(output)[0];
    keys.push(key);
    embs.push(Float32Array.from(tensor.data));
    weights.push(Math.min(dur, 10));
    ctx.post({ type: 'progress', phase: 'diarizing', done: total * (0.5 + 0.5 * n / groups.size), total });
  }

  // 3. Gleiche Stimmen über die ganze Aufnahme zusammenfassen.
  // Schwelle und Mindestgewicht an echtem Material abgestimmt (Außendreh mit Musik, viele Stimmen).
  const labels = clusterSpeakers(embs, { weights, numSpeakers, threshold: 0.4, minWeight: 2 });
  const labelOf = new Map(keys.map((k, i) => [k, labels[i]]));
  const turns = [];
  for (const [key, regions] of groups) {
    if (!labelOf.has(key)) continue;
    for (const r of regions) turns.push({ ...r, speaker: labelOf.get(key) });
  }
  // Sprach-Zeitleiste zusammenfassen (überlappende oder direkt anschließende Bereiche)
  speech.sort((x, y) => x[0] - y[0]);
  const speechMerged = [];
  for (const [s0, e0] of speech) {
    const last = speechMerged.at(-1);
    if (last && s0 <= last[1] + 0.05) last[1] = Math.max(last[1], e0);
    else speechMerged.push([s0, e0]);
  }
  const debug = ctx.debug ? {
    keys, weights, embs: embs.map((e) => Array.from(e)),
    groups: Object.fromEntries([...groups].map(([k, v]) => [k, v])),
  } : undefined;
  if (turns.length === 0) return { segments: segments.map((s) => ({ ...s, speaker: 0 })), speakers: 1, speech: speechMerged, debug };

  // 4. Jedem Textabschnitt den passenden Sprecher geben, neu nummerieren nach Auftreten.
  const assigned = assignSpeakers(segments, turns);
  const order = new Map();
  for (const s of assigned) if (!order.has(s.speaker)) order.set(s.speaker, order.size);
  return {
    segments: assigned.map((s) => ({ ...s, speaker: order.get(s.speaker) })),
    speakers: Math.max(1, order.size),
    speech: speechMerged,
    debug,
  };
}

async function handleJob(job) {
  const t0 = performance.now();
  // Jede Nachricht trägt Datei-Nummer und Lauf-Kennung, damit die Seite alte Nachrichten erkennt.
  const ctx = { post: (msg) => self.postMessage({ ...msg, id: job.id, run: job.run }), debug: !!job.debug };
  cancelled = false;
  try {
    const { segments, removed, levels } = await transcribe(ctx, job);
    let result = { segments, removed, speakers: 0, levels };
    if (job.diarize && segments.length > 0) {
      const d = await diarize(ctx, { ...job, segments });
      result = { ...result, segments: d.segments, speakers: d.speakers, speech: d.speech, debug: d.debug };
    }
    ctx.post({ type: 'result', ...result, seconds: (performance.now() - t0) / 1000 });
  } catch (err) {
    if (err instanceof Cancelled) {
      ctx.post({ type: 'cancelled' });
      return;
    }
    console.error(err);
    const message = String(err?.message ?? err);
    // Nur echte Grafikkarten-Probleme führen zum Wechsel auf den Prozessor – Netzwerkfehler nicht.
    const gpu = err instanceof GpuStageError && !NETWORK_ERROR.test(message);
    ctx.post({ type: 'error', message, gpu });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'transcribe') {
    // Immer nur ein Auftrag gleichzeitig.
    jobChain = jobChain.then(() => handleJob(msg));
  } else if (msg.type === 'cancel') {
    cancelled = true;
  } else if (msg.type === 'hello') {
    self.postMessage({ type: 'hello', threads: THREADS, isolated: self.crossOriginIsolated });
  }
};
