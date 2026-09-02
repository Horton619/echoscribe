#!/usr/bin/env python3
"""
seam_audit.py — regression harness for the chunk/merge/seam pipeline.

The pipeline splits long audio into overlapping chunks, transcribes each, and
stitches the word streams back together (backend.transcribe.merge_words). Two
failure classes have bitten us: words DROPPED at a boundary and words
DUPLICATED across a boundary. This harness detects both without needing a
hand-made ground-truth transcript, by exploiting two facts:

  1. merge_words is a pure function of the per-chunk word lists, so its
     tiling/dedup invariants can be checked directly (CHECK 1).
  2. Every overlap region is transcribed TWICE (tail of chunk i, head of
     chunk i+1). A content word both chunks independently agree on, but that
     is missing from the merged output, is a confirmed seam dropout (CHECK 2).

CHECK 3 (optional, --deep) diffs the pipeline against an independent reference
built from single-call transcriptions of <=REF_MAX-second segments cut at
silence. Its internal 30s-window boundaries fall at different absolute times
than the 300s-chunk pipeline, so it surfaces mid-chunk dropouts (the class the
condition_on_previous_text flag governs) that CHECK 2 cannot see.

Exit code is non-zero if any CONFIRMED dropout or duplication is found, so this
doubles as a CI gate.

Usage:
  seam_audit.py FILE [FILE ...] [--cond|--no-cond] [--vocab TEXT]
                [--chunk 300] [--overlap 10] [--model turbo] [--deep]
"""
import argparse
import difflib
import hashlib
import os
import pickle
import re
import sys
import tempfile

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _REPO)
import backend.transcribe as t  # noqa: E402

_MODELS = {
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large": "mlx-community/whisper-large-v3-mlx",
}
REF_MAX = 900.0  # seconds per reference segment (<15min: below the long-file bug)
_STOP = {"the", "and", "for", "that", "you", "was", "are", "our", "with", "this",
         "have", "not", "but", "they", "them", "your", "can", "all", "get", "one"}


_CACHE_DIR = os.path.join(tempfile.gettempdir(), "seam_audit_cache")


def _cache(path, tag, produce):
    """Memoize transcription results to disk keyed by file identity + params, so
    re-running the checks after editing harness logic costs seconds, not minutes.
    Delete /tmp/seam_audit_cache to force a fresh transcription."""
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_mtime_ns}|{st.st_size}|{tag}".encode()).hexdigest()
    fp = os.path.join(_CACHE_DIR, key + ".pkl")
    if os.path.exists(fp):
        with open(fp, "rb") as f:
            return pickle.load(f)
    val = produce()
    os.makedirs(_CACHE_DIR, exist_ok=True)
    with open(fp, "wb") as f:
        pickle.dump(val, f)
    return val


def _norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def _content(word_txt):
    n = _norm(word_txt)
    return n if len(n) >= 3 and n not in _STOP else None


def transcribe_chunks(path, cond, vocab, chunk_len, overlap, model_id, ff):
    def produce():
        import mlx_whisper
        dur = t.ffprobe_duration(path, t._ffbin("ffprobe", None))
        plan = t.plan_chunks(dur, chunk_len, overlap)
        tmp = tempfile.mkdtemp(prefix="seamaudit_")
        results = []
        try:
            for (idx, gstart, d) in plan:
                wav = os.path.join(tmp, f"c{idx}.wav")
                t.extract_chunk(path, gstart, d, wav, ff)
                opts = dict(t._DECODE_OPTS)
                opts["condition_on_previous_text"] = cond
                if vocab:
                    opts["initial_prompt"] = vocab
                results.append((gstart, mlx_whisper.transcribe(wav, path_or_hf_repo=model_id, **opts)))
                os.unlink(wav)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        return dur, results
    tag = f"chunks|{cond}|{vocab}|{chunk_len}|{overlap}|{model_id}"
    return _cache(path, tag, produce)


# ---------------------------------------------------------------- CHECK 1
def check_invariants(results, overlap):
    """Cut windows must be monotonic, land inside their overlap, and tile the
    timeline; the merged stream must contain no near-duplicate words."""
    fails = []
    per = [t._chunk_words(g, r) for (g, r) in results]
    n = len(per)
    cuts = [t._seam_cut(per[i], per[i + 1], results[i + 1][0], overlap) for i in range(n - 1)]
    for i, c in enumerate(cuts):
        lo = results[i + 1][0]
        if not (lo - 0.01 <= c <= lo + overlap + 0.01):
            fails.append(f"seam {i}: cut {c:.2f} outside overlap [{lo:.2f},{lo + overlap:.2f}]")
        if i > 0 and c <= cuts[i - 1]:
            fails.append(f"seam {i}: cut {c:.2f} not increasing vs {cuts[i - 1]:.2f}")

    # A merge-induced duplicate is the SAME audio kept from both chunks: same
    # word with OVERLAPPING time spans. Sequential repeats ("the the") in real
    # speech have non-overlapping spans and are not flagged.
    merged = t.merge_words(results, overlap)
    for a, b in zip(merged, merged[1:]):
        if _norm(a["word"]) and _norm(a["word"]) == _norm(b["word"]) \
                and b["start"] < a["end"] - 0.05:
            fails.append(f"seam-duplicated word {a['word'].strip()!r} at {a['start']:.1f}s")
    return fails, cuts, per, merged


# ---------------------------------------------------------------- CHECK 2
def check_overlap_recall(per, results, cuts, merged, overlap):
    """A content word both chunks transcribe inside an overlap, yet absent from
    the merged output near that time, is a confirmed seam dropout."""
    events = []
    merged_by_time = merged
    for i, c in enumerate(cuts):
        lo = results[i + 1][0]
        hi = lo + overlap
        a = {_content(w["word"]) for w in per[i] if lo <= (w["start"] + w["end"]) / 2 <= hi}
        b = {_content(w["word"]) for w in per[i + 1] if lo <= (w["start"] + w["end"]) / 2 <= hi}
        agreed = {x for x in (a & b) if x}
        present = {_content(w["word"]) for w in merged_by_time
                   if lo - 1.5 <= (w["start"] + w["end"]) / 2 <= hi + 1.5}
        for word in agreed - present:
            events.append((lo, word))
    return events


# ---------------------------------------------------------------- CHECK 3
def _segment_points(dur, silences):
    """Cut points near multiples of REF_MAX that land in a detected silence, so
    the reference never splits a word."""
    pts = [0.0]
    target = REF_MAX
    while target < dur:
        near = [s for s in silences if abs((s[0] + s[1]) / 2 - target) < REF_MAX / 2]
        cut = (min(near, key=lambda s: abs((s[0] + s[1]) / 2 - target))[0]
               + min(near, key=lambda s: abs((s[0] + s[1]) / 2 - target))[1]) / 2 if near else target
        if cut - pts[-1] < 30:
            cut = min(pts[-1] + REF_MAX, dur)
        pts.append(cut)
        target = cut + REF_MAX
    pts.append(dur)
    return pts


def build_reference(path, cond, vocab, model_id, ff):
    """High-recall reference: single-call transcription of <=REF_MAX segments cut
    at silence. Different internal-window geometry than the pipeline."""
    def produce():
        import mlx_whisper
        dur = t.ffprobe_duration(path, t._ffbin("ffprobe", None))
        sil = t.detect_silences(path, ff)
        pts = _segment_points(dur, sil)
        tmp = tempfile.mkdtemp(prefix="seamref_")
        words = []
        try:
            for a, b in zip(pts, pts[1:]):
                wav = os.path.join(tmp, "ref.wav")
                t.extract_chunk(path, a, b - a, wav, ff)
                opts = dict(t._DECODE_OPTS)
                opts["condition_on_previous_text"] = cond
                if vocab:
                    opts["initial_prompt"] = vocab
                r = mlx_whisper.transcribe(wav, path_or_hf_repo=model_id, **opts)
                words += t._chunk_words(a, r)
                os.unlink(wav)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        return words
    tag = f"ref|{cond}|{vocab}|{REF_MAX}|{model_id}"
    return _cache(path, tag, produce)


def check_reference_recall(ref_words, merged, silences):
    """Diff reference vs pipeline token streams; a run of >=2 reference content
    tokens missing from the pipeline, not inside a silence, is a dropout event."""
    def toks(ws):
        return [(_norm(w["word"]), (w["start"] + w["end"]) / 2) for w in ws if _norm(w["word"])]
    ref = toks(ref_words)
    pipe = toks(merged)
    sm = difflib.SequenceMatcher(a=[x[0] for x in ref], b=[x[0] for x in pipe], autojunk=False)
    events = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op in ("delete", "replace"):
            run = ref[i1:i2]
            content = [x for x in run if len(x[0]) >= 3 and x[0] not in _STOP]
            if len(content) >= 2:
                mid = content[len(content) // 2][1]
                in_sil = any(s <= mid <= e for (s, e) in silences)
                if not in_sil:
                    events.append((content[0][1], " ".join(x[0] for x in content)))
    return events


# ---------------------------------------------------------------- report
def audit_file(path, args, ff):
    name = os.path.basename(path)
    print(f"\n{'=' * 70}\nAUDIT  {name}")
    chunk_len, overlap = args.chunk, args.overlap
    model_id = _MODELS[args.model]
    dur, results = transcribe_chunks(path, args.cond, args.vocab, chunk_len, overlap, model_id, ff)
    print(f"  duration {dur:.0f}s   chunks {len(results)}   "
          f"cond_prev={args.cond}   vocab={'yes' if args.vocab else 'no'}")

    inv_fails, cuts, per, merged = check_invariants(results, overlap)
    print(f"\n  CHECK 1 merge invariants: {'PASS' if not inv_fails else 'FAIL'}")
    for f in inv_fails:
        print(f"      - {f}")

    seam_drops = check_overlap_recall(per, results, cuts, merged, overlap)
    print(f"  CHECK 2 overlap cross-validation: "
          f"{'PASS' if not seam_drops else f'{len(seam_drops)} SEAM DROPOUT(S)'}")
    for ts, w in seam_drops:
        print(f"      - {int(ts) // 60}:{int(ts) % 60:02d}  dropped {w!r}")

    ref_events = []
    if args.deep:
        sil = t.detect_silences(path, ff)
        # Reference is always the highest-recall transcription (context carried,
        # no vocab bias), so CHECK 3 measures ABSOLUTE words the pipeline lost —
        # not just divergence from a same-config reference.
        ref = build_reference(path, True, "", model_id, ff)
        ref_events = check_reference_recall(ref, merged, sil)
        print(f"  CHECK 3 reference recall: "
              f"{'PASS' if not ref_events else f'{len(ref_events)} DROPOUT EVENT(S)'}")
        for ts, w in ref_events[:25]:
            print(f"      - {int(ts) // 60}:{int(ts) % 60:02d}  missing ~ {w!r}")
        if len(ref_events) > 25:
            print(f"      … and {len(ref_events) - 25} more")

    ok = not inv_fails and not seam_drops and not ref_events
    print(f"\n  RESULT: {'CLEAN' if ok else 'ISSUES FOUND'}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--cond", dest="cond", action="store_true", default=True,
                    help="condition_on_previous_text=True (default)")
    ap.add_argument("--no-cond", dest="cond", action="store_false")
    ap.add_argument("--vocab", default="")
    ap.add_argument("--chunk", type=float, default=300.0)
    ap.add_argument("--overlap", type=float, default=10.0)
    ap.add_argument("--model", choices=list(_MODELS), default="turbo")
    ap.add_argument("--deep", action="store_true", help="run CHECK 3 (builds a reference; ~2x time)")
    args = ap.parse_args()

    ff = t._ffbin("ffmpeg", None)
    all_ok = True
    for p in args.files:
        all_ok = audit_file(p, args, ff) and all_ok
    print(f"\n{'=' * 70}\nOVERALL: {'ALL CLEAN' if all_ok else 'ISSUES FOUND'}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
