# IPC — the three-way contract

CLI flags (backend argparse) + NDJSON message types are shared across three
files. Change one, change all three:

- `backend/transcribe.py` — argparse + `_emit`
- `src/main.js` — `TranscriptionJob._buildArgs` + `_handleMessage`
- `src/renderer/app.js` — `handleMessage`

Plus `src/preload.js` exposes the renderer-facing API (`window.echoscribe`).

## Backend CLI flags

| Flag | Meaning |
|---|---|
| `--ipc` | Emit NDJSON (one JSON object per stdout line) instead of human text |
| `--output-dir DIR` | Where outputs are written |
| `--model ID` | HF repo id (turbo default) |
| `--chunk-length SEC` | Chunk size, default 1200 (20 min) |
| `--overlap SEC` | Chunk overlap, default 10 |
| `--initial-prompt TEXT` | Vocabulary hint → Whisper `initial_prompt` |
| `--language CODE` | Force language; omit to auto-detect |
| `--out-names JSON` | Array of output filename bases, one per input (batch; empty = source name) |
| `--formats txt,ttxt,srt` | Comma list of output formats (`ttxt` = timestamped text, `<base>_timestamped.txt`) |
| `--ffmpeg-path DIR` | Dir holding ffmpeg/ffprobe (else PATH) |
| `--multitrack` | Treat inputs as one speaker per aligned track |
| `--speakers JSON` | JSON array of names, one per input file |
| `--session-name NAME` | Base name for merged script |
| `--per-speaker` | Also write each track's own transcript |
| `--script-timestamps yes\|no` | `[HH:MM:SS]` prefixes in the merged script .txt (default yes) |
| `--probe FILE` | One-shot: duration + chunk plan, then exit |
| `--preflight` | One-shot: check ffmpeg + mlx-whisper + transcription smoke test, then exit |
| `--models-status` | One-shot: report which models are cached, then exit |
| `--download-models` | Download all models for offline use (streams progress), then exit |

## NDJSON message types (backend → main → renderer)

| type | key fields | when |
|---|---|---|
| `media_info` | file, duration, chunks | per file, before transcription starts |
| `start` | file, file_index, total_files; (`multitrack`, `tracks`) | per file / per session |
| `progress` | file, chunk, total_chunks, percent, message | during transcription |
| `done` | file, outputs[], segments, output_dir; (`multitrack`, `speakers`) | per file / per session |
| `warn` | message, file | non-fatal notes |
| `error` | file, message | per-file failure |
| `batch_done` | transcribed, errors | end of the whole run |
| `probe_result` | ok, duration, chunks | `--probe` only |
| `preflight_result` | results{check:{ok,message}} incl. `smoke_test` | `--preflight` only |
| `models_status` | models[{repo,label,cached}] | `--models-status` only |
| `model_download` | repo, label, state (downloading/done/cached/error), percent, downloaded, total | `--download-models`, streamed per model |
| `models_done` | — | end of `--download-models` |

`--preflight` runs a real transcription of a bundled verified clip
(`backend/assets/jfk.flac`) as `smoke_test`, but only when a model is already
cached — so preflight never triggers a multi-GB download or needs the network.

## Electron IPC channels

Renderer → main (invoke): `settings:*`, `dialog:openFiles`, `dialog:openFolder`,
`shell:openFolder`, `shell:revealFile`, `media:scan`, `media:probe`,
`transcription:start`, `transcription:cancel`, `preflight:run`, `log:*`,
`app:*`, `update:*`.

Main → renderer (send): `transcription:message` (carries every NDJSON object),
`transcription:stderr`, `transcription:exit`, `transcription:spawn_error`,
`preflight:result`, `update:status`.

## Renderer group logic

Batch mode sends all queued files in one `transcription:start`; the backend
loops them. Multitrack sends all tracks + `speakers[]` (file order) in one call
with `multitrack:true`. There is no per-file grouping like SlideFluid — the
backend handles the whole input list in a single spawn.
