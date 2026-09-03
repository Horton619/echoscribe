'use strict';
// EchoScribe — Review & Polish window.
// Loads a review doc (per-word text + timing + confidence), runs a deterministic
// corrections + filler sweep (Mad Max unattended, or step-by-step verify), shows
// every change inline as struck-original → replacement (click to undo / edit),
// colours by confidence / fillers, then re-exports via the backend and writes a
// change log + tally.

const api = window.echoscribe;
const $ = (id) => document.getElementById(id);
let playClickTimer = null, curPlaySpan = null;
const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');

const state = {
  docPath: null,
  meta: null,
  words: [],   // {i, lead, text, s, e, p, pb, orig, removed, changed, hidden, struck, modKind, group}
  mode: 'stepwise',
  cfg: { corrections: [], fillerWords: [], fillerRemove: false, confidenceThreshold: 0.5, polishMode: 'stepwise' },
  suggestions: [],
  stepIdx: 0,
};

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const leadWS = (s) => (s.match(/^\s*/) || [''])[0];
const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtT = (t) => { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const isCap = (s) => /^\s*[A-Z]/.test(s);

// ---- phonetic "sounds-alike" polish -----------------------------------------
// A light metaphone-style key + edit distance. Whisper mangles a rare proper
// noun several ways in one file (Fent / Fenn / Fendt); these collapse the
// variants toward a canonical spelling — the vocab hint's spelling when one
// matches (safe enough for Mad Max), else the dominant capitalised variant
// (step-only, since there's no ground truth).
function editDist(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = d[0]; d[0] = j;
    for (let i = 1; i <= m; i++) { const tmp = d[i]; d[i] = Math.min(d[i] + 1, d[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return d[m];
}
function phonKey(s) {
  s = (s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/dt/g, 't').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/gh/g, '').replace(/^kn/, 'n').replace(/^wr/, 'r');
  const first = s[0];
  let rest = s.slice(1).replace(/[aeiouhwy]/g, '').replace(/([a-z])\1+/g, '$1');
  rest = rest.replace(/[sz]/g, 's').replace(/[ckq]/g, 'k').replace(/[dt]/g, 't').replace(/[bpv]/g, 'p').replace(/[gj]/g, 'j').replace(/([a-z])\1+/g, '$1');
  return first + rest;
}
const maxDist = (t) => (t.length <= 4 ? 1 : t.length <= 7 ? 2 : 3);
function closeMatch(w, t) {   // normalized strings
  if (!w || !t || w === t || w[0] !== t[0]) return false;
  if (phonKey(w) === phonKey(t)) return true;
  return editDist(w, t) <= maxDist(t);
}
// "strong" = safe enough to auto-apply in Mad Max: same phonetic key AND a tiny
// edit distance. Same-key-but-far pairs (Houston/Hesston, edit distance 2) are
// only step-reviewable, never auto-corrected.
const strongMatch = (w, t) => phonKey(w) === phonKey(t) && editDist(w, t) <= (t.length >= 8 ? 2 : 1);
function parseAnchors(vocab) {
  const terms = new Set();
  (vocab || '').split(/[,.;:()]/).forEach((seg) => {
    (seg.match(/\b[A-Z][A-Za-z0-9|]+(?:\s+[A-Z][A-Za-z0-9|]+)*/g) || []).forEach((c) => { if (norm(c).length >= 4) terms.add(c.trim()); });
  });
  return [...terms];
}

// ---------------------------------------------------------------- load
async function boot() {
  bindUI();
  const cfg = await api.getSettings();
  state.cfg = {
    corrections: cfg.corrections || [],
    fillerWords: cfg.fillerWords || [],
    fillerRemove: !!cfg.fillerRemove,
    confidenceThreshold: cfg.confidenceThreshold ?? 0.5,
    polishMode: cfg.polishMode || 'stepwise',
  };
  setMode(state.cfg.polishMode);
  $('conf-threshold').value = state.cfg.confidenceThreshold;
  const p = await api.review.pending();
  if (p) await loadDoc(p);
  api.review.onOpenDoc((docPath) => loadDoc(docPath));
}

async function loadDoc(docPath) {
  if (isDirty() && !(await styledConfirm('Discard unsaved edits and open the new transcript?', 'Discard & open'))) return;
  const res = await api.review.load(docPath);
  if (!res.ok) { setStatus(`Could not open transcript: ${res.error}`, true); return; }
  state.docPath = res.path;
  state.meta = res.doc.meta || {};
  state.words = (res.doc.words || []).map((w, i) => ({
    i, lead: leadWS(w.w), text: w.w, s: w.s, e: w.e, p: w.p ?? 1, pb: !!w.pb,
    orig: w.w, removed: false, changed: false, hidden: false, struck: '', modKind: '', group: null,
  }));
  state.suggestions = [];
  $('review-docname').textContent = state.meta.source || state.meta.base || '(transcript)';
  setupAudio();
  showPanel('idle');
  $('btn-save').disabled = true;
  $('btn-revert').hidden = true;
  search.q = ''; if ($('search-input')) { $('search-input').value = ''; $('search-count').textContent = ''; }
  render();
  setStatus(`${state.words.length} words loaded.`);
}

const isDirty = () => state.words.some((w) => w.changed || w.removed);

// ---------------------------------------------------------------- render
function confBucket(p) { return p >= 0.85 ? 'hi' : p >= 0.6 ? 'mid' : 'lo'; }
function fillerSet() { return new Set(state.cfg.fillerWords.map(norm).filter(Boolean)); }

function render() {
  const wrap = $('transcript');
  wrap.innerHTML = '';
  closeMenu();
  closeSelMenu();
  curPlaySpan = null;   // spans are rebuilt; the play-highlight re-attaches on next timeupdate
  const fset = fillerSet();
  const thr = parseFloat($('conf-threshold').value) || 0;
  let para = document.createElement('p');
  para.className = 'para';
  for (const w of state.words) {
    if (w.pb && para.childNodes.length) { wrap.appendChild(para); para = document.createElement('p'); para.className = 'para'; }
    if (w.hidden) continue;
    para.appendChild(buildWord(w, fset, thr));
  }
  if (para.childNodes.length) wrap.appendChild(para);
  renderLowConf();
  if (search.q) applySearchHighlights();
}

function buildWord(w, fset, thr) {
  const sp = document.createElement('span');
  sp.dataset.i = w.i;
  if (w.changed) {
    sp.className = 'wd wd-mod';
    sp.title = 'click to undo or edit';
    sp.innerHTML = `${esc(w.lead)}<s class="wd-old">${esc(w.struck || w.orig.trim())}</s> <span class="wd-new">${esc(w.text.trim())}</span>`;
    sp.addEventListener('click', (e) => showMenu(e.currentTarget, w.i));
  } else if (w.removed) {
    sp.className = 'wd wd-mod wd-removed';
    sp.title = 'click to undo or edit';
    sp.innerHTML = `${esc(w.lead)}<s class="wd-old">${esc(w.orig.trim())}</s>`;
    sp.addEventListener('click', (e) => showMenu(e.currentTarget, w.i));
  } else {
    sp.className = 'wd ' + `cf-${confBucket(w.p)}` + (w.p < thr ? ' cf-flag' : '') + (fset.has(norm(w.text)) ? ' wd-filler' : '');
    sp.textContent = w.text;
    sp.title = `${(w.p * 100).toFixed(0)}% · ${fmtT(w.s)} — click to play, double-click to edit`;
    sp.addEventListener('click', () => schedulePlay(w.s));
    sp.addEventListener('dblclick', () => { clearTimeout(playClickTimer); editWord(w.i); });
  }
  return sp;
}

// ---------------------------------------------------------------- mutations
function applyCorrection(w, newCore, struck, kind) {
  w.struck = struck; w.text = w.lead + newCore; w.changed = true; w.removed = false; w.modKind = kind;
}
function applyRemove(w, kind) { w.removed = true; w.changed = false; w.modKind = kind; }

function undo(i) {
  const w = state.words[i];
  if (w.group) w.group.forEach((j) => { state.words[j].removed = false; state.words[j].hidden = false; });
  w.text = w.orig; w.changed = false; w.removed = false; w.hidden = false; w.struck = ''; w.modKind = ''; w.group = null;
  render(); refreshDirty();
}
function editWord(i, onDone) {
  const span = document.querySelector(`.wd[data-i="${i}"]`);
  const w = state.words[i];
  if (!span) { if (onDone) onDone(); return; }
  scrollToWord(i);
  const cur = (w.changed ? w.text : w.orig).trim();
  const input = document.createElement('input');
  input.className = 'wd-edit';
  input.value = cur;
  input.style.width = `${Math.max(3, cur.length + 1)}ch`;
  span.replaceWith(input);
  input.focus(); input.select();
  let settled = false;
  const finish = (commit) => {
    if (settled) return; settled = true;
    const next = input.value.trim();
    if (commit && next === w.orig.trim()) undo(i);
    else if (commit && next && next !== cur) { applyCorrection(w, next, w.orig.trim(), 'edit'); render(); refreshDirty(); }
    else render();
    if (onDone) onDone();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function styledConfirm(message, okLabel) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'lists-overlay';
    ov.innerHTML = `<div class="confirm-panel"><div class="confirm-msg"></div><div class="confirm-actions"><button class="btn-review-secondary" data-a="no">Cancel</button><button class="btn-review-primary" data-a="yes"></button></div></div>`;
    ov.querySelector('.confirm-msg').textContent = message;
    ov.querySelector('[data-a="yes"]').textContent = okLabel || 'OK';
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } else if (e.key === 'Enter') { close(true); } };
    document.addEventListener('keydown', onKey, true);
    ov.querySelector('[data-a="no"]').onclick = () => close(false);
    ov.querySelector('[data-a="yes"]').onclick = () => close(true);
    ov.querySelector('[data-a="yes"]').focus();
  });
}

// ---------------------------------------------------------------- sweep
function tokensNorm() { return state.words.map((w) => (w.removed || w.hidden ? '' : norm(w.text))); }
function matchAt(toks, i, phrase) {
  let j = i, k = 0; const idxs = [];
  while (k < phrase.length && j < toks.length) {
    if (toks[j] === '') { j++; continue; }
    if (toks[j] !== phrase[k]) return null;
    idxs.push(j); j++; k++;
  }
  return k === phrase.length ? idxs : null;
}

function computeSuggestions() {
  const toks = tokensNorm();
  const out = []; const claimed = new Set(); const phrases = [];
  for (const [from, to] of state.cfg.corrections) {
    const pt = from.trim().split(/\s+/).map(norm).filter(Boolean);
    if (pt.length) phrases.push({ pt, to: to.trim(), kind: 'correction' });
  }
  if (state.cfg.fillerRemove) {
    for (const f of state.cfg.fillerWords) {
      const pt = f.trim().split(/\s+/).map(norm).filter(Boolean);
      if (pt.length) phrases.push({ pt, to: null, kind: 'filler' });
    }
  }
  phrases.sort((a, b) => b.pt.length - a.pt.length);   // longer phrases win
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i] || claimed.has(i)) continue;
    for (const ph of phrases) {
      const idxs = matchAt(toks, i, ph.pt);
      if (idxs && !idxs.some((x) => claimed.has(x))) {
        idxs.forEach((x) => claimed.add(x));
        out.push({ ...ph, idxs, before: idxs.map((x) => state.words[x].text.trim()).join(' ') });
        break;
      }
    }
  }
  computePhonetic(toks, claimed, out);
  if ($('tg-conf-check').checked) {
    const thr = parseFloat($('conf-threshold').value) || 0;
    for (let i = 0; i < state.words.length; i++) {
      const w = state.words[i];
      if (!w.removed && !w.hidden && w.p < thr && !claimed.has(i)) out.push({ kind: 'confidence', idxs: [i], before: w.text.trim(), to: null });
    }
  }
  return out.sort((a, b) => a.idxs[0] - b.idxs[0]);
}

function computePhonetic(toks, claimed, out) {
  const anchorList = parseAnchors(state.meta.vocab);
  // 1. Hint-anchored fuzzy: correct variants toward a vocab-hint spelling.
  const anchors = anchorList.map((a) => ({ raw: a, toks: a.split(/\s+/).map(norm).filter(Boolean) }))
    .filter((a) => a.toks.join('').length >= 4).sort((a, b) => b.toks.length - a.toks.length);
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i] || claimed.has(i)) continue;
    for (const anc of anchors) {
      const win = []; let j = i;
      while (win.length < anc.toks.length && j < toks.length) { if (toks[j]) win.push(j); j++; }
      if (win.length < anc.toks.length || win.some((x) => claimed.has(x))) continue;
      // Anchors are proper nouns — only match a capitalised span, so a lowercase
      // common word can't be pulled toward an anchor.
      if (!isCap(state.words[win[0]].text)) continue;
      const wjoin = win.map((x) => toks[x]).join(''); const tjoin = anc.toks.join('');
      if (closeMatch(wjoin, tjoin)) {
        win.forEach((x) => claimed.add(x));
        out.push({ kind: 'phonetic', anchored: true, strong: strongMatch(wjoin, tjoin), idxs: win, to: anc.raw, before: win.map((x) => state.words[x].text.trim()).join(' ') });
        break;
      }
    }
  }
  // 2. Capitalised-token clustering: collapse differently-spelled proper-noun
  //    variants toward a canonical (a hint spelling if present, else longest /
  //    most frequent). Unanchored picks are step-only.
  const anchorNorm = new Set(anchorList.map(norm));
  const groups = {};
  for (let i = 0; i < state.words.length; i++) {
    const w = state.words[i];
    if (!toks[i] || claimed.has(i) || w.removed || w.hidden || !isCap(w.text)) continue;
    const k = phonKey(toks[i]);
    // >=3 skips short grammar-word skeletons (This/Thus/There) that would
    // otherwise cluster; real proper nouns (Fendt→fnt, Hesston→hstn) survive.
    if (k.length >= 3) (groups[k] = groups[k] || []).push(i);
  }
  for (const k in groups) {
    const idxs = groups[k]; const spell = {};
    idxs.forEach((i) => { const c = state.words[i].text.trim(); spell[c] = (spell[c] || 0) + 1; });
    const variants = Object.keys(spell);
    if (variants.length < 2) continue;
    let canon = variants.find((v) => anchorNorm.has(norm(v)));
    const anchored = !!canon;
    if (!canon) canon = variants.sort((a, b) => (b.length - a.length) || (spell[b] - spell[a]))[0];
    for (const i of idxs) {
      if (claimed.has(i) || norm(state.words[i].text) === norm(canon)) continue;
      claimed.add(i);
      out.push({ kind: 'phonetic', anchored, strong: true, idxs: [i], to: canon, before: state.words[i].text.trim() });
    }
  }
}

function applySuggestion(sug) {
  if (sug.kind === 'correction' || sug.kind === 'phonetic') {
    const first = state.words[sug.idxs[0]];
    applyCorrection(first, sug.to, sug.before, sug.kind);
    first.group = sug.idxs.slice(1);
    for (let k = 1; k < sug.idxs.length; k++) { const t = state.words[sug.idxs[k]]; t.removed = true; t.hidden = true; }
  } else if (sug.kind === 'filler') {
    sug.idxs.forEach((x) => applyRemove(state.words[x], 'filler'));
  }
}
const madmaxApplies = (sug) => sug.kind === 'correction' || sug.kind === 'filler' || (sug.kind === 'phonetic' && sug.anchored && sug.strong);

function runSweep() {
  state.suggestions = computeSuggestions();
  if (!state.suggestions.length) { setStatus('Nothing to change — no matches for your lists.'); showPanel('idle'); return; }
  if (state.mode === 'madmax') {
    let held = 0;
    for (const sug of state.suggestions) { if (madmaxApplies(sug)) applySuggestion(sug); else if (sug.kind === 'phonetic') held++; }
    render(); refreshDirty();
    const nc = computeChanges().length;
    const heldMsg = held ? ` ${held} uncertain sounds-alike suggestion${held === 1 ? '' : 's'} held — switch to Step-by-step and Run sweep to review.` : '';
    showSummary(`Mad Max applied ${nc} change${nc === 1 ? '' : 's'}. Skim the transcript — click any change to undo or edit.${heldMsg}`);
  } else {
    state.stepIdx = 0; showStep();
  }
}

// ---------------------------------------------------------------- step-by-step
function showStep() {
  showPanel('step');
  const panel = $('panel-step');
  if (state.stepIdx >= state.suggestions.length) { showSummary('Reviewed every suggestion. Click any change in the transcript to undo or edit.'); return; }
  const sug = state.suggestions[state.stepIdx];
  scrollToWord(sug.idxs[0]);
  const kindLabel = { correction: 'Correction', filler: 'Filler word', confidence: 'Low confidence',
    phonetic: sug.anchored ? 'Sounds-alike (hint)' : 'Sounds-alike' }[sug.kind];
  const action = (sug.kind === 'correction' || sug.kind === 'phonetic')
    ? `<div class="step-change"><span class="step-before">${esc(sug.before)}</span><span class="step-arrow">→</span><span class="step-after">${esc(sug.to)}</span></div>`
    : sug.kind === 'filler'
      ? `<div class="step-change"><span class="step-before">${esc(sug.before)}</span><span class="step-arrow">→</span><span class="step-after step-removed">remove</span></div>`
      : `<div class="step-change"><span class="step-before">${esc(sug.before)}</span> <span class="step-note">${Math.round(state.words[sug.idxs[0]].p * 100)}% — check it</span></div>`;
  panel.innerHTML = `
    <div class="step-count">${state.stepIdx + 1} / ${state.suggestions.length}</div>
    <div class="step-kind step-kind-${sug.kind}">${kindLabel}</div>
    ${action}
    <div class="step-context">${contextHtml(sug)}</div>
    <div class="step-actions">
      ${sug.kind === 'confidence'
        ? `<button class="btn-review-secondary" id="step-edit">Edit…</button><button class="btn-review-primary" id="step-ok">Looks fine</button>`
        : `<button class="btn-review-secondary" id="step-no">No, skip</button><button class="btn-review-primary" id="step-yes">Yes, apply</button>`}
      <button class="btn-review-ghost" id="step-yesall">Apply all like this</button>
    </div>`;
  const next = () => { state.stepIdx++; showStep(); };
  if ($('step-yes')) $('step-yes').onclick = () => { applySuggestion(sug); render(); refreshDirty(); next(); };
  if ($('step-no')) $('step-no').onclick = next;
  if ($('step-ok')) $('step-ok').onclick = next;
  if ($('step-edit')) $('step-edit').onclick = () => editWord(sug.idxs[0], next);
  $('step-yesall').onclick = () => {
    for (let k = state.stepIdx; k < state.suggestions.length; k++) if (state.suggestions[k].kind === sug.kind && sug.kind !== 'confidence') applySuggestion(state.suggestions[k]);
    render(); refreshDirty(); showSummary(`Applied all ${sug.kind} suggestions. Click any change to undo or edit.`);
  };
}

function contextHtml(sug) {
  const a = Math.max(0, sug.idxs[0] - 6), b = Math.min(state.words.length, sug.idxs[sug.idxs.length - 1] + 7);
  const hit = new Set(sug.idxs); let html = '';
  for (let k = a; k < b; k++) {
    const w = state.words[k];
    if (w.hidden || (w.removed && !hit.has(k))) continue;
    html += hit.has(k) ? `<mark>${esc(w.text)}</mark>` : esc(w.text);
  }
  return html;
}
function scrollToWord(i) {
  const el = document.querySelector(`.wd[data-i="${i}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function jumpToWord(i, play) {
  scrollToWord(i);
  const el = document.querySelector(`.wd[data-i="${i}"]`);
  if (el) { el.classList.remove('wd-flash'); void el.offsetWidth; el.classList.add('wd-flash'); }
  if (play) playFrom(state.words[i].s);
}

// ---------------------------------------------------------------- low-confidence triage
function renderLowConf() {
  const el = $('lowconf-list');
  if (!el) return;
  const cand = state.words.filter((w) => !w.removed && !w.hidden && !w.changed && w.p < 0.75)
    .sort((a, b) => a.p - b.p).slice(0, 25);
  if (!cand.length) { el.innerHTML = '<li class="lowconf-empty">Nothing shaky — every word is high-confidence.</li>'; return; }
  el.innerHTML = '';
  for (const w of cand) {
    const li = document.createElement('li');
    const ctx = state.words.slice(Math.max(0, w.i - 2), w.i).map((x) => x.text).join('').trim();
    li.innerHTML = `<span class="lowconf-pct">${Math.round(w.p * 100)}%</span><span class="lowconf-word"></span><span class="lowconf-ctx"></span>`;
    li.querySelector('.lowconf-word').textContent = w.text.trim();
    li.querySelector('.lowconf-ctx').textContent = ctx ? `…${ctx}` : '';
    li.title = `${fmtT(w.s)} — click to jump and hear it`;
    li.onclick = () => jumpToWord(w.i, true);
    el.appendChild(li);
  }
}

// ---------------------------------------------------------------- transcript search
const search = { q: '', matches: [], idx: 0 };
function computeMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const toks = q.split(/\s+/);
  const out = [];
  for (let i = 0; i < state.words.length; i++) {
    if (state.words[i].hidden) continue;
    let j = i, k = 0; const idxs = [];
    while (k < toks.length && j < state.words.length) {
      if (state.words[j].hidden) { j++; continue; }
      if (!state.words[j].text.toLowerCase().includes(toks[k])) break;
      idxs.push(j); j++; k++;
    }
    if (k === toks.length) out.push(idxs);
  }
  return out;
}
function applySearchHighlights() {
  document.querySelectorAll('.wd-match, .wd-match-current').forEach((e) => e.classList.remove('wd-match', 'wd-match-current'));
  search.matches.forEach((m, mi) => m.forEach((wi) => {
    const el = document.querySelector(`.wd[data-i="${wi}"]`);
    if (el) el.classList.add(mi === search.idx ? 'wd-match-current' : 'wd-match');
  }));
}
function doSearch(q) {
  search.q = q;
  search.matches = computeMatches(q);
  search.idx = 0;
  $('search-count').textContent = q.trim() ? (search.matches.length ? `1/${search.matches.length}` : '0') : '';
  applySearchHighlights();
  if (search.matches.length) scrollToWord(search.matches[0][0]);
}
function gotoMatch(delta) {
  if (!search.matches.length) return;
  search.idx = (search.idx + delta + search.matches.length) % search.matches.length;
  $('search-count').textContent = `${search.idx + 1}/${search.matches.length}`;
  applySearchHighlights();
  scrollToWord(search.matches[search.idx][0]);
}

// ---------------------------------------------------------------- change list, summary, save
function computeChanges() {
  const out = [];
  for (const w of state.words) {
    if (w.hidden) continue;
    if (w.changed) out.push({ kind: w.modKind, before: (w.struck || w.orig).trim(), after: w.text.trim(), t: w.s });
    else if (w.removed) out.push({ kind: w.modKind || 'remove', before: w.orig.trim(), after: '∅', t: w.s });
  }
  return out;
}

function showSummary(headline) {
  showPanel('summary');
  const changes = computeChanges();
  const tally = {};
  for (const c of changes) { const key = `${c.before} → ${c.after}`; tally[key] = (tally[key] || 0) + 1; }
  const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join('');
  $('panel-summary').innerHTML = `
    <div class="summary-headline">${esc(headline)}</div>
    <div class="summary-count">${changes.length} change${changes.length === 1 ? '' : 's'} staged</div>
    ${rows ? `<table class="summary-tally"><thead><tr><th>Change</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="summary-empty">No changes staged.</p>'}
    <p class="summary-hint"><strong>Save &amp; export</strong> writes the cleaned files and a polish log.</p>`;
  $('btn-revert').hidden = changes.length === 0;
}

async function save() {
  $('btn-save').disabled = true; setStatus('Exporting…');
  const editedDoc = { meta: state.meta, words: state.words.filter((w) => !w.removed && !w.hidden).map((w) => ({ w: w.text, s: w.s, e: w.e, p: w.p, pb: w.pb })) };
  const res = await api.review.reexport(editedDoc);
  if (!res.ok) { setStatus(`Export failed: ${res.error}`, true); $('btn-save').disabled = false; return; }
  await api.review.writeLog(state.meta.output_dir, state.meta.base || 'transcript', buildLog());
  setStatus(`Saved ${res.outputs.length} file${res.outputs.length === 1 ? '' : 's'} + polish log.`);
  if (res.outputs[0]) api.revealFile(res.outputs[0]);
  $('btn-save').disabled = false;
}

function buildLog() {
  const changes = computeChanges();
  const lines = [
    `EchoScribe polish log — ${state.meta.source || state.meta.base}`,
    `Generated ${new Date().toISOString()}   ·   mode: ${state.mode}`,
    `Vocabulary hint: ${state.meta.vocab || '(none)'}`,
    '='.repeat(60), '', `CHANGES (${changes.length})`,
  ];
  for (const c of changes) lines.push(`  [${fmtT(c.t)}] ${String(c.kind).padEnd(11)} ${c.before}  →  ${c.after}`);
  const tally = {};
  for (const c of changes) { const key = `${c.before} → ${c.after}`; if (!tally[key]) tally[key] = { n: 0, kind: c.kind }; tally[key].n++; }
  lines.push('', 'TALLY (most common — use these to tune your vocabulary hint)');
  Object.entries(tally).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => lines.push(`  ${String(v.n).padStart(3)}×  [${v.kind}]  ${k}`));
  lines.push('');
  return lines.join('\n');
}

function revertAll() {
  for (const w of state.words) { w.text = w.orig; w.removed = false; w.changed = false; w.hidden = false; w.struck = ''; w.modKind = ''; w.group = null; }
  render(); showPanel('idle'); $('btn-revert').hidden = true; setStatus('Reverted to the original transcript.');
}
function refreshDirty() { const d = isDirty(); $('btn-revert').hidden = !d; $('btn-save').disabled = !d; }

// ---------------------------------------------------------------- inline undo/edit menu
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(spanEl, i) {
  closeMenu();
  const r = spanEl.getBoundingClientRect();
  menuEl = document.createElement('div');
  menuEl.className = 'mod-menu';
  const playBtn = state.meta.source_path ? '<button data-a="play">▶ Play</button>' : '';
  menuEl.innerHTML = `${playBtn}<button data-a="undo">Undo</button><button data-a="edit">Edit…</button>`;
  document.body.appendChild(menuEl);
  menuEl.style.left = `${Math.min(r.left, window.innerWidth - 160)}px`;
  menuEl.style.top = `${r.bottom + 4}px`;
  if (state.meta.source_path) menuEl.querySelector('[data-a="play"]').onclick = (e) => { e.stopPropagation(); closeMenu(); playFrom(state.words[i].s); };
  menuEl.querySelector('[data-a="undo"]').onclick = (e) => { e.stopPropagation(); closeMenu(); undo(i); };
  menuEl.querySelector('[data-a="edit"]').onclick = (e) => { e.stopPropagation(); closeMenu(); editWord(i); };
}
document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target) && !e.target.classList.contains('wd-mod') && !e.target.closest('.wd-mod')) closeMenu(); });

// ------------------------------------------------- multi-word selection edit
// Select a span of words → a Replace / Delete toolbar. Fixes a garbled stretch
// (e.g. a Whisper alignment collapse) that single-word editing can't.
let selMenu = null;
function closeSelMenu() { if (selMenu) { selMenu.remove(); selMenu = null; } }
function wordIdxOf(node) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const wd = el && el.closest && el.closest('.wd');
  return wd && wd.dataset.i !== undefined ? +wd.dataset.i : null;
}
function onTranscriptSelect() {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { closeSelMenu(); return; }
    const range = sel.getRangeAt(0);
    if (!$('transcript').contains(range.commonAncestorContainer)) { closeSelMenu(); return; }
    let i = wordIdxOf(range.startContainer), j = wordIdxOf(range.endContainer);
    if (i === null || j === null) { closeSelMenu(); return; }
    if (i > j) { const t = i; i = j; j = t; }
    if (i === j) { closeSelMenu(); return; }   // single word → double-click edit handles it
    showSelMenu(range.getBoundingClientRect(), i, j);
  }, 10);
}
function showSelMenu(rect, i, j) {
  closeSelMenu();
  selMenu = document.createElement('div');
  selMenu.className = 'mod-menu';
  const playBtn = state.meta.source_path ? '<button data-a="play">▶ Play</button>' : '';
  selMenu.innerHTML = `${playBtn}<button data-a="replace">Replace…</button><button data-a="delete">Delete</button>`;
  document.body.appendChild(selMenu);
  selMenu.style.left = `${Math.min(Math.max(4, rect.left), window.innerWidth - 220)}px`;
  selMenu.style.top = `${rect.bottom + 6}px`;
  if (playBtn) selMenu.querySelector('[data-a="play"]').onclick = (e) => { e.stopPropagation(); closeSelMenu(); playFrom(state.words[i].s); };
  selMenu.querySelector('[data-a="replace"]').onclick = (e) => { e.stopPropagation(); closeSelMenu(); editRange(i, j); };
  selMenu.querySelector('[data-a="delete"]').onclick = (e) => { e.stopPropagation(); closeSelMenu(); deleteRange(i, j); };
}
const rangeText = (i, j) => state.words.slice(i, j + 1).filter((w) => !w.hidden).map((w) => w.text).join('').trim();
function editRange(i, j) {
  const first = state.words[i];
  const orig = rangeText(i, j);
  const span = document.querySelector(`.wd[data-i="${i}"]`);
  if (!span) return;
  const input = document.createElement('input');
  input.className = 'wd-edit'; input.value = orig;
  input.style.width = `${Math.min(60, Math.max(6, orig.length + 1))}ch`;
  span.replaceWith(input); input.focus(); input.select();
  let settled = false;
  const finish = (commit) => {
    if (settled) return; settled = true;
    const next = input.value.trim();
    if (commit && next) {
      applyCorrection(first, next, orig, 'edit');
      first.group = [];
      for (let k = i + 1; k <= j; k++) { const w = state.words[k]; w.removed = true; w.hidden = true; first.group.push(k); }
    }
    render(); refreshDirty();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
function deleteRange(i, j) { for (let k = i; k <= j; k++) applyRemove(state.words[k], 'remove'); render(); refreshDirty(); }
document.addEventListener('click', (e) => { if (selMenu && !selMenu.contains(e.target)) closeSelMenu(); });

// ---------------------------------------------------------------- audio sync
function setupAudio() {
  const a = $('raudio'); curPlaySpan = null;
  if (state.meta.source_path) { a.src = fileUrl(state.meta.source_path); $('review-player').hidden = false; }
  else { a.removeAttribute('src'); $('review-player').hidden = true; }
  $('player-time').textContent = '0:00';
}
function schedulePlay(t) { clearTimeout(playClickTimer); playClickTimer = setTimeout(() => playFrom(t), 200); }
function playFrom(t) { const a = $('raudio'); if (!a.getAttribute('src')) return; try { a.currentTime = Math.max(0, t); a.play(); } catch (_) {} }
function togglePlay() { const a = $('raudio'); if (!a.getAttribute('src')) return; a.paused ? a.play() : a.pause(); }
function highlightPlaying(ct) {
  let idx = -1;
  for (let i = 0; i < state.words.length; i++) { if (state.words[i].s <= ct) idx = i; else break; }
  const span = idx >= 0 ? document.querySelector(`.wd[data-i="${idx}"]`) : null;
  if (span === curPlaySpan) return;
  if (curPlaySpan) curPlaySpan.classList.remove('wd-playing');
  if (span) span.classList.add('wd-playing');
  curPlaySpan = span;
}

// ---------------------------------------------------------------- lists editor
function addCorrRow(from, to) {
  const row = document.createElement('div');
  row.className = 'corr-row';
  row.innerHTML = '<input class="corr-from" placeholder="heard as…" spellcheck="false"><span class="corr-arrow">→</span><input class="corr-to" placeholder="should be…" spellcheck="false"><button class="corr-del" title="Remove" aria-label="Remove">✕</button>';
  row.querySelector('.corr-from').value = from || '';
  row.querySelector('.corr-to').value = to || '';
  row.querySelector('.corr-del').onclick = () => row.remove();
  $('corr-rows').appendChild(row);
  return row;
}
function openLists() {
  const rows = $('corr-rows'); rows.innerHTML = '';
  state.cfg.corrections.forEach(([f, t]) => addCorrRow(f, t));
  addCorrRow('', '');   // one blank row ready to type into
  $('ta-fillers').value = state.cfg.fillerWords.join(', ');
  $('tg-filler-remove').checked = state.cfg.fillerRemove;
  $('lists-overlay').classList.remove('hidden');
}
async function saveLists() {
  const corrections = [...$('corr-rows').querySelectorAll('.corr-row')]
    .map((r) => [r.querySelector('.corr-from').value.trim(), r.querySelector('.corr-to').value.trim()])
    .filter(([f, t]) => f && t);
  const fillerWords = $('ta-fillers').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const fillerRemove = $('tg-filler-remove').checked;
  Object.assign(state.cfg, { corrections, fillerWords, fillerRemove });
  await api.setSettings({ corrections, fillerWords, fillerRemove });
  $('lists-overlay').classList.add('hidden'); render();
  setStatus(`Saved ${corrections.length} correction${corrections.length === 1 ? '' : 's'}, ${fillerWords.length} filler term${fillerWords.length === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------- ui plumbing
const MODE_HINTS = {
  stepwise: 'Step-by-step — review each suggested change and accept or skip it.',
  madmax: 'Mad Max — apply safe corrections & fillers automatically, then skim the transcript and click any change to undo or fix it.',
};
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('.review-mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m));
  const h = $('mode-hint'); if (h) h.textContent = MODE_HINTS[m] || '';
  api.setSetting('polishMode', m);
}
function showPanel(which) {
  $('panel-idle').hidden = which !== 'idle';
  $('panel-step').hidden = which !== 'step';
  $('panel-summary').hidden = which !== 'summary';
}
function setStatus(msg, err) { const el = $('review-status'); el.textContent = msg; el.classList.toggle('is-error', !!err); }

function bindUI() {
  document.querySelectorAll('.review-mode-tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $('tg-confidence').addEventListener('change', (e) => document.body.classList.toggle('show-confidence', e.target.checked));
  $('tg-fillers').addEventListener('change', (e) => document.body.classList.toggle('show-fillers', e.target.checked));
  $('tg-conf-check').addEventListener('change', (e) => { document.body.classList.toggle('show-flags', e.target.checked); $('threshold-wrap').classList.toggle('on', e.target.checked); render(); });
  $('conf-threshold').addEventListener('change', () => { render(); api.setSetting('confidenceThreshold', parseFloat($('conf-threshold').value) || 0.5); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); const o = $('lists-overlay'); if (!o.classList.contains('hidden')) o.classList.add('hidden'); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('search-input').focus(); $('search-input').select(); }
    else if (e.key === ' ' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName || '')) { e.preventDefault(); togglePlay(); }
  });
  const a = $('raudio');
  a.addEventListener('timeupdate', () => { highlightPlaying(a.currentTime); $('player-time').textContent = fmtT(a.currentTime); });
  a.addEventListener('play', () => { $('player-toggle').textContent = '⏸'; });
  a.addEventListener('pause', () => { $('player-toggle').textContent = '▶'; });
  $('player-toggle').addEventListener('click', togglePlay);
  $('transcript').addEventListener('mouseup', onTranscriptSelect);
  $('btn-sweep').addEventListener('click', runSweep);
  $('btn-save').addEventListener('click', save);
  $('btn-revert').addEventListener('click', revertAll);
  $('btn-lists').addEventListener('click', openLists);
  $('btn-lists-close').addEventListener('click', () => $('lists-overlay').classList.add('hidden'));
  $('btn-lists-cancel').addEventListener('click', () => $('lists-overlay').classList.add('hidden'));
  $('btn-lists-save').addEventListener('click', saveLists);
  $('corr-add').addEventListener('click', () => addCorrRow('', '').querySelector('.corr-from').focus());
  $('search-input').addEventListener('input', (e) => doSearch(e.target.value));
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } });
  $('search-prev').addEventListener('click', () => gotoMatch(-1));
  $('search-next').addEventListener('click', () => gotoMatch(1));
}

boot();
