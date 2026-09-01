'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// EchoScribe renderer. Two modes:
//   batch      — N files → N transcripts (one each)
//   multitrack — N aligned mic tracks (one speaker each) → one merged script
// Talks to main.js only through window.echoscribe (see preload.js / docs/IPC.md).
// ─────────────────────────────────────────────────────────────────────────────

const api = window.echoscribe;
const $ = (id) => document.getElementById(id);

const state = {
  mode: 'batch',            // 'batch' | 'multitrack'
  queue: [],                // { id, path, name, speaker, status, duration, chunks }
  settings: {},
  running: false,
  starting: false,          // true during the start IPC round-trip (double-run guard)
  runIds: null,             // Set of queue ids submitted in the current run
  lastOutputDir: null,
  models: [],
  _modelPromptDismissed: false,
  _updateToastDismissed: false,
};

let _nextId = 1;
const MAX_TRACKS = 6;

// Brief green flash (+ optional label) so fire-and-forget actions confirm they registered.
function flashOk(btn, label) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.classList.add('flash-ok');
  if (label) btn.textContent = label;
  setTimeout(() => { btn.classList.remove('flash-ok'); if (label) btn.textContent = orig; }, 1300);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  state.settings = await api.getSettings();
  state.lastOutputDir = state.settings.outputDir;
  applySkin(state.settings.skin || 'professional');
  hydrateSidebar();
  hydrateSettingsModal();
  wireEvents();
  renderAll();
  loadModelsStatus();   // show first-launch download nudge if models aren't cached
}

function applySkin(skin) {
  document.documentElement.setAttribute('data-skin', skin);
  document.querySelectorAll('.skin-option').forEach((b) =>
    b.classList.toggle('active', b.dataset.skin === skin));
}

// ---------------------------------------------------------------------------
// Sidebar (run settings you confirm before running)
// ---------------------------------------------------------------------------

function hydrateSidebar() {
  $('model-select').value = state.settings.model || 'mlx-community/whisper-large-v3-turbo';
  $('vocab-hint').value = state.settings.vocabHint || '';
  $('fmt-txt').checked = state.settings.outputTxt !== false;
  $('fmt-ttxt').checked = state.settings.outputTtxt === true;
  $('fmt-srt').checked = state.settings.outputSrt !== false;
  $('script-timestamps').checked = state.settings.scriptTimestamps !== false;

  $('model-select').addEventListener('change', () => api.setSetting('model', $('model-select').value));
  $('vocab-hint').addEventListener('change', () => api.setSetting('vocabHint', $('vocab-hint').value));
  $('fmt-txt').addEventListener('change', () => { api.setSetting('outputTxt', $('fmt-txt').checked); updateRunButton(); });
  $('fmt-ttxt').addEventListener('change', () => { api.setSetting('outputTtxt', $('fmt-ttxt').checked); updateRunButton(); });
  $('fmt-srt').addEventListener('change', () => { api.setSetting('outputSrt', $('fmt-srt').checked); updateRunButton(); });
  $('script-timestamps').addEventListener('change', () => api.setSetting('scriptTimestamps', $('script-timestamps').checked));
  $('session-name-input').addEventListener('input', () => { updateSessionExample(); updateRunButton(); });
}

function updateSessionExample() {
  const base = ($('session-name-input').value.trim() || 'session');
  $('session-example').textContent = `${base}_script.txt`;
}

function renderOutputFolder() {
  const row = $('output-folder-row');
  const dir = state.settings.outputDir;
  row.innerHTML = '';
  const path = document.createElement('div');
  path.className = 'output-folder-path' + (dir ? '' : ' unset');
  path.textContent = dir || 'No folder chosen';
  path.title = dir || '';
  const btn = document.createElement('button');
  btn.className = 'btn-choose-folder';
  btn.textContent = dir ? 'Change' : 'Choose';
  btn.addEventListener('click', chooseFolder);
  row.appendChild(path);
  row.appendChild(btn);
}

async function chooseFolder() {
  const dir = await api.openFolderPicker(state.settings.outputDir);
  if (dir) {
    state.settings.outputDir = dir;
    renderOutputFolder();
    updateRunButton();
  }
}

// ---------------------------------------------------------------------------
// Mode switch
// ---------------------------------------------------------------------------

function setMode(mode) {
  if (state.running) return;
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  const mt = mode === 'multitrack';
  $('session-block').classList.toggle('hidden', !mt);
  $('script-ts-row').classList.toggle('hidden', !mt);
  $('mode-hint').textContent = mt
    ? 'One mic per speaker, recorded together → one merged script.'
    : 'Transcribe files independently — one transcript each.';
  $('dz-label').textContent = mt
    ? `Drop 2–${MAX_TRACKS} aligned mic tracks, then name each speaker`
    : 'Drop audio or video here, or click to browse';
  $('btn-run').textContent = mt ? 'Transcribe session' : 'Transcribe';
  renderQueue();
  updatePlan();
  updateRunButton();
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function addPaths(paths) {
  if (state.running) return;
  $('drop-reject-banner').classList.add('hidden');
  const { files, skipped } = await api.scanPaths(paths);
  let overflow = false;
  for (const p of files) {
    if (state.queue.some((q) => q.path === p)) continue;
    if (state.mode === 'multitrack' && state.queue.length >= MAX_TRACKS) { overflow = true; break; }
    const name = p.split('/').pop();
    const item = { id: _nextId++, path: p, name, speaker: guessSpeaker(name), status: 'queued', duration: null, chunks: null };
    state.queue.push(item);
    probeItem(item);
  }
  const parts = [];
  if (skipped && skipped.length) {
    const names = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? `, +${skipped.length - 3} more` : '');
    parts.push(`Not an audio or video file: ${names}. EchoScribe takes audio and video — mp3, wav, m4a, mp4, mov, and more. Video is fine; the audio is pulled out automatically.`);
  }
  if (overflow) parts.push(`Multitrack takes at most ${MAX_TRACKS} tracks — extra files were not added.`);
  if (parts.length) showDropMessage(parts.join(' '));
  renderQueue();
  updatePlan();
  updateRunButton();
}

function showDropMessage(text) {
  $('drop-reject-text').textContent = text;
  $('drop-reject-banner').classList.remove('hidden');
}

function guessSpeaker(filename) {
  // Reasonable default: filename without extension, cleaned up.
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

async function probeItem(item) {
  const res = await api.probeMedia(item.path, state.settings.chunkLength ?? 300, state.settings.overlap ?? 10);
  if (res && res.ok) {
    item.duration = res.duration;
    item.chunks = res.chunks;
  } else {
    item.status = 'error';
    item.error = res && res.error ? res.error : 'Could not read media';
  }
  renderQueue();
  updatePlan();
  updateRunButton();
}

function removeItem(id) {
  if (state.running) return;
  state.queue = state.queue.filter((q) => q.id !== id);
  renderQueue();
  updatePlan();
  updateRunButton();
}

function fmtDuration(sec) {
  if (sec == null) return '…';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
}

function statusLabel(item) {
  switch (item.status) {
    case 'queued':   return 'Queued';
    case 'active':   return item.pct != null ? `${item.pct}%` : 'Working…';
    case 'done':     return 'Done';
    case 'error':    return 'Error';
    default:         return '';
  }
}

function statusIcon(item) {
  switch (item.status) {
    case 'done':   return '✓';
    case 'error':  return '✕';
    case 'active': return '◐';
    default:       return '♪';
  }
}

function renderQueue() {
  const list = $('queue-list');
  // Preserve focus + caret if a speaker input is being typed into — an async
  // probe resolving mid-typing must not steal the caret and drop keystrokes.
  const active = document.activeElement;
  let focusId = null, caret = null;
  if (active && active.classList && active.classList.contains('speaker-input')) {
    focusId = active.dataset.itemId; caret = active.selectionStart;
  }
  list.innerHTML = '';
  const mt = state.mode === 'multitrack';
  for (const item of state.queue) {
    const el = document.createElement('div');
    el.className = `queue-item state-${item.status}`;
    el.setAttribute('role', 'listitem');

    const icon = document.createElement('div');
    icon.className = 'qi-icon';
    icon.textContent = statusIcon(item);
    el.appendChild(icon);

    if (mt) {
      const spk = document.createElement('input');
      spk.className = 'speaker-input';
      spk.placeholder = 'Speaker name';
      spk.value = item.speaker || '';
      spk.disabled = state.running;
      spk.dataset.itemId = item.id;
      spk.addEventListener('input', () => { item.speaker = spk.value; updateRunButton(); });
      el.appendChild(spk);
    }

    const main = document.createElement('div');
    main.className = 'qi-main';
    const nm = document.createElement('div');
    nm.className = 'qi-name';
    nm.textContent = item.name;
    nm.title = item.path;
    const meta = document.createElement('div');
    meta.className = 'qi-meta';
    if (item.status === 'error') {
      meta.textContent = item.error || 'Error';
    } else if (item.duration == null) {
      meta.textContent = 'Analyzing…';           // animated pulse — clearly working, not stuck
      meta.classList.add('analyzing');
    } else {
      meta.textContent = `${fmtDuration(item.duration)}${item.chunks ? ` · ${item.chunks} chunk${item.chunks > 1 ? 's' : ''}` : ''}`;
    }
    main.appendChild(nm);
    main.appendChild(meta);
    el.appendChild(main);

    if (item.status === 'done' && item.outputs && item.outputs.length) {
      const link = document.createElement('button');
      link.className = 'qi-done-link';
      link.textContent = 'Reveal';
      link.addEventListener('click', () => { api.revealFile(item.outputs[0]); flashOk(link, '✓'); });
      el.appendChild(link);
    } else {
      const st = document.createElement('div');
      st.className = 'qi-status';
      st.textContent = statusLabel(item);
      el.appendChild(st);
    }

    if (!state.running) {
      const rm = document.createElement('button');
      rm.className = 'qi-remove';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.addEventListener('click', () => removeItem(item.id));
      el.appendChild(rm);
    }
    list.appendChild(el);
  }

  if (focusId != null) {
    const again = list.querySelector(`.speaker-input[data-item-id="${focusId}"]`);
    if (again) { again.focus(); if (caret != null) try { again.setSelectionRange(caret, caret); } catch (_) {} }
  }

  const anyDone = state.queue.some((q) => q.status === 'done');
  $('btn-clear-done').classList.toggle('hidden', !anyDone || state.running);
}

// ---------------------------------------------------------------------------
// Plan summary + run-button gating
// ---------------------------------------------------------------------------

function selectedFormats() {
  const f = [];
  if ($('fmt-txt').checked) f.push('txt');
  if ($('fmt-ttxt').checked) f.push('ttxt');
  if ($('fmt-srt').checked) f.push('srt');
  return f;
}

function updatePlan() {
  const el = $('plan-summary');
  if (!state.queue.length) { el.textContent = 'Add files to see the plan.'; return; }
  const totalDur = state.queue.reduce((a, q) => a + (q.duration || 0), 0);
  const totalChunks = state.queue.reduce((a, q) => a + (q.chunks || 0), 0);
  const n = state.queue.length;
  if (state.mode === 'multitrack') {
    el.innerHTML = `<strong>${n}</strong> track${n > 1 ? 's' : ''} · ${fmtDuration(totalDur)} each mic<br>`
      + `Auto-mixer gate → merged script`
      + (n < 2 ? '<br><span class="plan-warn">Need at least 2 tracks.</span>' : '')
      + (n > MAX_TRACKS ? `<br><span class="plan-warn">Max ${MAX_TRACKS} tracks.</span>` : '');
  } else {
    el.innerHTML = `<strong>${n}</strong> file${n > 1 ? 's' : ''} · ${fmtDuration(totalDur)} total`
      + `<br><strong>${totalChunks}</strong> chunk${totalChunks !== 1 ? 's' : ''} to transcribe`;
  }
}

// The single reason Run is currently blocked, or null when ready — surfaced as
// a live hint so a greyed-out button is never a mystery.
function runBlockReason() {
  if (!state.queue.length) return 'Add audio or video files to begin';
  if (!state.queue.some((q) => q.status === 'queued')) return 'Nothing left to transcribe — add more files';
  if (!state.settings.outputDir) return 'Choose an output folder';
  if (selectedFormats().length === 0) return 'Pick an output format (.txt or .srt)';
  if (state.mode === 'multitrack') {
    const queued = state.queue.filter((q) => q.status === 'queued');
    if (queued.length < 2) return 'Multitrack needs at least 2 tracks';
    if (queued.length > MAX_TRACKS) return `Multitrack takes at most ${MAX_TRACKS} tracks`;
    const names = queued.map((q) => (q.speaker || '').trim());
    if (names.some((x) => !x)) return 'Name every speaker';
    if (new Set(names.map((x) => x.toLowerCase())).size !== names.length) return 'Speaker names must be unique';
  }
  return null;
}

function updateRunButton() {
  const btn = $('btn-run');
  const hint = $('run-hint');
  if (state.running) { btn.disabled = false; hint.textContent = ''; hint.classList.remove('ready'); return; }
  if (state.starting) { btn.disabled = true; return; }
  const reason = runBlockReason();
  btn.disabled = !!reason;
  hint.textContent = reason || '';
  hint.classList.remove('ready');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  if (state.running) { api.cancelTranscription(); return; }
  if (state.starting) return;   // guard the IPC round-trip against a double-click

  const formats = selectedFormats().join(',');
  const pending = state.queue.filter((q) => q.status === 'queued');
  if (!pending.length) return;

  const payload = {
    files: pending.map((q) => q.path),
    outputDir: state.settings.outputDir,
    model: $('model-select').value,
    chunkLength: state.settings.chunkLength ?? 300,
    overlap: state.settings.overlap ?? 10,
    vocabHint: $('vocab-hint').value.trim(),
    language: (state.settings.language || '').trim(),
    formats,
  };
  if (state.mode === 'multitrack') {
    payload.multitrack = true;
    payload.speakers = pending.map((q) => q.speaker.trim());
    payload.sessionName = ($('session-name-input').value.trim() || 'session');
    payload.perSpeaker = true;
    payload.scriptTimestamps = $('script-timestamps').checked;
  }

  state.starting = true;
  $('btn-run').disabled = true;
  let res;
  try { res = await api.startTranscription(payload); }
  catch (err) { res = { ok: false, error: err && err.message ? err.message : 'Failed to start' }; }
  finally { state.starting = false; }

  if (!res || !res.ok) { updateRunButton(); showError(res ? res.error : 'Failed to start'); return; }

  state.running = true;
  state.runIds = new Set(pending.map((q) => q.id));   // scope progress % to this run
  pending.forEach((q) => { q.status = 'queued'; q.pct = null; });
  enterRunningUI();
}

let _elapsedTimer = null;
let _runStart = 0;
let _etaAtMs = 0;        // "remaining ms" snapshot taken at _etaSnapTime
let _etaSnapTime = 0;

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Re-estimate remaining time at each progress update: total ≈ elapsed / fraction,
// so remaining ≈ elapsed·(100−pct)/pct. Snapshot it and count down between
// updates so the number falls smoothly instead of jittering. Gated to ≥8% so the
// first estimate (which carries one-time model-load overhead) isn't wildly high.
function noteEtaProgress(pct) {
  if (pct >= 8 && pct < 100) {
    const elapsed = Date.now() - _runStart;
    _etaAtMs = elapsed * (100 - pct) / pct;
    _etaSnapTime = Date.now();
  }
}

function paintElapsed() {
  const elapsed = (Date.now() - _runStart) / 1000;
  let text = `${fmtClock(elapsed)} elapsed`;
  if (_etaSnapTime) {
    const remMs = _etaAtMs - (Date.now() - _etaSnapTime);
    text += remMs > 1500 ? `  ·  ~${fmtClock(remMs / 1000)} left` : '  ·  finishing…';
  }
  $('progress-elapsed').textContent = text;
}

function startElapsed() {
  _runStart = Date.now();
  _etaAtMs = 0; _etaSnapTime = 0;
  paintElapsed();
  clearInterval(_elapsedTimer);
  _elapsedTimer = setInterval(paintElapsed, 1000);
}
function stopElapsed() { clearInterval(_elapsedTimer); _elapsedTimer = null; }

function enterRunningUI() {
  const btn = $('btn-run');
  btn.textContent = 'Cancel';
  btn.classList.add('state-running');
  $('progress-section').classList.add('active');
  $('reveal-banner').classList.add('hidden');
  setProgress(0, 'Starting…', '');
  startElapsed();
  renderQueue();
  updateRunButton();
  document.querySelectorAll('.mode-tab').forEach((t) => t.disabled = true);
}

function exitRunningUI() {
  const btn = $('btn-run');
  state.running = false;
  stopElapsed();
  $('progress-bar-wrap').classList.remove('indeterminate');
  btn.classList.remove('state-running');
  btn.textContent = state.mode === 'multitrack' ? 'Transcribe session' : 'Transcribe';
  document.querySelectorAll('.mode-tab').forEach((t) => t.disabled = false);
  renderQueue();
  updateRunButton();
}

function setProgress(pct, overall, status) {
  const p = Math.max(0, Math.min(100, pct || 0));
  $('progress-bar').style.width = `${p}%`;
  if (state.running) { noteEtaProgress(p); paintElapsed(); }
  // No determinate % yet (model load / first chunk) → indeterminate sweep so the
  // bar never looks frozen.
  $('progress-bar-wrap').classList.toggle('indeterminate', state.running && p <= 0);
  if (overall != null) $('progress-overall-text').textContent = overall;
  if (status != null) $('progress-status-text').textContent = status;
}

// ---------------------------------------------------------------------------
// Backend messages
// ---------------------------------------------------------------------------

function itemForMsg(msg) {
  // Route by the exact input path the backend echoes (unique), so two files
  // with the same basename don't both resolve to the first queue item. Fall
  // back to basename only for older messages without file_path.
  if (msg.file_path) {
    const byPath = state.queue.find((q) => q.path === msg.file_path);
    if (byPath) return byPath;
  }
  return state.queue.find((q) => q.name === msg.file)
      || state.queue.find((q) => q.name.replace(/\.[^.]+$/, '') === msg.file);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'media_info':
      break;
    case 'start': {
      if (msg.multitrack) {
        state.queue.forEach((q) => { q.status = 'active'; });
        setProgress(0, `Transcribing ${msg.tracks} tracks → one script`, '');
      } else {
        const it = itemForMsg(msg);
        if (it) { it.status = 'active'; it.pct = 0; }
        setProgress(overallPct(), `File ${msg.file_index}/${msg.total_files}`, msg.file);
      }
      renderQueue();
      break;
    }
    case 'progress': {
      if (state.mode === 'multitrack') {
        setProgress(msg.percent || 0, 'Transcribing session', msg.message || '');
        const spk = (msg.file || '').trim().toLowerCase();
        state.queue.forEach((q) => { if ((q.speaker || '').trim().toLowerCase() === spk) q.status = 'active'; });
      } else {
        const it = itemForMsg(msg);
        if (it) { it.status = 'active'; it.pct = msg.percent ?? it.pct; }
        setProgress(overallPct(), $('progress-overall-text').textContent, `${msg.file} — ${msg.message || ''}`);
      }
      renderQueue();
      break;
    }
    case 'warn':
      break;
    case 'done': {
      state.lastOutputDir = msg.output_dir || state.lastOutputDir;
      if (msg.multitrack) {
        state.queue.forEach((q) => { q.status = 'done'; q.outputs = msg.outputs; });
      } else {
        const it = itemForMsg(msg);
        if (it) { it.status = 'done'; it.pct = 100; it.outputs = msg.outputs; }
      }
      setProgress(overallPct(), $('progress-overall-text').textContent, `✓ ${msg.file}`);
      renderQueue();
      break;
    }
    case 'error': {
      const it = itemForMsg(msg);
      if (it) { it.status = 'error'; it.error = msg.message; }
      else showError(msg.message);
      renderQueue();
      break;
    }
    case 'batch_done': {
      finishBatch(msg);
      break;
    }
  }
}

function overallPct() {
  // Scope to the items actually submitted this run, so a file that errored
  // (stuck at 0) or leftover done items from a prior batch don't skew the bar.
  const items = state.runIds
    ? state.queue.filter((q) => state.runIds.has(q.id))
    : state.queue;
  if (!items.length) return 0;
  let sum = 0;
  for (const q of items) {
    if (q.status === 'done') sum += 100;
    else if (q.status === 'active') sum += (q.pct || 0);
    else if (q.status === 'error') sum += 100;   // count as resolved, not stuck
  }
  return Math.round(sum / items.length);
}

function finishBatch(msg) {
  state.runIds = null;
  exitRunningUI();
  $('progress-section').classList.remove('active');
  api.notifyJobDone();

  const errors = msg.errors || 0;
  const done = msg.transcribed || 0;
  const banner = $('reveal-banner');
  const text = errors
    ? `${done} done, ${errors} error${errors > 1 ? 's' : ''}. Outputs saved.`
    : (state.mode === 'multitrack' ? 'Session script ready.' : `${done} transcript${done !== 1 ? 's' : ''} ready.`);
  $('reveal-banner-text').textContent = text;
  banner.classList.remove('hidden');

  if (state.settings.autoOpenOnComplete && state.lastOutputDir) {
    api.openFolder(state.lastOutputDir);
  }
}

function showError(m) {
  $('progress-status-text').textContent = `Error: ${m}`;
  $('progress-section').classList.add('active');
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

function hydrateSettingsModal() {
  $('setting-chunk').value = state.settings.chunkLength ?? 300;
  $('setting-overlap').value = state.settings.overlap ?? 10;
  $('setting-language').value = state.settings.language || '';
  $('setting-auto-open').checked = state.settings.autoOpenOnComplete !== false;

  $('setting-chunk').addEventListener('change', () => { state.settings.chunkLength = clampNum($('setting-chunk').value, 30, 1800, 300); api.setSetting('chunkLength', state.settings.chunkLength); reprobeAll(); });
  $('setting-overlap').addEventListener('change', () => { state.settings.overlap = clampNum($('setting-overlap').value, 0, 60, 10); api.setSetting('overlap', state.settings.overlap); reprobeAll(); });
  $('setting-language').addEventListener('change', () => { state.settings.language = $('setting-language').value.trim(); api.setSetting('language', state.settings.language); });
  $('setting-auto-open').addEventListener('change', () => { state.settings.autoOpenOnComplete = $('setting-auto-open').checked; api.setSetting('autoOpenOnComplete', state.settings.autoOpenOnComplete); });
}

function clampNum(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function reprobeAll() {
  if (state.running) return;   // never re-probe (and possibly error-flip) an in-flight item
  state.queue.forEach((item) => { if (item.status !== 'error') probeItem(item); });
}

function openSettings() { $('settings-overlay').classList.remove('hidden'); loadModelsStatus(); }
function closeSettings() { $('settings-overlay').classList.add('hidden'); }

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
}

// ---------------------------------------------------------------------------
// Diagnostics: preflight, updates, log
// ---------------------------------------------------------------------------

function renderPreflight(results) {
  const el = $('preflight-results');
  el.innerHTML = '';
  if (!results) { el.textContent = 'Preflight failed to run.'; return; }
  const labels = { ffmpeg: 'ffmpeg', mlx_whisper: 'mlx-whisper', smoke_test: 'Transcription test', output_folder: 'Output folder', disk_space: 'Disk space', app_version: 'App version' };
  for (const [key, r] of Object.entries(results)) {
    const row = document.createElement('div');
    row.className = 'preflight-check ' + (r.ok ? 'ok' : 'fail');
    row.innerHTML = `<span class="pc-icon">${r.ok ? '✓' : '✕'}</span>`
      + `<span class="pc-name">${labels[key] || key}</span>`
      + `<span class="pc-msg" title="${(r.message || '').replace(/"/g, '&quot;')}">${r.message || ''}</span>`;
    el.appendChild(row);
  }
  $('btn-copy-preflight').style.display = '';
  $('btn-copy-preflight').onclick = () => {
    const text = Object.entries(results).map(([k, r]) => `${r.ok ? 'OK' : 'FAIL'} ${k}: ${r.message}`).join('\n');
    navigator.clipboard.writeText(text);
    flashOk($('btn-copy-preflight'), 'Copied ✓');
  };
}

async function refreshLog() {
  const lines = await api.getLogTail(120);
  $('log-tail').textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Offline models — pre-cache before going somewhere without wifi
// ---------------------------------------------------------------------------

async function loadModelsStatus() {
  const models = await api.getModelsStatus();
  if (!models) return;
  state.models = models;
  renderModelsList();
  maybeShowModelPrompt();
}

function fmtGB(bytes) {
  if (bytes == null) return '';   // 0 should render "0 MB", not an empty ratio
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

function renderModelsList() {
  const el = $('models-list');
  if (!el) return;
  el.innerHTML = '';
  for (const m of (state.models || [])) {
    const cls = m.state || (m.cached ? 'cached' : 'missing');
    const icon = { cached: '✓', missing: '○', downloading: '◐', done: '✓', error: '✕' }[cls] || '○';
    const downloading = cls === 'downloading';
    let stateText = { cached: 'Cached', missing: 'Not downloaded', done: 'Cached', error: 'Failed' }[cls] || '';
    if (downloading) {
      const pct = m.percent != null ? `${m.percent}%` : '…';
      stateText = m.total ? `${pct} · ${fmtGB(m.downloaded)} / ${fmtGB(m.total)}` : pct;
    }
    const row = document.createElement('div');
    row.className = `model-row ${cls === 'done' ? 'cached' : cls}`;
    row.innerHTML = `<span class="mr-icon">${icon}</span><span class="mr-label">${m.label}</span><span class="mr-state">${stateText}</span>`;
    if (downloading) {
      const bar = document.createElement('div');
      bar.className = 'model-bar';
      bar.innerHTML = `<div class="model-bar-fill" style="width:${m.percent || 0}%"></div>`;
      row.appendChild(bar);
    }
    el.appendChild(row);
  }
}

function allModelsCached() {
  return (state.models || []).length > 0 && state.models.every((m) => m.cached || m.state === 'done' || m.state === 'cached');
}

function maybeShowModelPrompt() {
  if (state._modelPromptDismissed) return;
  $('model-prompt-banner').classList.toggle('hidden', allModelsCached());
}

async function startModelDownload() {
  const btn = $('btn-download-models');
  btn.disabled = true;
  $('models-download-status').textContent = 'Downloading… this can take a while for ~4.5 GB. Leave the app open.';
  state.models = (state.models || []).map((m) => m.cached ? m : { ...m, state: 'missing' });
  renderModelsList();
  const res = await api.downloadModels();
  if (!res.ok) { $('models-download-status').textContent = res.error || 'Could not start download.'; btn.disabled = false; }
}

function handleModelsProgress(msg) {
  if (msg.type === 'model_download') {
    const m = (state.models || []).find((x) => x.repo === msg.repo);
    if (m) {
      m.state = msg.state;
      m.percent = msg.percent;
      m.downloaded = msg.downloaded;
      m.total = msg.total;
      if (msg.state === 'done' || msg.state === 'cached') m.cached = true;
      renderModelsList();
    }
    if (msg.state === 'downloading') {
      $('models-download-status').textContent = msg.total
        ? `Downloading ${msg.label} — ${msg.percent}% (${fmtGB(msg.downloaded)} / ${fmtGB(msg.total)})`
        : `Downloading ${msg.label}…`;
    }
    if (msg.state === 'error') $('models-download-status').textContent = `Error: ${msg.message || 'download failed'}`;
  } else if (msg.type === 'models_done') {
    $('btn-download-models').disabled = false;
    $('models-download-status').textContent = allModelsCached() ? 'All models cached — you’re ready for offline use.' : 'Some models did not download. Try again.';
    maybeShowModelPrompt();
  }
}

// ---------------------------------------------------------------------------
// Update UI
// ---------------------------------------------------------------------------

function handleUpdateStatus(p) {
  const line = $('update-status-line');
  const toast = $('update-toast');
  switch (p.state) {
    case 'checking': line.textContent = 'Checking for updates…'; break;
    case 'current':  line.textContent = `You’re on the latest version (v${p.version}).`; break;
    case 'available':
      line.textContent = `Update available: v${p.version}`;
      $('btn-download-update').style.display = '';
      break;
    case 'downloading':
      line.textContent = `Downloading v${p.version}… ${p.percent}%`;
      $('btn-download-update').style.display = 'none';   // superseded by the toast
      if (!state._updateToastDismissed) toast.classList.remove('hidden');   // respect a manual dismiss
      $('update-toast-label').textContent = `Downloading EchoScribe v${p.version}…`;
      $('update-toast-percent').textContent = `${p.percent}%`;
      $('update-toast-fill').style.width = `${p.percent}%`;
      break;
    case 'ready':
      line.textContent = `v${p.version} ready — restart to install.`;
      $('btn-download-update').style.display = 'none';
      $('btn-install-update').style.display = '';
      $('update-toast-label').textContent = `v${p.version} ready.`;
      $('update-toast-percent').textContent = '';
      $('update-toast-action').style.display = '';
      $('update-toast-fill').style.width = '100%';
      state._updateToastDismissed = false;   // "ready" is important enough to re-show
      toast.classList.remove('hidden');
      break;
    case 'error': line.textContent = `Update error: ${p.message}`; break;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  // Mode
  document.querySelectorAll('.mode-tab').forEach((t) =>
    t.addEventListener('click', () => setMode(t.dataset.mode)));

  // Drop zone
  const dz = $('drop-zone');
  dz.addEventListener('click', async () => {
    if (state.running) return;
    const files = await api.openFilePicker();
    if (files.length) addPaths(files);
  });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    e.stopPropagation();   // don't let the window-wide handler double-process
    const paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    if (paths.length) addPaths(paths);
  });
  // Window-wide drop (so dropping anywhere works)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.running) return;
    const paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    if (paths.length) addPaths(paths);
  });

  $('btn-browse').addEventListener('click', async (e) => { e.stopPropagation(); const files = await api.openFilePicker(); if (files.length) addPaths(files); });
  $('btn-run').addEventListener('click', run);
  $('btn-clear-done').addEventListener('click', () => { state.queue = state.queue.filter((q) => q.status !== 'done'); renderQueue(); updatePlan(); updateRunButton(); });

  $('btn-drop-reject-dismiss').addEventListener('click', () => $('drop-reject-banner').classList.add('hidden'));
  $('btn-reveal-output').addEventListener('click', (e) => { if (state.lastOutputDir) api.openFolder(state.lastOutputDir); flashOk(e.currentTarget); });
  $('btn-reveal-dismiss').addEventListener('click', () => $('reveal-banner').classList.add('hidden'));

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-close').addEventListener('click', closeSettings);
  $('btn-settings-done').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', (e) => { if (e.target === $('settings-overlay')) closeSettings(); });
  document.querySelectorAll('.settings-tab').forEach((t) => t.addEventListener('click', () => switchSettingsTab(t.dataset.tab)));
  document.querySelectorAll('.skin-option').forEach((b) => b.addEventListener('click', () => { applySkin(b.dataset.skin); api.setSetting('skin', b.dataset.skin); state.settings.skin = b.dataset.skin; }));

  // Offline models
  $('btn-download-models').addEventListener('click', startModelDownload);
  $('btn-model-prompt-download').addEventListener('click', () => { openSettings(); switchSettingsTab('diagnostics'); startModelDownload(); });
  $('btn-model-prompt-dismiss').addEventListener('click', () => { state._modelPromptDismissed = true; $('model-prompt-banner').classList.add('hidden'); });
  api.onModelsProgress(handleModelsProgress);

  // Diagnostics
  $('btn-run-preflight').addEventListener('click', () => { $('preflight-results').textContent = 'Running…'; api.runPreflight(); });
  $('btn-open-log-file').addEventListener('click', () => api.openLogFile());
  $('btn-refresh-log').addEventListener('click', refreshLog);
  $('btn-check-update').addEventListener('click', () => api.checkForUpdates());
  $('btn-download-update').addEventListener('click', () => api.downloadUpdate());
  $('btn-install-update').addEventListener('click', () => api.installUpdate());
  $('update-toast-action').addEventListener('click', () => api.installUpdate());
  $('update-toast-dismiss').addEventListener('click', () => { state._updateToastDismissed = true; $('update-toast').classList.add('hidden'); });

  // Esc closes settings
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  // Backend subscriptions
  api.onTranscriptionMessage(handleMessage);
  api.onTranscriptionExit((p) => {
    // If a normal batch_done already reset the UI, state.running is false and
    // we do nothing. Otherwise the job ended without batch_done (cancel, or a
    // clean/error exit) — treat the exit as terminal so the UI can never stay
    // stuck on "Cancel" requiring a relaunch.
    if (!state.running) return;
    if (p.cancelled) $('progress-status-text').textContent = 'Cancelled.';
    else if (p.code !== 0) showError(`Backend exited (code ${p.code}).`);
    state.runIds = null;
    exitRunningUI();
    $('progress-section').classList.remove('active');
    api.notifyJobDone();
  });
  api.onTranscriptionSpawnError((p) => { showError(`Could not start backend: ${p.message}`); exitRunningUI(); api.notifyJobDone(); });
  api.onPreflightResult((p) => renderPreflight(p.results));
  api.onUpdateStatus(handleUpdateStatus);
}

function renderAll() {
  renderOutputFolder();
  renderQueue();
  updatePlan();
  updateSessionExample();
  updateRunButton();
}

boot();
