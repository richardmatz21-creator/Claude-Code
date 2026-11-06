// Hintergrund-Thread: Whisper-Umwandlung und Sprecher-Erkennung.
// Läuft getrennt von der Oberfläche, damit die Seite nicht einfriert.
import {
  pipeline, env, AutoProcessor, AutoModel, AutoModelForAudioFrameClassification,
} from './vendor/transformers.min.js';
import {
  SAMPLE_RATE, planChunks, frameLevels, speechLevel, isQuiet, filterHallucinations,
  clusterSpeakers, assignSpeakers,
} from './core.js';

const BASE = new URL('./', self.location.href).href;

// Alles kommt von der eigenen Seite – nie von Hugging Face oder einem CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Nur der Pfad, keine volle URL: transformers.js 4.3 prüft lokale Dateien sonst nicht.
env.localModelPath = new URL('./models/', self.location.href).pathname;
env.useBrowserCache = true;
const wasm = env.backends.onnx.wasm;
wasm.wasmPaths = {
  mjs: BASE + 'vendor/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: BASE + 'vendor/ort-wasm-simd-threaded.asyncify.wasm',
};
const THREADS = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, Math.ceil((self.navigator.hardwareConcurrency || 2) / 2)))
  : 1;
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

function post(msg) { self.postMessage(msg); }

// Lade-Fortschritt über alle Dateien eines Modells zusammenfassen.
function progressReporter(id, what) {
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
    post({ type: 'load-progress', id, what, loaded, total });
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

async function getAsr(id, model, mode, encoderDtype) {
  const key = `${model}|${mode}|${encoderDtype ?? ''}`;
  if (asr && asrKey === key) return asr;
  if (asr) {
    try { await asr.dispose(); } catch { /* egal */ }
    asr = null;
    asrKey = null;
  }
  post({ type: 'status', id, phase: 'loading', what: 'whisper' });
  asr = await pipeline('automatic-speech-recognition', WHISPER[model], {
    ...asrOptions(mode, encoderDtype),
    progress_callback: progressReporter(id, 'whisper'),
  });
  asrKey = key;
  return asr;
}

async function getDiarizationModels(id) {
  if (!segmentation) {
    post({ type: 'status', id, phase: 'loading', what: 'speakers' });
    const report = progressReporter(id, 'speakers');
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(SEGMENTATION, { progress_callback: report }),
      AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION, { device: 'wasm', dtype: 'fp32', progress_callback: report }),
    ]);
    segmentation = { processor, model };
  }
  if (!embedding) {
    const report = progressReporter(id, 'speakers');
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(EMBEDDING, { progress_callback: report }),
      AutoModel.from_pretrained(EMBEDDING, { device: 'wasm', dtype: 'fp32', progress_callback: report }),
    ]);
    embedding = { processor, model };
  }
}

function checkCancel() {
  if (cancelled) throw new Cancelled();
}

async function transcribe({ id, audio, model, language, mode, encoderDtype }) {
  const pipe = await getAsr(id, model, mode, encoderDtype);
  checkCancel();
  const levels = frameLevels(audio);
  const ref = speechLevel(levels);
  const chunks = planChunks(audio);
  const total = audio.length / SAMPLE_RATE;
  const segments = [];
  post({ type: 'status', id, phase: 'transcribing' });
  post({ type: 'progress', id, phase: 'transcribing', done: 0, total });
  for (const [a, b] of chunks) {
    checkCancel();
    const startSec = a / SAMPLE_RATE;
    const lenSec = (b - a) / SAMPLE_RATE;
    if (!isQuiet(levels, startSec, startSec + lenSec, ref)) {
      const out = await pipe(audio.subarray(a, b), {
        language: language === 'auto' ? null : language,
        task: 'transcribe',
        return_timestamps: true,
      });
      const parts = out.chunks?.length ? out.chunks : [{ timestamp: [0, lenSec], text: out.text }];
      for (const part of parts) {
        let [s, e] = part.timestamp ?? [0, lenSec];
        s = Math.max(0, Math.min(s ?? 0, lenSec));
        e = e == null || e <= s ? Math.min(lenSec, s + 5) : Math.min(e, lenSec);
        const text = (part.text ?? '').trim();
        if (text) segments.push({ start: startSec + s, end: startSec + e, text });
      }
    }
    post({ type: 'progress', id, phase: 'transcribing', done: (b / SAMPLE_RATE), total });
  }
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

async function diarize({ id, audio, segments, numSpeakers }) {
  await getDiarizationModels(id);
  checkCancel();
  post({ type: 'status', id, phase: 'diarizing' });
  const total = audio.length / SAMPLE_RATE;
  const window = 10 * SAMPLE_RATE;

  // 1. In 10-Sekunden-Fenstern erkennen, wann jemand spricht (lokale Sprecher je Fenster).
  const groups = new Map();
  for (let a = 0; a < audio.length; a += window) {
    checkCancel();
    const b = Math.min(audio.length, a + window);
    if (b - a < SAMPLE_RATE) break;
    const inputs = await segmentation.processor(audio.subarray(a, b));
    const { logits } = await segmentation.model(inputs);
    const result = segmentation.processor.post_process_speaker_diarization(logits, b - a)[0];
    for (const r of result) {
      // 0 = niemand spricht, 1–3 = ein Sprecher, 4–6 = zwei gleichzeitig (überspringen)
      if (r.id < 1 || r.id > 3) continue;
      const key = `${a}:${r.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ start: a / SAMPLE_RATE + r.start, end: a / SAMPLE_RATE + r.end });
    }
    post({ type: 'progress', id, phase: 'diarizing', done: (b / SAMPLE_RATE) * 0.5, total });
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
    post({ type: 'progress', id, phase: 'diarizing', done: total * (0.5 + 0.5 * n / groups.size), total });
  }

  // 3. Gleiche Stimmen über die ganze Aufnahme zusammenfassen.
  const labels = clusterSpeakers(embs, { weights, numSpeakers, threshold: 0.45 });
  const labelOf = new Map(keys.map((k, i) => [k, labels[i]]));
  const turns = [];
  for (const [key, regions] of groups) {
    if (!labelOf.has(key)) continue;
    for (const r of regions) turns.push({ ...r, speaker: labelOf.get(key) });
  }
  if (turns.length === 0) return { segments: segments.map((s) => ({ ...s, speaker: 0 })), speakers: 1 };

  // 4. Jedem Textabschnitt den passenden Sprecher geben, neu nummerieren nach Auftreten.
  const assigned = assignSpeakers(segments, turns);
  const order = new Map();
  for (const s of assigned) if (!order.has(s.speaker)) order.set(s.speaker, order.size);
  return {
    segments: assigned.map((s) => ({ ...s, speaker: order.get(s.speaker) })),
    speakers: Math.max(1, order.size),
  };
}

async function handleJob(job) {
  const t0 = performance.now();
  cancelled = false;
  try {
    const { segments, removed } = await transcribe(job);
    let result = { segments, removed, speakers: 0 };
    if (job.diarize && segments.length > 0) {
      const d = await diarize({ ...job, segments });
      result = { ...result, segments: d.segments, speakers: d.speakers };
    }
    post({ type: 'result', id: job.id, ...result, seconds: (performance.now() - t0) / 1000 });
  } catch (err) {
    if (err instanceof Cancelled) {
      post({ type: 'cancelled', id: job.id });
    } else {
      console.error(err);
      post({ type: 'error', id: job.id, message: String(err?.message ?? err), gpu: job.mode === 'gpu' });
    }
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'transcribe') handleJob(msg);
  else if (msg.type === 'cancel') cancelled = true;
  else if (msg.type === 'hello') post({ type: 'hello', threads: THREADS, isolated: self.crossOriginIsolated });
};
