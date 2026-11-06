// Oberfläche: Dateien → Umwandeln → Ergebnis.
import {
  SAMPLE_RATE, toSrt, toTxt, buildCues, speakerTimeline, formatClock, formatSrtTime,
  baseName, speakerName, groupParagraphs, activeSegments, findMatches, countMatches, replaceAll,
} from './core.js?v=__BUILD__';
import { zipSync, strToU8 } from './__ASSETS__/vendor/fflate.js';

// Ersetzt der Build durch die Versionskennung.
const BUILD = '__BUILD__';

const $ = (id) => document.getElementById(id);
const BIG_FILE = 500 * 1024 * 1024;
const MEDIA_EXT = /\.(mp3|wav|m4a|ogg|oga|opus|flac|aac|wma|webm|mp4|m4v|mov|mkv|3gp|amr|aiff?|caf)$/i;
const LANG = {
  de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch',
  pl: 'Polnisch', tr: 'Türkisch', ru: 'Russisch', uk: 'Ukrainisch', ar: 'Arabisch', auto: 'Sprache automatisch',
};
const QUALITY = { small: 'Ausgewogen', base: 'Schnell' };
const SETTINGS_KEY = 'audio-zu-text:einstellungen';
const DIAR_SHARE = 0.12; // Anteil der Sprecher-Erkennung am Gesamtfortschritt

// ---------- Zustand ----------

function loadSettings() {
  // gpuBrokenBuild: Version, in der die Grafikkarte versagt hat (gilt nur bis zum nächsten Update).
  const defaults = { model: 'small', language: 'de', diarize: false, speakers: 'auto', gpuBrokenBuild: null };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* privates Fenster o. ä. */ }
}

const state = {
  step: 1,
  files: [],
  settings: loadSettings(),
  mode: null,
  threads: null,
  isolated: self.crossOriginIsolated === true,
  running: false,
  cancelRequested: false,
  currentId: null,
  viewId: null,
  tab: 'text',
  loadInfo: null,
  whisperReady: false,
  workerReady: false,
  gpuDisabled: false,
  runId: 0,
  activeSeg: null,     // Abschnitt, in dem gerade der Cursor steht (Text-Ansicht)
  correcting: null,    // Nummer des Abschnitts im Korrektur-Modus, sonst null
  renderedFileId: null,
  subsDirty: false,
  searchOpen: false,
};
let nextId = 1;
let worker = null;
let wakeLock = null;
let cancelTimer = null;

const fileById = (id) => state.files.find((f) => f.id === id);
const currentFile = () => fileById(state.currentId);
const doneFiles = () => state.files.filter((f) => f.status === 'done');

// ---------- Hilfen ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function mb(bytes) { return (bytes / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 0 }); }
function sizeText(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 0 })} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
function durationText(sec) { return `${formatClock(sec)} Min`; }
function elapsedText(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} Sek.`;
  return `${Math.round(sec / 60)} Min`;
}
function etaText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'Restzeit wird berechnet …';
  if (sec < 60) return 'Noch weniger als eine Minute';
  const m = Math.round(sec / 60);
  return m === 1 ? 'Noch ungefähr 1 Minute' : `Noch ungefähr ${m} Minuten`;
}
function spkClass(i) { return `s${(i ?? 0) % 5}`; }
function settingsText(s) {
  const spk = s.diarize ? `an${s.speakers !== 'auto' ? ` (${s.speakers} Personen)` : ''}` : 'aus';
  return `${QUALITY[s.model]} · ${LANG[s.language] ?? s.language} · Sprecher erkennen: ${spk}`;
}
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const BOM = '﻿';

// ---------- Gerät prüfen ----------

async function detectMode() {
  const forced = new URLSearchParams(location.search).get('modus');
  if (forced === 'prozessor' || forced === 'cpu') return 'cpu';
  state.gpuDisabled = false;
  if (state.settings.gpuBrokenBuild === BUILD && forced !== 'grafikkarte') {
    state.gpuDisabled = true;
    return 'cpu';
  }
  try {
    if (!navigator.gpu) return 'cpu';
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || !adapter.features.has('shader-f16')) return 'cpu';
    return 'gpu';
  } catch {
    return 'cpu';
  }
}

function modeText() {
  if (!state.mode) return 'Dieses Gerät wird geprüft …';
  if (state.mode === 'gpu') return 'Dieses Gerät: Die Grafikkarte wird genutzt. Das geht schneller.';
  const gpuNote = state.gpuDisabled ? ' Die Grafikkarte hat hier zuletzt nicht funktioniert.' : '';
  if (!state.isolated) {
    return `Dieses Gerät: Der Prozessor rechnet mit nur einem Kern. Das dauert deutlich länger. Tipp: Seite einmal neu laden.${gpuNote}`;
  }
  const t = state.threads ? ` (${state.threads === 1 ? '1 Kern' : `${state.threads} Kerne`})` : '';
  return `Dieses Gerät: Der Prozessor rechnet${t}. Das dauert länger als mit einer Grafikkarte.${gpuNote}`;
}
function modeChip() {
  if (state.mode === 'gpu') return '<span class="chip chip-ok">Grafikkarte wird genutzt</span>';
  if (!state.isolated || state.threads === 1) return '<span class="chip chip-warn">Prozessor, 1 Kern (langsamer)</span>';
  return `<span class="chip">Prozessor rechnet${state.threads ? ` (${state.threads} Kerne)` : ''}</span>`;
}

function browserSupported() {
  return typeof WebAssembly === 'object' && typeof OfflineAudioContext === 'function' && typeof Worker === 'function';
}

// ---------- Hintergrund-Thread ----------

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js?v=__BUILD__', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => onWorkerMessage(ev.data);
  worker.onerror = (ev) => {
    ev.preventDefault?.();
    onWorkerCrash();
  };
  worker.postMessage({ type: 'hello' });
  return worker;
}

function onWorkerCrash() {
  const wasReady = state.workerReady;
  try { worker?.terminate(); } catch { /* egal */ }
  worker = null;
  state.whisperReady = false;
  state.workerReady = false;
  const f = currentFile();
  if (state.running && f) {
    if (state.cancelRequested) { finishCancel(); return; }
    f.status = 'error';
    f.error = wasReady
      ? 'Der Browser hatte nicht genug Arbeitsspeicher. Tipp: andere Tabs schließen, „Schnell“ wählen oder die Datei kürzen.'
      : 'Die Seite konnte nicht vollständig geladen werden. Bitte die Seite neu laden und erneut versuchen.';
    processNext();
  }
}

function friendlyError(message) {
  if (/memory|allocation|out of memory|RangeError/i.test(message)) {
    return 'Nicht genug Arbeitsspeicher. Tipp: andere Tabs schließen, „Schnell“ wählen oder die Datei kürzen.';
  }
  if (/fetch|network|Failed to load|Load failed|not found locally|Could not locate|ModelFileNotFound|Ladefehler|blockiert|is not valid JSON|Unexpected token '<'|protobuf|\b40[34]\b|\b50\d\b/i.test(message)) {
    return 'Das Sprachmodell konnte nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden. Im Firmennetz sperrt eventuell die IT den Download – dann bitte dort nachfragen.';
  }
  return `Unerwarteter Fehler: ${message}`;
}

function onWorkerMessage(msg) {
  if (msg.type === 'hello') {
    state.workerReady = true;
    state.threads = msg.threads;
    state.isolated = msg.isolated;
    renderModeInfo();
    return;
  }
  // Nachrichten aus einem abgebrochenen oder alten Lauf ignorieren.
  if (msg.run !== state.runId) return;
  const f = fileById(msg.id);
  if (!f || f.status !== 'running') return;
  switch (msg.type) {
    case 'status':
      f.phase = msg.phase;
      if (msg.phase === 'loading') state.loadInfo = { what: msg.what, loaded: 0, total: 0 };
      else state.loadInfo = null;
      if (msg.phase === 'transcribing') { state.whisperReady = true; f.tStart = performance.now(); }
      if (msg.phase === 'diarizing') f.dStart = performance.now();
      break;
    case 'load-progress':
      state.loadInfo = { what: msg.what, loaded: msg.loaded, total: msg.total };
      break;
    case 'progress': {
      f.phase = msg.phase;
      f.duration = msg.total;
      const diar = f.settings.diarize;
      const frac = msg.total > 0 ? Math.min(1, msg.done / msg.total) : 0;
      const now = performance.now();
      if (msg.phase === 'transcribing') {
        f.progress = frac * (diar ? 1 - DIAR_SHARE : 1);
        if (msg.done > 0 && f.tStart) {
          const rate = (now - f.tStart) / 1000 / msg.done;
          f.eta = (msg.total - msg.done) * rate + (diar ? msg.total * rate * 0.1 : 0);
        }
      } else {
        f.progress = 1 - DIAR_SHARE + DIAR_SHARE * frac;
        if (frac > 0 && f.dStart) f.eta = ((now - f.dStart) / 1000) * (1 - frac) / frac;
      }
      break;
    }
    case 'result':
      f.status = 'done';
      f.progress = 1;
      // Originaltext merken, damit Korrekturen markiert und zurückgesetzt werden können.
      for (const seg of msg.segments) seg.orig = seg.text;
      f.result = { segments: msg.segments, removed: msg.removed, speakers: msg.speakers };
      f.elapsed = msg.seconds;
      f.names = [];
      f.unsaved = true;
      state.loadInfo = null;
      processNext();
      return;
    case 'cancelled':
      finishCancel();
      return;
    case 'error':
      state.loadInfo = null;
      if (msg.gpu && state.mode === 'gpu') {
        // Grafikkarte hat nicht geklappt → dauerhaft auf Prozessor wechseln und dieselbe Datei neu starten.
        state.mode = 'cpu';
        state.gpuDisabled = true;
        state.settings.gpuBrokenBuild = BUILD;
        saveSettings();
        state.whisperReady = false;
        f.status = 'waiting';
        f.progress = 0;
        f.notice = 'Die Grafikkarte hat nicht mitgespielt – es geht mit dem Prozessor weiter.';
        renderModeInfo();
      } else {
        f.status = 'error';
        f.error = friendlyError(msg.message);
      }
      processNext();
      return;
  }
  renderProgress();
}

// ---------- Ablauf ----------

async function decodeAudio(file) {
  if (file.size === 0) throw new Error('leer');
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(buf);
  const n = decoded.length;
  const out = new Float32Array(n);
  const ch = decoded.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / ch;
  }
  return out;
}

function addFiles(list) {
  let added = 0;
  for (const file of list) {
    const ok = file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXT.test(file.name);
    const entry = {
      id: nextId++, file, name: file.name, size: file.size, progress: 0, names: [],
      status: ok ? (state.running ? 'waiting' : 'ready') : 'error',
      error: ok ? null : 'Das ist keine Audio- oder Videodatei.',
      settings: { ...state.settings },
      inRun: state.running,
    };
    state.files.push(entry);
    added++;
  }
  if (added) render();
}

function start() {
  const ready = state.files.filter((f) => f.status === 'ready');
  if (!ready.length || state.running) return;
  for (const f of ready) {
    f.status = 'waiting';
    f.progress = 0;
    f.settings = { ...state.settings };
    f.error = null;
    f.notice = null;
  }
  // Frühere Fehler gehören nicht zu diesem Lauf.
  for (const f of state.files) f.inRun = f.status === 'waiting';
  state.runId++;
  state.running = true;
  state.cancelRequested = false;
  state.step = 2;
  requestWakeLock();
  render();
  window.scrollTo({ top: 0 });
  processNext();
}

async function processNext() {
  if (state.cancelRequested) { finishCancel(); return; }
  const run = state.runId;
  const f = state.files.find((x) => x.status === 'waiting');
  if (!f) { finishAll(); return; }
  state.currentId = f.id;
  f.status = 'running';
  f.phase = 'decoding';
  f.progress = 0;
  f.eta = null;
  f.tStart = null;
  f.dStart = null;
  render();
  let audio;
  try {
    audio = await decodeAudio(f.file);
  } catch {
    if (run !== state.runId || f.status !== 'running') return;
    f.status = 'error';
    f.error = 'Diese Datei kann der Browser nicht lesen oder sie enthält keine Tonspur. Tipp: als MP3 oder WAV speichern und erneut versuchen.';
    processNext();
    return;
  }
  // Wurde während des Einlesens abgebrochen, gehört diese Datei nicht mehr zum aktuellen Lauf.
  if (run !== state.runId || f.status !== 'running') return;
  if (state.cancelRequested) { finishCancel(); return; }
  f.duration = audio.length / SAMPLE_RATE;
  if (f.duration < 0.3) {
    f.status = 'error';
    f.error = 'Die Datei enthält keinen Ton.';
    processNext();
    return;
  }
  f.phase = 'starting';
  renderProgress();
  const s = f.settings;
  getWorker().postMessage({
    type: 'transcribe',
    id: f.id,
    audio,
    model: s.model,
    language: s.language,
    diarize: s.diarize,
    numSpeakers: s.diarize && s.speakers !== 'auto' ? Number(s.speakers) : null,
    mode: state.mode,
    run,
  }, [audio.buffer]);
}

function finishAll() {
  state.running = false;
  state.currentId = null;
  state.loadInfo = null;
  releaseWakeLock();
  const done = doneFiles();
  if (done.length) {
    if (!fileById(state.viewId) || fileById(state.viewId).status !== 'done') state.viewId = done[0].id;
    state.step = 3;
    document.title = 'Fertig – Audio zu Text';
  } else {
    for (const f of state.files) if (f.status === 'waiting') f.status = 'ready';
    state.step = 1;
    document.title = 'Audio zu Text';
  }
  render();
}

function cancel() {
  if (!state.running || state.cancelRequested) return;
  state.cancelRequested = true;
  // Wird die Datei gerade erst eingelesen, ist der Hintergrund-Thread noch nicht beteiligt:
  // sofort abbrechen, das geladene Modell bleibt erhalten.
  const f = currentFile();
  if (!f || f.phase === 'decoding') { finishCancel(); return; }
  worker?.postMessage({ type: 'cancel' });
  renderProgress();
  clearTimeout(cancelTimer);
  // Steckt der Hintergrund-Thread gerade in einer langen Rechnung, wird er hart beendet.
  cancelTimer = setTimeout(() => {
    if (state.cancelRequested && state.running) {
      try { worker?.terminate(); } catch { /* egal */ }
      worker = null;
      state.whisperReady = false;
      finishCancel();
    }
  }, 4000);
}

function finishCancel() {
  clearTimeout(cancelTimer);
  state.runId++;
  for (const f of state.files) {
    if (f.status === 'waiting' || f.status === 'running') {
      f.status = 'ready';
      f.progress = 0;
      f.notice = 'Abgebrochen – kann erneut gestartet werden.';
    }
  }
  state.running = false;
  state.cancelRequested = false;
  state.currentId = null;
  state.loadInfo = null;
  releaseWakeLock();
  state.step = 1;
  document.title = 'Audio zu Text';
  render();
}

function resetAll() {
  const unsaved = doneFiles().some((f) => f.unsaved);
  if (unsaved && !confirm('Die bisherigen Ergebnisse und Korrekturen werden verworfen. Hast du alles heruntergeladen, was du brauchst?')) return;
  stopPlayback();
  for (const f of state.files) {
    if (f.audioUrl && f.status !== 'waiting' && f.status !== 'running') URL.revokeObjectURL(f.audioUrl);
  }
  state.correcting = null;
  state.activeSeg = null;
  state.files = state.files.filter((f) => f.status === 'waiting' || f.status === 'running');
  state.viewId = null;
  state.step = state.running ? 2 : 1;
  document.title = 'Audio zu Text';
  render();
}

// ---------- Bildschirm anlassen ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* nicht unterstützt oder Tab unsichtbar */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* egal */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) requestWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  // Die Seite speichert nichts: warnen, solange umgewandelt wird oder Ergebnisse/Korrekturen nicht heruntergeladen sind.
  if (state.running || doneFiles().some((f) => f.unsaved)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Darstellung ----------

function render() {
  $('step1').hidden = state.step !== 1;
  $('step2').hidden = state.step !== 2;
  $('step3').hidden = state.step !== 3;
  renderSteps();
  if (state.step === 1) renderStep1();
  if (state.step === 2) renderProgress();
  if (state.step === 3) renderResult();
  updateTitle();
}

function renderSteps() {
  const names = ['Dateien', 'Umwandeln', 'Ergebnis'];
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
  $('steps').innerHTML = names.map((n, i) => {
    const k = i + 1;
    const cls = k < state.step ? 'done' : k === state.step ? 'current' : 'todo';
    return `<li class="${cls}"${k === state.step ? ' aria-current="step"' : ''}>
      <span class="step-dot">${cls === 'done' ? check : k}</span>
      <span class="step-text"><small>Schritt ${k}</small><span>${n}</span></span>
    </li>`;
  }).join('');
}

function renderModeInfo() {
  $('mode-info').textContent = modeText();
  $('retry-gpu').hidden = !(state.gpuDisabled && state.mode === 'cpu' && !state.running);
  if (state.step === 2) renderProgress();
}

function fileStatusText(f) {
  switch (f.status) {
    case 'ready': return f.notice ? f.notice : `Bereit · ${sizeText(f.size)}`;
    case 'waiting': return 'Wartet';
    case 'running':
      if (f.phase === 'decoding') return 'Ton wird gelesen …';
      if (f.phase === 'loading' || f.phase === 'starting') return 'Wird vorbereitet …';
      if (f.phase === 'diarizing') return `Sprecher werden erkannt · ${Math.round(f.progress * 100)} %`;
      return `Wird umgewandelt · ${Math.round(f.progress * 100)} %`;
    case 'done': return `Fertig · ${durationText(f.duration)}`;
    case 'error': return `Fehler: ${f.error}`;
    default: return '';
  }
}

function fileItem(f, { removable = false } = {}) {
  const warn = f.size > BIG_FILE && f.status !== 'done'
    ? `<p class="file-warn">Sehr große Datei (${sizeText(f.size)}). Der Laptop könnte dafür zu wenig Arbeitsspeicher haben. Tipp: vorher nur den Ton exportieren, z. B. als MP3.</p>`
    : '';
  const actions = [];
  if (f.status === 'done') actions.push(`<button type="button" class="btn btn-primary btn-small" data-action="view" data-id="${f.id}">Ergebnis ansehen</button>`);
  if (removable && f.status !== 'running') {
    actions.push(`<button type="button" class="icon-btn" data-action="remove" data-id="${f.id}" aria-label="${esc(f.name)} entfernen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);
  }
  return `<li class="file-item${f.id === state.currentId ? ' active' : ''}">
    <span class="file-main">
      <span class="file-name">${esc(f.name)}</span>
      <span class="file-meta${f.status === 'error' ? ' err' : ''}">${esc(fileStatusText(f))}</span>
    </span>
    ${actions.join('')}
    ${warn}
  </li>`;
}

function renderStep1() {
  const s = state.settings;
  $('set-model').value = s.model;
  $('set-language').value = s.language;
  $('set-diarize').checked = s.diarize;
  $('set-diarize-state').textContent = s.diarize ? 'An' : 'Aus';
  $('field-speakers').hidden = !s.diarize;
  $('set-speakers').value = s.speakers;
  $('file-list-wrap').hidden = state.files.length === 0;
  $('file-list').innerHTML = state.files.map((f) => fileItem(f, { removable: true })).join('');
  const ready = state.files.filter((f) => f.status === 'ready').length;
  $('start-btn').disabled = ready === 0;
  $('start-btn').textContent = ready > 1 ? `${ready} Dateien umwandeln` : 'Umwandeln starten';
  $('start-hint').textContent = ready === 0
    ? (doneFiles().length ? '' : 'Wähle zuerst mindestens eine Datei aus.')
    : (state.whisperReady ? '' : 'Beim ersten Mal wird das Sprachmodell einmalig geladen.');
  renderModeInfo();
}

function renderProgress() {
  updateTitle();
  if (state.step === 3) { renderStillRunning(); return; }
  if (state.step !== 2) return;
  const f = currentFile();
  const files = state.files.filter((x) => x.inRun);
  const queue = files;
  const idx = f ? queue.indexOf(f) + 1 : 0;
  let pct = f ? Math.round(f.progress * 100) : 0;
  let title = 'Wird vorbereitet …';
  let sub = '';
  let spin = false;
  if (state.cancelRequested) {
    title = 'Wird abgebrochen …';
    spin = true;
  } else if (f) {
    const pos = queue.length > 1 ? `Datei ${idx} von ${queue.length}` : '';
    if (f.phase === 'decoding' || f.phase === 'starting') {
      title = `${f.name} wird vorbereitet`;
      sub = pos;
      spin = true;
    } else if (f.phase === 'loading' && state.loadInfo) {
      const li = state.loadInfo;
      title = li.what === 'speakers' ? 'Modell für die Sprecher-Erkennung wird geladen' : 'Sprachmodell wird geladen';
      if (li.total > 0) {
        pct = Math.round((li.loaded / li.total) * 100);
        sub = `${mb(li.loaded)} von ${mb(li.total)} MB · nur beim ersten Mal, danach bleibt es gespeichert`;
      } else {
        spin = true;
        sub = 'Einen Moment …';
      }
    } else if (f.phase === 'diarizing') {
      title = 'Sprecher werden erkannt';
      sub = [etaText(f.eta), pos].filter(Boolean).join(' · ');
    } else {
      title = `${f.name} wird umgewandelt`;
      sub = [etaText(f.eta), pos].filter(Boolean).join(' · ');
    }
  }
  const ring = document.querySelector('.ring');
  ring.classList.toggle('spin', spin);
  if (spin) ring.removeAttribute('aria-valuenow');
  else ring.setAttribute('aria-valuenow', String(pct));
  ring.setAttribute('aria-valuetext', spin ? title : `${pct} Prozent`);
  $('ring-fg').setAttribute('stroke-dasharray', `${spin ? 90 : Math.round(3.644 * pct)} 365`);
  $('ring-label').textContent = spin ? '' : `${pct} %`;
  $('progress-title').textContent = title;
  $('progress-sub').textContent = sub;
  const chips = [modeChip()];
  if (f) chips.push(`<span class="chip">Qualität: ${QUALITY[f.settings.model]}</span>`);
  if (state.whisperReady) chips.push('<span class="chip chip-ok">Sprachmodell bereit</span>');
  if (f?.notice && f.status === 'running') chips.push(`<span class="chip chip-warn">${esc(f.notice)}</span>`);
  $('progress-chips').innerHTML = chips.join('');
  $('cancel-btn').disabled = state.cancelRequested;
  $('queue-list').innerHTML = files.map((x) => fileItem(x)).join('');
  $('summary-2').innerHTML = `<span><strong>Einstellungen:</strong> ${esc(settingsText(f?.settings ?? state.settings))}</span>`;
}

function updateTitle() {
  const f = currentFile();
  if (state.running && f) {
    const pct = f.phase === 'loading' && state.loadInfo?.total
      ? Math.round((state.loadInfo.loaded / state.loadInfo.total) * 100)
      : Math.round(f.progress * 100);
    document.title = `${pct} % – Audio zu Text`;
  }
}

function renderStillRunning() {
  const box = $('still-running');
  const f = currentFile();
  if (!state.running || !f) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<span>Es wird noch umgewandelt: <strong>${esc(f.name)}</strong> – ${Math.round(f.progress * 100)} %</span>
    <button type="button" class="btn btn-secondary btn-small" data-action="show-progress">Fortschritt ansehen</button>`;
}

function currentView() {
  const f = fileById(state.viewId);
  return f && f.status === 'done' ? f : doneFiles()[0];
}

function viewOpts(f) {
  return { names: f.names, withSpeakers: f.result.speakers > 0 };
}

function renderFailed() {
  const failed = state.files.filter((x) => x.status === 'error' && x.inRun);
  const box = $('failed-box');
  box.hidden = failed.length === 0;
  if (!failed.length) return;
  box.innerHTML = `<div><strong>${failed.length === 1 ? '1 Datei konnte' : `${failed.length} Dateien konnten`} nicht umgewandelt werden:</strong>
    <ul class="plain-list">${failed.map((x) => `<li><strong>${esc(x.name)}</strong> – ${esc(x.error)}</li>`).join('')}</ul></div>`;
}

function renderResult() {
  renderStillRunning();
  renderFailed();
  const f = currentView();
  if (!f) { state.step = state.running ? 2 : 1; render(); return; }
  if (state.renderedFileId !== f.id) {
    state.correcting = null;
    state.activeSeg = null;
    stopPlayback();
  }
  state.viewId = f.id;
  const done = doneFiles();
  $('result-files').innerHTML = `<span class="label">Ergebnis für:</span>` + done.map((d) =>
    `<button type="button" class="file-chip" data-action="view" data-id="${d.id}" aria-pressed="${d.id === f.id}" title="${esc(d.name)}">${esc(d.name)}</button>`).join('');
  $('result-files').hidden = done.length < 2;
  $('result-title').textContent = `${f.name} ist fertig`;
  const parts = [
    `${durationText(f.duration)} Audio`,
    `in ${elapsedText(f.elapsed)} umgewandelt`,
    LANG[f.settings.language] ?? f.settings.language,
  ];
  if (f.result.speakers > 0) parts.push(f.result.speakers === 1 ? '1 Sprecher' : `${f.result.speakers} Sprecher`);
  $('result-sub').textContent = parts.join(' · ');
  $('zip-btn').hidden = done.length < 2;
  $('copy-status').textContent = '';
  renderUnsaved(f);
  renderTabs();
  // Nicht neu zeichnen, während jemand im Text tippt (z. B. wenn nebenbei eine andere Datei fertig wird).
  const typing = $('transcript').contains(document.activeElement) || $('names').contains(document.activeElement)
    || document.activeElement === $('corr-text');
  if (!typing || state.renderedFileId !== f.id) {
    renderTranscript(f);
    renderSubtitles(f, true);
  }
  renderCorrect(f);
  updateSearch();
  state.renderedFileId = f.id;
  const note = $('removed-note');
  note.hidden = !f.result.removed;
  note.textContent = f.result.removed === 1
    ? '1 erfundene oder wiederholte Stelle wurde automatisch entfernt.'
    : `${f.result.removed} erfundene oder wiederholte Stellen wurden automatisch entfernt.`;
  $('summary-3').innerHTML = `<span><strong>Einstellungen:</strong> ${esc(settingsText(f.settings))}</span>
    <button type="button" class="btn btn-dashed" data-action="reset">Neue Dateien umwandeln</button>`;
}

function renderTabs() {
  const text = state.tab === 'text';
  const correcting = state.correcting !== null;
  document.querySelector('.tabs').hidden = correcting;
  $('edit-bar').hidden = correcting;
  // Suchen & Ersetzen gilt für die Text-Ansicht; im Korrektur-Modus ausgeblendet.
  $('search-bar').hidden = correcting || !state.searchOpen;
  if (correcting) {
    $('panel-text').hidden = true;
    $('panel-subs').hidden = true;
    return;
  }
  $('tab-text').setAttribute('aria-selected', String(text));
  $('tab-subs').setAttribute('aria-selected', String(!text));
  $('tab-text').tabIndex = text ? 0 : -1;
  $('tab-subs').tabIndex = text ? -1 : 0;
  $('panel-text').hidden = !text;
  $('panel-subs').hidden = text;
}

const PLAY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
// Reiner-Text-Bearbeitung (keine Formatierung) – Chrome und Edge können das direkt.
const EDITABLE = (() => {
  const d = document.createElement('div');
  d.contentEditable = 'plaintext-only';
  return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
})();
function textLang(f) { return f.settings.language === 'auto' ? 'de' : f.settings.language; }
const isEdited = (seg) => seg.text !== seg.orig;

function renderTranscript(f) {
  const groups = groupParagraphs(f.result.segments, viewOpts(f));
  if (!groups.length) {
    $('transcript').innerHTML = '<p class="empty">Es wurde kein gesprochener Text erkannt. Enthält die Datei Sprache?</p>';
    return;
  }
  const lang = textLang(f);
  $('transcript').innerHTML = groups.map((g) => {
    const label = g.label ? `<span class="who who-label ${spkClass(g.speaker)}">${esc(g.label)}:</span> ` : '';
    const segs = g.items.map(({ index, seg }) => `<span class="seg${isEdited(seg) ? ' edited' : ''}" contenteditable="${EDITABLE}" spellcheck="true" lang="${lang}" role="textbox" aria-label="Abschnitt ${index + 1}, ${formatClock(seg.start)} bis ${formatClock(seg.end)}" data-seg="${index}">${esc(seg.text)}</span>`).join(' ');
    return `<p>${label}${segs}</p>`;
  }).join('');
  if (state.activeSeg !== null) showSegTools(f, state.activeSeg);
  applySearchHighlight();
}

function segSpan(index) { return $('transcript').querySelector(`.seg[data-seg="${index}"]`); }

// Kleine Werkzeugleiste (Anhören, Original) direkt hinter dem Abschnitt, in dem der Cursor steht.
function showSegTools(f, index) {
  $('seg-tools')?.remove();
  const span = segSpan(index);
  const seg = f.result.segments[index];
  if (!span || !seg) return;
  const playing = isPlaying(f.id, index);
  const tools = document.createElement('span');
  tools.id = 'seg-tools';
  tools.className = 'seg-tools';
  tools.contentEditable = 'false';
  tools.innerHTML = `<button type="button" class="tool-btn" data-action="seg-play" aria-label="${playing ? 'Abspielen stoppen' : `Abschnitt ${index + 1} anhören`}">${playing ? STOP_ICON + 'Stopp' : PLAY_ICON + 'Anhören'}</button>`
    + (isEdited(seg) ? `<button type="button" class="tool-btn" data-action="seg-reset" aria-label="Abschnitt ${index + 1}: Original wiederherstellen">Original wiederherstellen</button>` : '');
  span.after(tools);
}

function onSegmentEdited(f, index, text) {
  const seg = f.result.segments[index];
  seg.text = text.replace(/[\r\n]+/g, ' ');
  f.unsaved = true;
  f.modified = true;
  state.subsDirty = true;
  renderUnsaved(f);
  updateSearch(false);
}

function renderUnsaved(f) {
  $('unsaved-hint').hidden = !(f.unsaved && f.modified);
}

// ---------- Korrektur-Modus: Abschnitt für Abschnitt ----------

function renderCorrect(f) {
  const panel = $('correct');
  if (state.correcting === null) { panel.hidden = true; return; }
  const segs = f.result.segments;
  const i = Math.max(0, Math.min(state.correcting, segs.length - 1));
  state.correcting = i;
  const seg = segs[i];
  panel.hidden = false;
  $('corr-pos').textContent = `Abschnitt ${i + 1} von ${segs.length}`;
  const who = f.result.speakers > 0 ? `${speakerName(f.names, seg.speaker ?? 0)} · ` : '';
  $('corr-meta').textContent = `${who}${formatClock(seg.start)} – ${formatClock(seg.end)}`;
  const ta = $('corr-text');
  ta.lang = textLang(f);
  ta.spellcheck = true;
  if (document.activeElement !== ta || ta.dataset.seg !== String(i)) ta.value = seg.text;
  ta.dataset.seg = String(i);
  renderCorrectOrig(seg);
  $('corr-prev').disabled = i === 0;
  const last = i === segs.length - 1;
  $('corr-next').textContent = last ? 'Fertig' : 'Weiter →';
  $('corr-done').hidden = last;
  const playing = isPlaying(f.id, i);
  $('corr-play').innerHTML = playing ? `${STOP_ICON} Stopp` : `${PLAY_ICON} Anhören`;
}

function renderCorrectOrig(seg) {
  $('corr-orig').hidden = !isEdited(seg);
  $('corr-orig-text').textContent = `Original: ${seg.orig}`;
}

function startCorrecting(f, index) {
  state.correcting = index ?? state.activeSeg ?? 0;
  renderTabs();
  renderCorrect(f);
  $('correct').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('corr-text').focus();
  if ($('corr-auto').checked) playSegment(f, state.correcting);
}

function moveCorrecting(f, delta) {
  const next = state.correcting + delta;
  if (next < 0) return;
  if (next >= f.result.segments.length) { stopCorrecting(f); return; }
  state.correcting = next;
  renderCorrect(f);
  $('corr-text').focus();
  if ($('corr-auto').checked) playSegment(f, next);
  else stopPlayback();
}

function stopCorrecting(f) {
  const last = state.correcting;
  state.correcting = null;
  stopPlayback();
  renderTabs();
  renderTranscript(f);
  if (state.subsDirty) { renderSubtitles(f, false); state.subsDirty = false; }
  renderCorrect(f);
  const span = segSpan(last);
  if (span) {
    span.scrollIntoView({ block: 'center' });
    span.focus();
  }
}

// ---------- Anhören ----------

const player = new Audio();
player.preload = 'auto';
let playback = null; // { fileId, index, stopAt }

function isPlaying(fileId, index) {
  return playback && playback.fileId === fileId && playback.index === index && !player.paused;
}

function refreshPlayButtons() {
  const f = currentView();
  if (!f || state.step !== 3) return;
  for (const el of $('transcript').querySelectorAll('.seg.playing')) el.classList.remove('playing');
  if (playback && !player.paused && playback.fileId === f.id) segSpan(playback.index)?.classList.add('playing');
  if (state.activeSeg !== null && $('seg-tools')) showSegTools(f, state.activeSeg);
  if (state.correcting !== null) {
    $('corr-play').innerHTML = isPlaying(f.id, state.correcting) ? `${STOP_ICON} Stopp` : `${PLAY_ICON} Anhören`;
  }
}

function stopPlayback() {
  if (!player.paused) player.pause();
  playback = null;
  refreshPlayButtons();
}

async function playSegment(f, index) {
  const seg = f.result.segments[index];
  if (!seg) return;
  if (isPlaying(f.id, index)) { stopPlayback(); return; }
  try {
    if (!f.audioUrl) f.audioUrl = URL.createObjectURL(f.file);
    if (player.src !== f.audioUrl) {
      player.src = f.audioUrl;
      await new Promise((resolve, reject) => {
        player.addEventListener('loadedmetadata', resolve, { once: true });
        player.addEventListener('error', reject, { once: true });
      });
    }
    player.currentTime = Math.max(0, seg.start - 0.2);
    playback = { fileId: f.id, index, stopAt: seg.end + 0.25 };
    await player.play();
    refreshPlayButtons();
    const tick = () => {
      if (!playback || player.paused) return;
      if (player.currentTime >= playback.stopAt) { stopPlayback(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    playback = null;
    $('copy-status').textContent = 'Diese Datei kann der Browser leider nicht abspielen. Korrigieren geht trotzdem.';
    refreshPlayButtons();
  }
}
player.addEventListener('ended', () => { playback = null; refreshPlayButtons(); });
player.addEventListener('pause', () => refreshPlayButtons());

// ---------- Suchen und Ersetzen ----------

function updateSearch(rerenderHighlight = true) {
  const f = currentView();
  const open = !$('search-bar').hidden;
  const q = $('search-q').value;
  if (!f || !open) { if ('highlights' in CSS) CSS.highlights.delete('suche'); return; }
  const n = q ? countMatches(f.result.segments, q) : 0;
  $('search-count').textContent = !q ? '' : n === 1 ? '1 Treffer' : `${n} Treffer`;
  $('replace-all').disabled = n === 0;
  if (rerenderHighlight) applySearchHighlight();
  else applySearchHighlight();
}

// Treffer farbig markieren, ohne den Text zu verändern (CSS Custom Highlight API).
function applySearchHighlight() {
  if (!('highlights' in CSS) || typeof Highlight !== 'function') return;
  CSS.highlights.delete('suche');
  const q = $('search-q').value;
  if (!q || $('search-bar').hidden) return;
  const ranges = [];
  for (const span of $('transcript').querySelectorAll('.seg')) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [a, b] of findMatches(node.data, q)) {
        const r = new Range();
        r.setStart(node, a);
        r.setEnd(node, b);
        ranges.push(r);
      }
    }
  }
  if (ranges.length) CSS.highlights.set('suche', new Highlight(...ranges));
}

function renderSubtitles(f, withInputs = false) {
  const opts = viewOpts(f);
  const nSpk = f.result.speakers;
  const total = f.duration || f.result.segments.at(-1)?.end || 1;
  $('timeline-wrap').hidden = nSpk === 0;
  $('names').hidden = nSpk === 0;
  if (nSpk > 0) {
    $('legend').innerHTML = Array.from({ length: nSpk }, (_, i) =>
      `<span><span class="dot ${spkClass(i)}"></span>${esc(speakerName(f.names, i))}</span>`).join('');
    $('timeline').innerHTML = speakerTimeline(activeSegments(f.result.segments)).map((t) =>
      `<span class="${spkClass(t.speaker)}" style="left:${(t.start / total) * 100}%;width:${Math.max(0.3, ((t.end - t.start) / total) * 100)}%"></span>`).join('');
    const marks = [0, 0.25, 0.5, 0.75, 1].map((r) => `<span>${formatClock(total * r)}</span>`);
    $('timeline-scale').innerHTML = marks.join('');
    if (withInputs) {
      $('names').innerHTML = Array.from({ length: nSpk }, (_, i) => `
        <div class="field">
          <label for="name-${i}" class="name-label"><span class="dot ${spkClass(i)}"></span>Sprecher ${i + 1} heißt</label>
          <input id="name-${i}" type="text" data-speaker="${i}" value="${esc(f.names[i] ?? '')}" placeholder="Sprecher ${i + 1}" autocomplete="off">
        </div>`).join('');
    }
  }
  // Gleiche Aufteilung wie in der SRT-Datei; der Name wird hier nur getrennt angezeigt.
  const cues = buildCues(activeSegments(f.result.segments), { ...opts, labelInText: false });
  $('cues').innerHTML = cues.length ? cues.map((c, i) => `
    <article class="cue">
      <span class="cue-no">${i + 1}</span>
      <div class="cue-body">
        <span class="cue-meta">
          ${opts.withSpeakers ? `<strong class="who-label ${spkClass(c.speaker)}"><span class="dot ${spkClass(c.speaker)}"></span>${esc(speakerName(f.names, c.speaker))}</strong>` : ''}
          <span class="cue-time">${formatSrtTime(c.start)} → ${formatSrtTime(c.end)}</span>
        </span>
        <p class="cue-text">${esc(c.text)}</p>
      </div>
    </article>`).join('') : '<p class="empty">Keine Untertitel – es wurde kein gesprochener Text erkannt.</p>';
}

// ---------- Ergebnis-Aktionen ----------

// Geleerte Abschnitte fallen aus den Dateien heraus.
function srtFor(f) { return toSrt(activeSegments(f.result.segments), viewOpts(f)); }
function txtFor(f) { return toTxt(activeSegments(f.result.segments), viewOpts(f)); }

function uniqueNames(files, ext) {
  const used = new Map();
  return files.map((f) => {
    const base = baseName(f.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `${base}${n > 1 ? ` (${n})` : ''}.${ext}`;
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function onAction(action, id) {
  const f = currentView();
  switch (action) {
    case 'remove':
      state.files = state.files.filter((x) => x.id !== Number(id) || x.status === 'running');
      render();
      break;
    case 'view':
      if (state.viewId !== Number(id)) $('replace-undo').hidden = true;
      state.viewId = Number(id);
      state.step = 3;
      render();
      window.scrollTo({ top: 0 });
      break;
    case 'show-progress':
      state.step = 2;
      render();
      break;
    case 'reset':
      resetAll();
      break;
    case 'retry-gpu':
      state.settings.gpuBrokenBuild = null;
      saveSettings();
      state.mode = await detectMode();
      renderModeInfo();
      break;
    case 'dl-srt':
      if (!f) return;
      downloadBlob(uniqueNames([f], 'srt')[0], new Blob([BOM + srtFor(f)], { type: 'application/x-subrip;charset=utf-8' }));
      f.unsaved = false;
      renderUnsaved(f);
      break;
    case 'dl-txt':
      if (!f) return;
      downloadBlob(uniqueNames([f], 'txt')[0], new Blob([BOM + txtFor(f)], { type: 'text/plain;charset=utf-8' }));
      f.unsaved = false;
      renderUnsaved(f);
      break;
    case 'dl-zip': {
      const done = doneFiles();
      const entries = {};
      const srtNames = uniqueNames(done, 'srt');
      const txtNames = uniqueNames(done, 'txt');
      done.forEach((d, i) => {
        entries[srtNames[i]] = strToU8(BOM + srtFor(d));
        entries[txtNames[i]] = strToU8(BOM + txtFor(d));
        d.unsaved = false;
      });
      if (f) renderUnsaved(f);
      downloadBlob('transkripte.zip', new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }));
      break;
    }
    case 'copy':
      if (!f) return;
      if (await copyText(txtFor(f))) {
        $('copy-status').textContent = 'Text kopiert.';
      } else {
        $('copy-status').textContent = 'Kopieren hat nicht geklappt. Bitte „Text (TXT)“ verwenden.';
      }
      break;
    case 'seg-play':
      if (f && state.activeSeg !== null) playSegment(f, state.activeSeg);
      break;
    case 'seg-reset': {
      if (!f || state.activeSeg === null) return;
      const seg = f.result.segments[state.activeSeg];
      onSegmentEdited(f, state.activeSeg, seg.orig);
      const span = segSpan(state.activeSeg);
      if (span) { span.textContent = seg.orig; span.classList.remove('edited'); span.focus(); }
      showSegTools(f, state.activeSeg);
      applySearchHighlight();
      break;
    }
    case 'corr-start':
      if (f) startCorrecting(f);
      break;
    case 'corr-prev':
      if (f) moveCorrecting(f, -1);
      break;
    case 'corr-next':
      if (f) moveCorrecting(f, +1);
      break;
    case 'corr-done':
      if (f) stopCorrecting(f);
      break;
    case 'corr-play':
      if (f && state.correcting !== null) playSegment(f, state.correcting);
      break;
    case 'corr-reset': {
      if (!f || state.correcting === null) return;
      const seg = f.result.segments[state.correcting];
      onSegmentEdited(f, state.correcting, seg.orig);
      $('corr-text').value = seg.orig;
      renderCorrectOrig(seg);
      $('corr-text').focus();
      break;
    }
    case 'search-toggle': {
      state.searchOpen = !state.searchOpen;
      $('search-bar').hidden = !state.searchOpen;
      $('search-toggle').setAttribute('aria-expanded', String(state.searchOpen));
      if (state.searchOpen) $('search-q').focus();
      updateSearch();
      break;
    }
    case 'replace-all': {
      if (!f) return;
      const q = $('search-q').value;
      const before = f.result.segments.map((s) => s.text);
      const n = replaceAll(f.result.segments, q, $('search-r').value);
      if (!n) return;
      // Pro Abschnitt Vorher/Nachher merken: Rückgängig betrifft nur Abschnitte, die seitdem niemand angefasst hat.
      f.undo = f.result.segments
        .map((s, index) => ({ index, before: before[index], after: s.text }))
        .filter((u) => u.before !== u.after);
      f.unsaved = true;
      f.modified = true;
      renderTranscript(f);
      renderSubtitles(f, false);
      renderUnsaved(f);
      updateSearch();
      $('search-count').textContent = n === 1 ? '1 Stelle ersetzt.' : `${n} Stellen ersetzt.`;
      $('replace-undo').hidden = false;
      break;
    }
    case 'replace-undo': {
      if (!f || !f.undo) return;
      let kept = 0;
      for (const u of f.undo) {
        const seg = f.result.segments[u.index];
        if (seg.text === u.after) seg.text = u.before;
        else kept++;
      }
      f.undo = null;
      f.unsaved = true;
      renderTranscript(f);
      renderSubtitles(f, false);
      renderUnsaved(f);
      $('replace-undo').hidden = true;
      updateSearch();
      $('search-count').textContent = kept
        ? `Ersetzen rückgängig gemacht. ${kept === 1 ? '1 Abschnitt hattest' : `${kept} Abschnitte hattest`} du danach von Hand geändert – ${kept === 1 ? 'der bleibt' : 'die bleiben'} so.`
        : 'Ersetzen rückgängig gemacht.';
      break;
    }
  }
}

// ---------- Ereignisse ----------

function bind() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) onAction(el.dataset.action, el.dataset.id);
  });

  const input = $('file-input');
  input.addEventListener('change', () => {
    addFiles(Array.from(input.files ?? []));
    input.value = '';
  });
  $('add-more-btn').addEventListener('click', () => input.click());
  $('start-btn').addEventListener('click', start);
  $('cancel-btn').addEventListener('click', cancel);

  const dz = $('dropzone');
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (state.step === 1) dz.classList.add('drag');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.target === dz || !dz.contains(e.relatedTarget)) dz.classList.remove('drag');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dz.classList.remove('drag');
    if (state.step === 3) return;
    addFiles(Array.from(e.dataTransfer.files));
  });

  $('set-model').addEventListener('change', (e) => { state.settings.model = e.target.value; saveSettings(); renderStep1(); });
  $('set-language').addEventListener('change', (e) => { state.settings.language = e.target.value; saveSettings(); });
  $('set-diarize').addEventListener('change', (e) => { state.settings.diarize = e.target.checked; saveSettings(); renderStep1(); });
  $('set-speakers').addEventListener('change', (e) => { state.settings.speakers = e.target.value; saveSettings(); });

  for (const tab of [$('tab-text'), $('tab-subs')]) {
    tab.addEventListener('click', () => {
      state.tab = tab.id === 'tab-text' ? 'text' : 'subs';
      const f = currentView();
      if (f && state.tab === 'subs' && state.subsDirty) { renderSubtitles(f, false); state.subsDirty = false; }
      renderTabs();
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      state.tab = state.tab === 'text' ? 'subs' : 'text';
      const f = currentView();
      if (f && state.tab === 'subs' && state.subsDirty) { renderSubtitles(f, false); state.subsDirty = false; }
      renderTabs();
      (state.tab === 'text' ? $('tab-text') : $('tab-subs')).focus();
    });
  }

  // Text direkt bearbeiten
  const tr = $('transcript');
  tr.addEventListener('focusin', (e) => {
    const span = e.target.closest?.('.seg');
    const f = currentView();
    if (!span || !f) return;
    state.activeSeg = Number(span.dataset.seg);
    showSegTools(f, state.activeSeg);
  });
  tr.addEventListener('input', (e) => {
    const span = e.target.closest?.('.seg');
    const f = currentView();
    if (!span || !f) return;
    const index = Number(span.dataset.seg);
    onSegmentEdited(f, index, span.textContent);
    const edited = isEdited(f.result.segments[index]);
    if (span.classList.contains('edited') !== edited) {
      span.classList.toggle('edited', edited);
      showSegTools(f, index);
    }
  });
  tr.addEventListener('keydown', (e) => {
    const span = e.target.closest?.('.seg');
    const f = currentView();
    if (!span || !f || e.isComposing) return;
    const index = Number(span.dataset.seg);
    if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      playSegment(f, index);
    } else if (e.key === 'Enter') {
      // Kein Zeilenumbruch im Abschnitt: weiter zum nächsten Abschnitt.
      e.preventDefault();
      const next = segSpan(index + 1);
      if (next) {
        next.focus();
        const sel = getSelection();
        sel.selectAllChildren(next);
        sel.collapseToEnd();
      } else {
        span.blur();
      }
    } else if (e.key === 'Escape') {
      stopPlayback();
    }
  });
  tr.addEventListener('paste', (e) => {
    if (!e.target.closest?.('.seg')) return;
    // Nur reinen Text einfügen, ohne Formatierung und Zeilenumbrüche.
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ');
    document.execCommand('insertText', false, text);
  });
  // Werkzeug-Knöpfe sollen den Cursor nicht aus dem Text nehmen.
  tr.addEventListener('mousedown', (e) => {
    if (e.target.closest?.('.seg-tools')) e.preventDefault();
  });

  // Korrektur-Modus
  $('corr-text').addEventListener('input', (e) => {
    const f = currentView();
    if (!f || state.correcting === null) return;
    onSegmentEdited(f, state.correcting, e.target.value);
    renderCorrectOrig(f.result.segments[state.correcting]);
  });
  $('corr-text').addEventListener('keydown', (e) => {
    const f = currentView();
    if (!f || state.correcting === null) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      playSegment(f, state.correcting);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      moveCorrecting(f, +1);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // ein Abschnitt hat keine Zeilenumbrüche
    } else if (e.key === 'Escape') {
      stopPlayback();
    }
  });

  // Suchen und Ersetzen
  $('search-q').addEventListener('input', () => { $('replace-undo').hidden = true; updateSearch(); });
  $('search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('search-r').focus(); } });
  $('search-r').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('replace-all').disabled) { e.preventDefault(); onAction('replace-all'); } });

  $('names').addEventListener('input', (e) => {
    const i = e.target.dataset?.speaker;
    if (i === undefined) return;
    const f = currentView();
    if (!f) return;
    f.names[Number(i)] = e.target.value;
    f.unsaved = true;
    f.modified = true;
    renderUnsaved(f);
    renderTranscript(f);
    renderSubtitles(f, false);
  });
}

// ---------- Start ----------

async function init() {
  if (!browserSupported()) {
    const box = $('unsupported');
    box.hidden = false;
    box.textContent = 'Dieser Browser wird nicht unterstützt. Bitte eine aktuelle Version von Chrome oder Edge verwenden.';
    $('start-btn').disabled = true;
    return;
  }
  bind();
  render();
  state.mode = await detectMode();
  renderModeInfo();
  getWorker();
}

init();
