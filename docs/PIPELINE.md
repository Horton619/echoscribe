# Pipeline — chunking, gating, merge

All backend logic is in `backend/transcribe.py`.

## Batch (single-track)

`process_file`:
1. `ffprobe_duration` → total seconds.
2. `plan_chunks(duration, chunk_length, overlap)` → chunks that advance by
   `chunk_length - overlap`, so each overlaps its neighbour by `overlap` s.
3. Per chunk: `extract_chunk` (ffmpeg input-seek → 16 kHz mono wav) →
   `transcribe_chunk` (mlx-whisper with `_DECODE_OPTS`).
4. `merge` — offset each chunk's segment times by its global start; at each seam
   keep the earlier chunk's segments up to the overlap **midpoint** and the later
   chunk's from the midpoint on (dedup without losing boundary words).
5. `write_txt` / `write_srt`, atomic (`_atomic_write` = temp + `os.replace`).

### `_DECODE_OPTS` — do not remove
```
condition_on_previous_text=False   # a bad chunk can't poison the next
no_speech_threshold=0.6            # skip silence instead of hallucinating
compression_ratio_threshold=2.4    # detect & discard repeat-output runs
word_timestamps=True
```
These are what make long-file output trustworthy. From mlx-whisper-long.

## Multitrack (diarization-by-hardware)

`process_multitrack`. Assumes tracks are **sample-aligned** (one recorder /
shared clock), so a segment's local time == its global time.

- **Phase A — envelopes.** `block_rms` per track (25 ms non-overlapping blocks),
  one raw track in memory at a time (envelope kept, raw freed).
- **Phase B — gate decision.** `compute_gates`: pad envelopes to a common grid,
  the loudest track above `floor` (a fraction of the session's 75th-percentile
  speech level) is the open mic per block. A winner **holds** open across short
  trailing silence (`_GATE_RELEASE`) and opens a few blocks early
  (`_GATE_PREROLL`) so word edges aren't clipped.
- **Phase C — gate + transcribe.** Reload each track, `apply_gate` (zero samples
  outside its open blocks), `chunk_and_transcribe_array` (same chunk/merge core
  but on the in-memory gated array — no temp wavs). Tag segments with speaker +
  per-segment energy.
- **Phase D — merge.** Concatenate all tracks' segments, sort by start,
  `dedup_across_tracks` (drop residual bleed: overlapping segments from different
  speakers with high text similarity → keep the louder track),
  `write_script_txt` (coalesce consecutive same-speaker turns) + `write_script_srt`
  (speaker-prefixed captions), plus per-speaker files if `--per-speaker`.

### Tunables (module constants)
`_GATE_BLOCK`, `_GATE_RELEASE`, `_GATE_PREROLL`, `_GATE_FLOOR_FRAC`,
`_GATE_FLOOR_MIN`, `_DEDUP_TIME_OVERLAP`, `_DEDUP_TEXT_RATIO`. Perfect gate
separation isn't required — the dedup is the safety net.

### Known limits
- Tracks must be aligned. Separate-recorder sync (slate/cross-correlation) is a
  future add-on.
- True simultaneous speech: the gate assigns the loudest speaker; the quieter
  overlap can be dropped.
- Very long 6-track sessions: audio is decoded twice per track (envelope, then
  gate) to bound peak memory; still ~1 raw track in memory at a time.

## v2 diarization seam
`merge()` / phase-D segments are plain `{start,end,text,speaker}` dicts. A future
`whisperx-mlx` speaker pass for single-track content slots in before the writers
without reshaping anything. Keep those steps uncoupled.
