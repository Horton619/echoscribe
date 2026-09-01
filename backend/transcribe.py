#!/usr/bin/env python3
"""
EchoScribe backend — local audio/video → text transcription (Apple Silicon).

Pipeline (per input file):
    ffprobe duration → plan ~20-min chunks w/ ~10s overlap → ffmpeg-extract each
    chunk to a 16kHz mono wav → mlx_whisper.transcribe each chunk with
    hallucination-resistant decode params → merge segments back to a single
    continuous timeline (offset + midpoint-of-overlap dedup) → write .txt / .srt
    atomically.

Why chunk at all: mlx-whisper has a known bug on long audio where it gets stuck
repeating the same sentence for minutes. Never feed it a >~20-min file whole.
See github.com/1c7/mlx-whisper-long for the pattern this mirrors.

Talks to the Electron main process over NDJSON on stdout (one JSON object per
line) when --ipc is set. Message types: media_info, start, progress, done,
warn, error, batch_done, plus one-shot probes (probe_result, preflight_result).

⚠ The CLI flags and NDJSON types are a three-way contract (this file +
  src/main.js + src/renderer/app.js). Changing one without the others silently
  breaks the app. See docs/IPC.md.

v2 seam (diarization): merge() returns plain segment dicts (start/end/text).
A future whisperx-mlx speaker-labeling pass slots in between merge() and
write_outputs() without reshaping anything here — do not couple those steps.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------------------
# IPC / logging
# ---------------------------------------------------------------------------

_ipc_mode = False


def _emit(obj: dict):
    """One JSON line to stdout (IPC) or human-readable text (CLI)."""
    if _ipc_mode:
        print(json.dumps(obj), flush=True)
        return
    t = obj.get("type", "")
    if t == "media_info":
        print(f"  {obj['file']}: {obj['duration']:.0f}s → {obj['chunks']} chunk(s)")
    elif t == "start":
        print(f"\n[{obj['file_index']}/{obj['total_files']}] {obj['file']}")
    elif t == "progress":
        print(f"  chunk {obj['chunk']}/{obj['total_chunks']}  {obj['message']}", end="\r")
    elif t == "done":
        print(f"\n  ✓ {obj['file']} → {', '.join(obj['outputs'])}")
    elif t == "warn":
        print(f"  ! {obj.get('message','')}")
    elif t == "error":
        print(f"\n  ✗ Error: {obj.get('message','')}", file=sys.stderr)
    elif t == "batch_done":
        print(f"\nBatch complete: {obj['transcribed']} done, {obj['errors']} errors.")


def _warn(msg, file=None):
    _emit({"type": "warn", "message": str(msg), "file": file})


# ---------------------------------------------------------------------------
# ffmpeg / ffprobe
# ---------------------------------------------------------------------------

def _ffbin(name: str, override: str | None) -> str:
    """Resolve an ffmpeg-family binary: explicit dir override, else PATH."""
    if override:
        cand = os.path.join(override, name)
        if os.path.exists(cand):
            return cand
    return name  # rely on PATH


def ffprobe_duration(path: str, ffprobe_bin: str) -> float:
    out = subprocess.run(
        [ffprobe_bin, "-v", "quiet", "-print_format", "json",
         "-show_format", path],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {out.stderr.strip() or 'unknown error'}")
    data = json.loads(out.stdout)
    dur = data.get("format", {}).get("duration")
    if dur is None:
        raise RuntimeError("could not read media duration")
    return float(dur)


def plan_chunks(duration: float, segment: float, overlap: float):
    """
    Return [(index, global_start, chunk_duration)] covering [0, duration].
    Consecutive chunks advance by (segment - overlap) so each overlaps its
    neighbour by `overlap` seconds — no words lost at a boundary.
    """
    if duration <= segment:
        return [(0, 0.0, duration)]
    step = max(1.0, segment - overlap)
    chunks = []
    start = 0.0
    idx = 0
    while start < duration:
        dur = min(segment, duration - start)
        chunks.append((idx, start, dur))
        if start + dur >= duration:
            break
        start += step
        idx += 1
    return chunks


def extract_chunk(input_path, global_start, dur, out_wav, ffmpeg_bin):
    """Cut one 16kHz mono PCM wav chunk. Input-seek for speed; the 10s overlap
    and Whisper's own alignment absorb any sub-second seek imprecision."""
    cmd = [
        ffmpeg_bin, "-nostdin", "-y",
        "-ss", f"{global_start:.3f}", "-i", input_path,
        "-t", f"{dur:.3f}",
        "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le",
        out_wav,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg chunk extract failed: {proc.stderr.strip()[-400:]}")


# ---------------------------------------------------------------------------
# Transcription + merge
# ---------------------------------------------------------------------------

# Hallucination-resistant decode params. Keep these — they're what makes
# long-file output trustworthy.
#   no_speech_threshold 0.6      → treat low-speech-probability windows as silence
#   compression_ratio_threshold  → discard repetitive (looping) output
#   hallucination_silence_threshold → when word_timestamps is on, skip silent
#       gaps > this many seconds when a likely hallucination is detected. This is
#       what suppresses the "Thank you." / "We'll be right back." spam Whisper
#       otherwise invents over quiet stretches.
_DECODE_OPTS = dict(
    condition_on_previous_text=False,
    no_speech_threshold=0.6,
    compression_ratio_threshold=2.4,
    logprob_threshold=-1.0,
    word_timestamps=True,
    hallucination_silence_threshold=2.0,
)


def transcribe_chunk(wav_path, model_id, initial_prompt, language):
    import mlx_whisper  # imported lazily so --preflight can report a clean error
    opts = dict(_DECODE_OPTS)
    if initial_prompt:
        opts["initial_prompt"] = initial_prompt
    if language:
        opts["language"] = language
    return mlx_whisper.transcribe(wav_path, path_or_hf_repo=model_id, **opts)


def merge(chunk_results, overlap: float):
    """
    chunk_results: list of (global_start, whisper_result) in order.
    Offset each chunk's local segment times by its global_start, then assign
    each segment to exactly one chunk by which side of the seam its MIDPOINT
    falls on. Each chunk owns the global span [lo, hi): lo is the midpoint of
    its overlap with the previous chunk (−inf for the first), hi the midpoint of
    its overlap with the next (+inf for the last). The windows are contiguous, so
    every segment lands in exactly one — no seam gaps (dropped words) and no
    double-counting (duplicated words), which start-only filtering caused.
    Returns [{start,end,text}].
    """
    merged = []
    n = len(chunk_results)
    for i, (gstart, result) in enumerate(chunk_results):
        lo = (gstart + overlap / 2.0) if i > 0 else float("-inf")
        hi = (chunk_results[i + 1][0] + overlap / 2.0) if i < n - 1 else float("inf")
        for s in result.get("segments") or []:
            start = float(s["start"]) + gstart
            end = float(s["end"]) + gstart
            mid = (start + end) / 2.0
            if not (lo <= mid < hi):
                continue
            text = s["text"].strip()
            if text:
                merged.append({"start": start, "end": end, "text": text})
    return merged


# ---------------------------------------------------------------------------
# Word-level merge + re-segmentation
#
# Segment-level seam handling can't fully dedup a chunk boundary when the two
# chunks transcribe the ~overlap seconds slightly differently and a sentence
# straddles the seam. Working at the WORD level fixes it: each chunk owns a
# contiguous time window, cut at the quietest point inside the overlap, and each
# word is assigned to exactly one window by its own timestamp — no word appears
# twice, none is dropped. From the clean word stream we then re-segment into
# readable paragraphs (silence + punctuation) and properly-sized subtitle cues.
# ---------------------------------------------------------------------------

def _chunk_words(gstart, result):
    """Flatten a chunk result into a global-timed word list. Falls back to
    whole segments if word timestamps are somehow absent."""
    words = []
    for seg in result.get("segments") or []:
        ws = seg.get("words") or []
        if ws:
            for w in ws:
                txt = w.get("word", "")
                if txt.strip():
                    words.append({"start": float(w["start"]) + gstart,
                                  "end": float(w["end"]) + gstart, "word": txt})
        elif seg.get("text", "").strip():
            words.append({"start": float(seg["start"]) + gstart,
                          "end": float(seg["end"]) + gstart, "word": " " + seg["text"].strip()})
    return words


def _seam_cut(words_a, words_b, ov_lo, overlap):
    """Pick a cut time inside the overlap [ov_lo, ov_lo+overlap]: the midpoint of
    the widest word-gap that is quiet in BOTH chunks. Falls back to the overlap
    midpoint. Cutting at a real pause means no spoken word straddles the seam, so
    the handoff between chunks is clean."""
    ov_hi = ov_lo + overlap
    default = ov_lo + overlap / 2.0

    def spans(words, t):  # is time t inside some word (not a gap) for this chunk?
        return any(w["start"] - 0.05 <= t <= w["end"] + 0.05 for w in words if ov_lo <= w["end"] and w["start"] <= ov_hi)

    best_cut, best_gap = default, -1.0
    seq = [w for w in words_a if w["end"] >= ov_lo - 0.2 and w["start"] <= ov_hi + 0.2]
    for a, b in zip(seq, seq[1:]):
        mid = (a["end"] + b["start"]) / 2.0
        gap = b["start"] - a["end"]
        if ov_lo <= mid <= ov_hi and gap > best_gap and not spans(words_b, mid):
            best_gap, best_cut = gap, mid
    return best_cut


def merge_words(chunk_results, overlap):
    """Stitch chunk word-streams into one continuous, de-seamed word list."""
    n = len(chunk_results)
    per_chunk = [_chunk_words(g, r) for (g, r) in chunk_results]
    cuts = []
    for i in range(n - 1):
        cuts.append(_seam_cut(per_chunk[i], per_chunk[i + 1], chunk_results[i + 1][0], overlap))
    merged = []
    for i in range(n):
        lo = cuts[i - 1] if i > 0 else float("-inf")
        hi = cuts[i] if i < n - 1 else float("inf")
        for w in per_chunk[i]:
            mid = (w["start"] + w["end"]) / 2.0
            if lo <= mid < hi:
                merged.append(w)
    return merged


def _wjoin(words):
    return {"start": words[0]["start"], "end": words[-1]["end"],
            "text": "".join(w["word"] for w in words).strip()}


def words_to_sentences(words):
    """Group words into sentence-ish units, breaking after . ? ! (used by the
    multitrack path, which then merges/labels by speaker)."""
    out, cur = [], []
    for w in words:
        cur.append(w)
        if w["word"].strip()[-1:] in ".?!":
            out.append(_wjoin(cur)); cur = []
    if cur:
        out.append(_wjoin(cur))
    return out


def words_to_paragraphs(words, gap=1.4, hard_gap=2.6, max_chars=550):
    """Break the word stream into readable paragraphs: a new paragraph starts at a
    speaking pause (≥gap) that lands on a sentence end, at any long pause
    (≥hard_gap), or when a paragraph gets long and reaches a sentence end."""
    paras, cur = [], []
    for w in words:
        if cur:
            pause = w["start"] - cur[-1]["end"]
            text = "".join(x["word"] for x in cur).strip()
            ends_sentence = text[-1:] in ".?!"
            if (pause >= gap and ends_sentence) or pause >= hard_gap or (len(text) >= max_chars and ends_sentence):
                paras.append(_wjoin(cur)); cur = []
        cur.append(w)
    if cur:
        paras.append(_wjoin(cur))
    return paras


def words_to_cues(words, max_dur=5.5, max_chars=90):
    """Group words into subtitle cues capped by duration and length, preferring to
    break at punctuation so cues read as clauses."""
    cues, cur = [], []
    for w in words:
        if cur:
            dur = w["end"] - cur[0]["start"]
            text = "".join(x["word"] for x in cur)
            soft = text.strip()[-1:] in ".?!,;:"
            if ((dur >= max_dur or len(text) >= max_chars) and soft) or dur >= max_dur * 1.6 or len(text) >= max_chars * 1.4:
                cues.append(_wjoin(cur)); cur = []
        cur.append(w)
    if cur:
        cues.append(_wjoin(cur))
    return cues


# ---------------------------------------------------------------------------
# Output writers (atomic: temp + os.replace)
# ---------------------------------------------------------------------------

def _atomic_write(path, text):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _srt_ts(t: float) -> str:
    # Derive h/m/s/ms from a single rounded-millisecond integer so rollover
    # carries correctly (no invalid ":60" fields, which strict SRT players reject).
    total_ms = max(0, int(round(t * 1000)))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path, segments):
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{_srt_ts(seg['start'])} --> {_srt_ts(seg['end'])}")
        lines.append(seg["text"])
        lines.append("")
    _atomic_write(path, "\n".join(lines))


def write_txt(path, segments):
    _atomic_write(path, "\n".join(seg["text"] for seg in segments) + "\n")


def _hms(t):
    total = max(0, int(t))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def write_timestamped_txt(path, segments):
    """Readable transcript with a [HH:MM:SS] time prefix on each segment."""
    _atomic_write(path, "\n".join(f"[{_hms(seg['start'])}] {seg['text']}" for seg in segments) + "\n")


def write_paragraph_txt(path, paragraphs):
    """Clean, postable transcript — paragraphs separated by a blank line, no times."""
    _atomic_write(path, "\n\n".join(p["text"] for p in paragraphs) + "\n")


def write_paragraph_ttxt(path, paragraphs):
    """Readable transcript with a [HH:MM:SS] prefix per paragraph."""
    _atomic_write(path, "\n\n".join(f"[{_hms(p['start'])}] {p['text']}" for p in paragraphs) + "\n")


def collapse_repeats(segments):
    """Collapse a run of consecutive segments with identical text into one.
    Whisper hallucinates a short phrase ("Thank you.", "We'll be right back.")
    over quiet stretches, emitting it many times back-to-back; this removes the
    spam while keeping one instance (and extending its end time)."""
    out = []
    for s in segments:
        if out and _norm_text(out[-1]["text"]) == _norm_text(s["text"]):
            out[-1]["end"] = s["end"]
            continue
        out.append(s)
    return out


# ---------------------------------------------------------------------------
# Per-file driver
# ---------------------------------------------------------------------------

def process_file(path, file_index, total_files, opts):
    name = os.path.basename(path)
    ffmpeg_bin = _ffbin("ffmpeg", opts.ffmpeg_path)
    ffprobe_bin = _ffbin("ffprobe", opts.ffmpeg_path)

    duration = ffprobe_duration(path, ffprobe_bin)
    if duration <= 0:
        raise RuntimeError("media has no readable duration")
    chunks = plan_chunks(duration, opts.chunk_length, opts.overlap)
    # file_path echoes the exact input path so the UI routes messages to the
    # right queue item even when two files share a basename.
    _emit({"type": "media_info", "file": name, "file_path": path, "duration": duration, "chunks": len(chunks)})
    _emit({"type": "start", "file": name, "file_path": path, "file_index": file_index, "total_files": total_files})

    tmpdir = tempfile.mkdtemp(prefix="echoscribe_")
    chunk_results = []
    try:
        for (idx, gstart, dur) in chunks:
            _emit({
                "type": "progress", "file": name, "file_path": path,
                "chunk": idx + 1, "total_chunks": len(chunks),
                "percent": round(100 * gstart / duration) if duration else 0,
                "message": f"transcribing {int(gstart)//60}:{int(gstart)%60:02d}…",
            })
            wav = os.path.join(tmpdir, f"chunk_{idx:03d}.wav")
            extract_chunk(path, gstart, dur, wav, ffmpeg_bin)
            result = transcribe_chunk(wav, opts.model, opts.initial_prompt, opts.language)
            chunk_results.append((gstart, result))
            os.unlink(wav)

        # Word-level: clean seams, then re-segment into readable paragraphs and
        # subtitle cues.
        words = merge_words(chunk_results, opts.overlap)
        paragraphs = collapse_repeats(words_to_paragraphs(words))
        cues = words_to_cues(words)

        base = os.path.splitext(name)[0]
        out_dir = opts.output_dir or os.path.dirname(path)
        os.makedirs(out_dir, exist_ok=True)
        formats = [f.strip() for f in opts.formats.split(",") if f.strip()]
        outputs = []
        if "txt" in formats:
            p = os.path.join(out_dir, base + ".txt")
            write_paragraph_txt(p, paragraphs)
            outputs.append(p)
        if "ttxt" in formats:
            p = os.path.join(out_dir, base + "_timestamped.txt")
            write_paragraph_ttxt(p, paragraphs)
            outputs.append(p)
        if "srt" in formats:
            p = os.path.join(out_dir, base + ".srt")
            write_srt(p, cues)
            outputs.append(p)

        lang = chunk_results[0][1].get("language") if chunk_results else None
        _emit({
            "type": "done", "file": name, "file_path": path, "outputs": outputs,
            "segments": len(paragraphs), "duration": duration,
            "chunks": len(chunks), "language": lang, "output_dir": out_dir,
        })
        return True
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Multitrack mode — diarization-by-hardware
#
# Input: 2–6 sample-aligned tracks (one mic per speaker, recorded on a single
# multitrack recorder so they share a clock) + a speaker name per track.
#
# Pipeline:
#   1. Auto-mixer gate (per 25ms block, only the loudest track stays open) so
#      each track transcribes only where its speaker was dominant — kills bleed
#      at the source.
#   2. Transcribe each gated track (chunked, same core as batch mode).
#   3. Merge all segments on the shared timeline, label by speaker, run a
#      similarity+energy dedup as a safety net, coalesce consecutive same-speaker
#      turns, and write a script (.txt + speaker-prefixed .srt) plus each track's
#      own transcript.
#
# Tunables live here as module constants — perfect separation isn't required
# because the merge-time dedup catches residual bleed.
# ---------------------------------------------------------------------------

SR = 16000
_GATE_BLOCK = 400          # samples per envelope block (25ms @ 16kHz)
_GATE_RELEASE = 12         # blocks (~300ms) a winner holds open across trailing silence
_GATE_PREROLL = 3          # blocks (~75ms) opened before a winner to catch word onsets
_GATE_FLOOR_FRAC = 0.15    # gate floor as a fraction of the session's speech level
_GATE_FLOOR_MIN = 0.005    # absolute floor so pure silence never "wins"
_DEDUP_TIME_OVERLAP = 0.5  # min fractional time overlap to consider two segs duplicates
_DEDUP_TEXT_RATIO = 0.75   # min text similarity to treat overlapping segs as duplicates


def load_audio_16k(path):
    import numpy as np
    import mlx_whisper.audio as A
    # load_audio returns an mlx array; gating math is numpy, so convert here.
    return np.asarray(A.load_audio(path, sr=SR), dtype=np.float32)


def block_rms(audio):
    """Non-overlapping 25ms-block RMS envelope. O(n) memory."""
    import numpy as np
    nb = len(audio) // _GATE_BLOCK
    if nb == 0:
        return np.zeros(0, dtype=np.float32)
    frames = audio[:nb * _GATE_BLOCK].reshape(nb, _GATE_BLOCK)
    return np.sqrt((frames.astype(np.float32) ** 2).mean(axis=1))


def compute_gates(envs):
    """
    envs: list of per-track block-RMS arrays (possibly differing lengths).
    Returns (gates, envs_padded): gates[i] is a bool array (per block) — True
    where track i is the open mic. Only the loudest track above the floor is
    open at each block; a winner holds open through short trailing silence and
    opens slightly early (pre-roll) so word edges aren't clipped.
    """
    import numpy as np
    T = max((len(e) for e in envs), default=0)
    padded = np.zeros((len(envs), T), dtype=np.float32)
    for i, e in enumerate(envs):
        padded[i, :len(e)] = e

    peak = padded.max(axis=0)
    winner = padded.argmax(axis=0)
    voiced = peak[peak > _GATE_FLOOR_MIN]
    speech_level = float(np.percentile(voiced, 75)) if voiced.size else 0.0
    floor = max(_GATE_FLOOR_MIN, _GATE_FLOOR_FRAC * speech_level)
    active = peak > floor

    gates = []
    for i in range(len(envs)):
        g = (winner == i) & active
        # Release: keep this mic open across following silence blocks.
        hold = 0
        for t in range(T):
            if g[t]:
                hold = _GATE_RELEASE
            elif hold > 0 and not active[t]:
                g[t] = True
                hold -= 1
            else:
                hold = 0
        # Pre-roll: open a few blocks before each rising edge.
        rising = np.where(g[1:] & ~g[:-1])[0] + 1
        for r in rising:
            g[max(0, r - _GATE_PREROLL):r] = True
        gates.append(g)
    return gates, padded


def apply_gate(audio, gate_blocks):
    """Zero every sample outside this track's open-mic blocks."""
    import numpy as np
    mask = np.repeat(gate_blocks, _GATE_BLOCK)
    n = min(len(audio), len(mask))
    # Gate in place — avoids a second full-length allocation (~0.5GB on a long
    # track); we own `audio` and don't reuse it after gating.
    audio[:n] *= mask[:n].astype(audio.dtype)
    audio[n:] = 0
    return audio


def chunk_and_transcribe_array(audio, opts, progress_cb=None):
    """Slice an in-memory 16kHz array into overlapping chunks, transcribe each,
    merge to one continuous timeline. Mirrors the batch-mode ffmpeg path but for
    audio we already hold in memory (gated multitrack tracks)."""
    import mlx_whisper
    seg_samples = int(opts.chunk_length * SR)
    step = max(1, int((opts.chunk_length - opts.overlap) * SR))
    total = len(audio)
    starts = list(range(0, total, step)) if total > seg_samples else [0]
    results = []
    for k, s in enumerate(starts):
        if progress_cb:
            progress_cb(k + 1, len(starts), s / SR)
        clip = audio[s:s + seg_samples]
        dopts = dict(_DECODE_OPTS)
        if opts.initial_prompt:
            dopts["initial_prompt"] = opts.initial_prompt
        if opts.language:
            dopts["language"] = opts.language
        result = mlx_whisper.transcribe(clip, path_or_hf_repo=opts.model, **dopts)
        results.append((s / SR, result))
        if s + seg_samples >= total:
            break
    # Word-stitched, then re-segmented into sentences for the multitrack merge.
    return words_to_sentences(merge_words(results, opts.overlap))


def _energy_at(env, start, end):
    """Mean block-RMS of a track over [start,end] seconds — used to pick the
    louder track when the dedup finds the same remark on two mics."""
    import numpy as np
    a = int(start * SR / _GATE_BLOCK)
    b = max(a + 1, int(end * SR / _GATE_BLOCK))
    seg = env[a:b]
    return float(seg.mean()) if seg.size else 0.0


def _norm_text(t):
    return "".join(c.lower() for c in t if c.isalnum() or c.isspace()).strip()


def dedup_across_tracks(segments):
    """Drop residual bleed: when two segments from different speakers overlap in
    time and say nearly the same thing, keep the one on the louder track."""
    from difflib import SequenceMatcher
    kept = []
    for seg in segments:
        dup_of = None
        for j in range(len(kept) - 1, -1, -1):
            k = kept[j]
            if k["start"] > seg["end"]:
                continue
            if k["end"] < seg["start"] - 2.0:
                break  # sorted by start; nothing earlier can overlap
            if k["speaker"] == seg["speaker"]:
                continue
            ov = min(k["end"], seg["end"]) - max(k["start"], seg["start"])
            shorter = min(k["end"] - k["start"], seg["end"] - seg["start"]) or 1e-6
            if ov / shorter < _DEDUP_TIME_OVERLAP:
                continue
            if SequenceMatcher(None, _norm_text(k["text"]), _norm_text(seg["text"])).ratio() >= _DEDUP_TEXT_RATIO:
                dup_of = j
                break
        if dup_of is None:
            kept.append(seg)
        elif seg["energy"] > kept[dup_of]["energy"]:
            kept[dup_of] = seg  # incoming track was louder — it wins
    return kept


def _script_ts(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def write_script_txt(path, segments, timestamps=True):
    """Coalesce consecutive same-speaker segments into turns. With timestamps
    off, produces a clean reading script (`Name: …`) with no time prefixes."""
    lines = []
    cur_spk = None
    buf = []
    start = 0.0
    def flush():
        if buf:
            prefix = f"[{_script_ts(start)}] " if timestamps else ""
            lines.append(f"{prefix}{cur_spk}: {' '.join(buf)}")
            lines.append("")
    for seg in segments:
        if seg["speaker"] != cur_spk:
            flush()
            cur_spk = seg["speaker"]
            buf = []
            start = seg["start"]
        buf.append(seg["text"])
    flush()
    _atomic_write(path, "\n".join(lines) + "\n")


def write_script_srt(path, segments):
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{_srt_ts(seg['start'])} --> {_srt_ts(seg['end'])}")
        lines.append(f"{seg['speaker']}: {seg['text']}")
        lines.append("")
    _atomic_write(path, "\n".join(lines))


def process_multitrack(files, speakers, opts):
    if len(files) != len(speakers):
        raise RuntimeError("multitrack needs one speaker name per file")
    n = len(files)
    _emit({"type": "start", "file": opts.session_name or "session",
           "file_index": 1, "total_files": 1, "multitrack": True, "tracks": n})

    # Phase A: envelopes only (one raw track in memory at a time).
    _emit({"type": "progress", "chunk": 0, "total_chunks": n, "percent": 0,
           "message": "analyzing levels for auto-mixer…"})
    envs = []
    for path in files:
        envs.append(block_rms(load_audio_16k(path)))

    # Phase B: winner/gate decision across the shared timeline.
    gates, envs_padded = compute_gates(envs)

    # Phase C: gate + transcribe each track; tag its segments with the speaker.
    all_segments = []
    per_track_segments = []
    for i, (path, name) in enumerate(zip(files, speakers)):
        def cb(cur, tot, secs, _i=i, _name=name):
            _emit({"type": "progress", "file": _name,
                   "chunk": i + 1, "total_chunks": n,
                   "percent": round(100 * (i + (cur / max(tot, 1))) / n),
                   "message": f"transcribing {_name} ({cur}/{tot})…"})
        gated = apply_gate(load_audio_16k(path), gates[i])
        segs = chunk_and_transcribe_array(gated, opts, cb)
        for s in segs:
            s["speaker"] = name
            s["track"] = i
            s["energy"] = _energy_at(envs_padded[i], s["start"], s["end"])
        per_track_segments.append((name, segs))
        all_segments.extend(segs)

    # Phase D: merge → dedup → write.
    all_segments.sort(key=lambda s: s["start"])
    final = collapse_repeats(dedup_across_tracks(all_segments))

    out_dir = opts.output_dir or os.path.dirname(files[0])
    os.makedirs(out_dir, exist_ok=True)
    session = opts.session_name or "session"
    outputs = []

    formats = [f.strip() for f in opts.formats.split(",") if f.strip()]
    if "txt" in formats:
        p = os.path.join(out_dir, f"{session}_script.txt")
        write_script_txt(p, final, timestamps=opts.script_timestamps); outputs.append(p)
    if "srt" in formats:
        p = os.path.join(out_dir, f"{session}_script.srt")
        write_script_srt(p, final); outputs.append(p)

    # Per-speaker transcripts (opt-in via --per-speaker).
    if opts.per_speaker:
        for name, segs in per_track_segments:
            safe = re.sub(r"[^\w\-]+", "_", name).strip("_") or "track"
            if "txt" in formats:
                p = os.path.join(out_dir, f"{session}_{safe}.txt")
                write_txt(p, segs); outputs.append(p)
            if "srt" in formats:
                p = os.path.join(out_dir, f"{session}_{safe}.srt")
                write_srt(p, segs); outputs.append(p)

    _emit({"type": "done", "file": session, "outputs": outputs,
           "segments": len(final), "speakers": speakers,
           "multitrack": True, "output_dir": out_dir})
    _emit({"type": "batch_done", "transcribed": 1, "errors": 0})


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------

def run_probe(path, opts):
    """One-shot: report duration + planned chunk count for a single file."""
    try:
        ffprobe_bin = _ffbin("ffprobe", opts.ffmpeg_path)
        duration = ffprobe_duration(path, ffprobe_bin)
        chunks = plan_chunks(duration, opts.chunk_length, opts.overlap)
        _emit({"type": "probe_result", "ok": True, "file": os.path.basename(path),
               "duration": duration, "chunks": len(chunks)})
    except Exception as e:
        _emit({"type": "probe_result", "ok": False, "error": str(e)})


# ---------------------------------------------------------------------------
# Model management — pre-cache both models for offline use
#
# The models download from Hugging Face on first use. For a laptop headed
# somewhere with no wifi, the app offers a "download everything now" action
# (settings → Diagnostics) plus a first-launch nudge. These two commands back
# that UI. ffmpeg + mlx are bundled in the app itself — models are the only
# runtime download, so "download all libraries" == cache these models.
# ---------------------------------------------------------------------------

MODELS = [
    ("mlx-community/whisper-large-v3-turbo", "Turbo — fast"),
    ("mlx-community/whisper-large-v3-mlx", "Large-v3 — max accuracy"),
]


def _model_cached(repo):
    from huggingface_hub import snapshot_download
    try:
        snapshot_download(repo, local_files_only=True)
        return True
    except Exception:
        return False


def run_models_status():
    _emit({"type": "models_status",
           "models": [{"repo": r, "label": l, "cached": _model_cached(r)} for r, l in MODELS]})


def _dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def run_download_models():
    import threading
    from huggingface_hub import snapshot_download, HfApi
    from huggingface_hub.constants import HF_HUB_CACHE

    api = HfApi()
    for r, l in MODELS:
        if _model_cached(r):
            _emit({"type": "model_download", "repo": r, "label": l, "state": "cached", "percent": 100})
            continue

        # Total download size, so the UI can show a real percent + MB counter.
        try:
            info = api.model_info(r, files_metadata=True)
            total = sum((s.size or 0) for s in info.siblings) or 0
        except Exception:
            total = 0

        # hf downloads land (incl. .incomplete temp files) under blobs/ — poll its
        # size on a thread for progress; version-proof vs. hooking tqdm internals.
        blobs = os.path.join(HF_HUB_CACHE, "models--" + r.replace("/", "--"), "blobs")
        _emit({"type": "model_download", "repo": r, "label": l, "state": "downloading", "percent": 0, "downloaded": 0, "total": total})

        stop = threading.Event()

        def poll(repo=r, label=l, blobs=blobs, total=total):
            while not stop.wait(0.6):
                if stop.is_set():   # don't emit a stray 'downloading' after 'done'
                    return
                done = _dir_size(blobs) if os.path.isdir(blobs) else 0
                pct = min(99, round(100 * done / total)) if total else 0
                _emit({"type": "model_download", "repo": repo, "label": label,
                       "state": "downloading", "percent": pct, "downloaded": done, "total": total})

        t = threading.Thread(target=poll, daemon=True)
        t.start()
        try:
            snapshot_download(r)
            stop.set(); t.join(timeout=1)
            _emit({"type": "model_download", "repo": r, "label": l, "state": "done", "percent": 100, "total": total})
        except Exception as e:
            stop.set(); t.join(timeout=1)
            _emit({"type": "model_download", "repo": r, "label": l, "state": "error", "message": str(e)})
    _emit({"type": "models_done"})


def _sample_path():
    """Bundled verified smoke-test clip (public-domain JFK excerpt)."""
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "assets", "jfk.flac")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "jfk.flac")


def run_preflight(opts):
    results = {}

    ffmpeg_bin = _ffbin("ffmpeg", opts.ffmpeg_path)
    try:
        subprocess.run([ffmpeg_bin, "-version"], capture_output=True, check=True)
        results["ffmpeg"] = {"ok": True, "message": ffmpeg_bin}
    except Exception as e:
        results["ffmpeg"] = {"ok": False, "message": str(e)}

    try:
        import mlx_whisper  # noqa: F401
        import mlx  # noqa: F401
        results["mlx_whisper"] = {"ok": True, "message": "mlx-whisper importable"}
    except Exception as e:
        results["mlx_whisper"] = {"ok": False, "message": str(e)}

    # End-to-end smoke test: transcribe a known clip and check the result.
    # Only runs when a model is already cached, so preflight never kicks off a
    # multi-GB download or needs the network.
    turbo = MODELS[0][0]
    sample = _sample_path()
    if not _model_cached(turbo):
        results["smoke_test"] = {"ok": True, "message": "skipped — download a model first (Offline models, below)"}
    elif not os.path.exists(sample):
        results["smoke_test"] = {"ok": False, "message": f"sample clip missing: {sample}"}
    else:
        try:
            text = (transcribe_chunk(sample, turbo, None, None).get("text") or "").strip()
            low = text.lower()
            ok = "country" in low and "americans" in low
            results["smoke_test"] = {"ok": ok,
                                     "message": f'"{text[:70]}…"' if ok else f"unexpected output: {text[:60]}"}
        except Exception as e:
            results["smoke_test"] = {"ok": False, "message": str(e)}

    _emit({"type": "preflight_result", "results": results})


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    global _ipc_mode

    p = argparse.ArgumentParser(description="EchoScribe transcription backend")
    p.add_argument("inputs", nargs="*", help="audio/video files")
    p.add_argument("--output-dir", "-o", default=None)
    p.add_argument("--model", default="mlx-community/whisper-large-v3-turbo",
                   help="HF repo id for the mlx-whisper model")
    p.add_argument("--chunk-length", type=float, default=300.0,
                   help="chunk length in seconds (default 300 = 5 min; smaller = "
                        "smoother progress, well under mlx-whisper's long-file limit)")
    p.add_argument("--overlap", type=float, default=10.0,
                   help="overlap between chunks in seconds")
    p.add_argument("--initial-prompt", default=None,
                   help="vocabulary hint passed to Whisper as --initial-prompt")
    p.add_argument("--language", default=None,
                   help="force a language code; omit to auto-detect")
    p.add_argument("--formats", default="txt,srt", help="comma list: txt,srt")
    p.add_argument("--ffmpeg-path", default=None,
                   help="directory containing ffmpeg/ffprobe (else PATH)")
    # Multitrack mode (diarization-by-hardware) — see process_multitrack.
    p.add_argument("--multitrack", action="store_true",
                   help="treat inputs as one speaker per aligned track")
    p.add_argument("--speakers", default=None, metavar="JSON",
                   help="JSON array of speaker names, one per input file")
    p.add_argument("--session-name", default="session",
                   help="base name for the merged script output")
    p.add_argument("--per-speaker", action="store_true",
                   help="also write each track's own transcript")
    p.add_argument("--script-timestamps", choices=["yes", "no"], default="yes",
                   help="include [HH:MM:SS] prefixes in the merged script .txt")
    p.add_argument("--ipc", action="store_true", help="emit NDJSON on stdout")
    p.add_argument("--probe", default=None, metavar="FILE",
                   help="report duration + chunk plan for one file, then exit")
    p.add_argument("--preflight", action="store_true",
                   help="check ffmpeg + mlx-whisper availability, then exit")
    p.add_argument("--models-status", action="store_true",
                   help="report which models are cached, then exit")
    p.add_argument("--download-models", action="store_true",
                   help="download all models for offline use, then exit")
    opts = p.parse_args()

    _ipc_mode = opts.ipc

    # Guard a flag combo that would otherwise floor the chunk step at 1s and
    # explode a long file into thousands of chunks (a multi-hour hang).
    if opts.overlap >= opts.chunk_length:
        clamped = opts.chunk_length / 2.0
        _warn(f"overlap ({opts.overlap}s) >= chunk length ({opts.chunk_length}s); clamping overlap to {clamped}s")
        opts.overlap = clamped

    if opts.preflight:
        run_preflight(opts)
        return
    if opts.models_status:
        run_models_status()
        return
    if opts.download_models:
        run_download_models()
        return
    if opts.probe:
        run_probe(opts.probe, opts)
        return

    if opts.multitrack:
        opts.script_timestamps = (opts.script_timestamps == "yes")
        try:
            # json.loads is inside the try so malformed --speakers reports an
            # error + batch_done instead of crashing with no NDJSON (hung UI).
            speakers = json.loads(opts.speakers) if opts.speakers else \
                [os.path.splitext(os.path.basename(f))[0] for f in opts.inputs]
            process_multitrack(opts.inputs, speakers, opts)
        except Exception as e:
            _emit({"type": "error", "file": opts.session_name, "message": str(e)})
            _emit({"type": "batch_done", "transcribed": 0, "errors": 1})
        return

    total = len(opts.inputs)
    transcribed = errors = 0
    for i, path in enumerate(opts.inputs, 1):
        try:
            if process_file(path, i, total, opts):
                transcribed += 1
        except Exception as e:
            errors += 1
            _emit({"type": "error", "file": os.path.basename(path), "file_path": path, "message": str(e)})

    _emit({"type": "batch_done", "transcribed": transcribed, "errors": errors})


if __name__ == "__main__":
    main()
