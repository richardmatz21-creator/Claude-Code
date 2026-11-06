// Oberfläche: Dateien → Umwandeln → Ergebnis.
import {
  SAMPLE_RATE, toSrt, toTxt, toParagraphs, buildCues, speakerTimeline, formatClock, formatSrtTime,
  baseName, speakerName,
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
      f.result = { segments: msg.segments, removed: msg.removed, speakers: msg.speakers };
      f.elapsed = msg.seconds;
      f.names = [];
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
  const undownloaded = doneFiles().some((f) => !f.downloaded);
  if (undownloaded && !confirm('Die bisherigen Ergebnisse werden verworfen. Hast du alles heruntergeladen, was du brauchst?')) return;
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
  if (state.running) { e.preventDefault(); e.returnValue = ''; }
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
  renderTabs();
  renderTranscript(f);
  renderSubtitles(f, true);
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
  $('tab-text').setAttribute('aria-selected', String(text));
  $('tab-subs').setAttribute('aria-selected', String(!text));
  $('tab-text').tabIndex = text ? 0 : -1;
  $('tab-subs').tabIndex = text ? -1 : 0;
  $('panel-text').hidden = !text;
  $('panel-subs').hidden = text;
}

function renderTranscript(f) {
  const opts = viewOpts(f);
  const paras = toParagraphs(f.result.segments, opts);
  $('transcript').innerHTML = paras.length
    ? paras.map((p) => p.label
      ? `<p><span class="who who-label ${spkClass(p.speaker)}">${esc(p.label)}:</span> ${esc(p.text)}</p>`
      : `<p>${esc(p.text)}</p>`).join('')
    : '<p class="empty">Es wurde kein gesprochener Text erkannt. Enthält die Datei Sprache?</p>';
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
    $('timeline').innerHTML = speakerTimeline(f.result.segments).map((t) =>
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
  const cues = buildCues(f.result.segments, { ...opts, labelInText: false });
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

function srtFor(f) { return toSrt(f.result.segments, viewOpts(f)); }
function txtFor(f) { return toTxt(f.result.segments, viewOpts(f)); }

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
      f.downloaded = true;
      break;
    case 'dl-txt':
      if (!f) return;
      downloadBlob(uniqueNames([f], 'txt')[0], new Blob([BOM + txtFor(f)], { type: 'text/plain;charset=utf-8' }));
      f.downloaded = true;
      break;
    case 'dl-zip': {
      const done = doneFiles();
      const entries = {};
      const srtNames = uniqueNames(done, 'srt');
      const txtNames = uniqueNames(done, 'txt');
      done.forEach((d, i) => {
        entries[srtNames[i]] = strToU8(BOM + srtFor(d));
        entries[txtNames[i]] = strToU8(BOM + txtFor(d));
        d.downloaded = true;
      });
      downloadBlob('transkripte.zip', new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' }));
      break;
    }
    case 'copy':
      if (!f) return;
      $('copy-status').textContent = (await copyText(txtFor(f))) ? 'Text kopiert.' : 'Kopieren hat nicht geklappt. Bitte „Text (TXT)“ verwenden.';
      break;
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
    tab.addEventListener('click', () => { state.tab = tab.id === 'tab-text' ? 'text' : 'subs'; renderTabs(); });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      state.tab = state.tab === 'text' ? 'subs' : 'text';
      renderTabs();
      (state.tab === 'text' ? $('tab-text') : $('tab-subs')).focus();
    });
  }

  $('names').addEventListener('input', (e) => {
    const i = e.target.dataset?.speaker;
    if (i === undefined) return;
    const f = currentView();
    if (!f) return;
    f.names[Number(i)] = e.target.value;
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
