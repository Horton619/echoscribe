# EchoScribe

Local audio/video → text transcription for Apple Silicon. Fully offline — uses
[`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
(local Whisper on the Apple Neural Engine / GPU), no cloud API.

Built by Visual Entropy Productions. Modeled on SlideFluid's Electron +
Python-subprocess architecture.

## Two modes

**Batch** — drop N audio/video files, get N transcripts (`.txt` + `.srt` each).

**Multitrack** — *diarization by hardware.* Drop 2–6 mic tracks recorded
together on one multitrack recorder (so they share a clock), name each speaker,
and get **one merged script** with speaker labels in timestamp order:

```
[00:01:23] Dave: …
[00:01:30] Sarah: …
```

An auto-mixer gate keeps only the loudest mic open at each moment (killing
bleed at the source), then a similarity+energy dedup at merge catches anything
that slips through. Outputs: `<session>_script.txt`, a speaker-prefixed
`<session>_script.srt`, and each track's own transcript. The script `.txt` can
be delivered **with or without timestamps** (a clean reading script:
`Name: …`) — toggle in the Output panel.

## The long-file bug (why we chunk)

`mlx-whisper` can hang and repeat the same sentence for minutes on files over
~20 min. EchoScribe never feeds it a long file whole: it splits into ~20-min
chunks with ~10 s overlap (ffmpeg), transcribes each with hallucination-resistant
decode params, and merges to one continuous timeline. Pattern mirrors
[mlx-whisper-long](https://github.com/1c7/mlx-whisper-long).

## Requirements

- Apple Silicon Mac
- `ffmpeg` + `ffprobe` on PATH (`brew install ffmpeg`)
- Python 3.11 venv with `mlx-whisper` (see below)

## Dev setup

```bash
# Python backend (venv on 3.11 — mlx-whisper lives there, not Homebrew's 3.14)
/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m venv venv
./venv/bin/pip install mlx-whisper

# Electron shell
npm install
npm start
```

### ⚠ First `npm start` on modern macOS: "malware blocked / moved to trash"

macOS Sequoia (Gatekeeper/XProtect) **trashes** the unsigned, quarantined
Electron binary that npm downloads into `node_modules`. It is not malware — it's
stock Electron. Fix it once, in dev, by de-quarantining and ad-hoc signing the
local binary:

```bash
xattr -cr node_modules/electron/dist/Electron.app
codesign --force --deep --sign - node_modules/electron/dist/Electron.app
```

If the binary was already trashed, re-extract it first:

```bash
ZIP=$(find "$HOME/Library/Caches/electron" -name '*.zip' | head -1)
rm -rf node_modules/electron/dist && mkdir node_modules/electron/dist
( cd node_modules/electron/dist && unzip -q "$ZIP" )
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
# then the xattr + codesign above
```

The shipped app won't hit this — it'll be Developer-ID signed + notarized
(phase 2), which Gatekeeper accepts.

## The models & offline use

Models download from Hugging Face on first use, then cache:

- `mlx-community/whisper-large-v3-turbo` — default, fast, great quality (~1.5 GB)
- `mlx-community/whisper-large-v3-mlx` — max accuracy, slower (~3 GB)

**Going offline?** Settings → Diagnostics → **Download models for offline use**
pre-caches both (~4.5 GB) so the app works with no wifi. A first-launch banner
nudges you to do this while you still have a connection. ffmpeg and the mlx
engine are built into the app — the models are the only runtime download.

Preflight (Diagnostics) runs a real **transcription smoke test** on a bundled
verified clip (JFK excerpt) when a model is cached — a true end-to-end check,
not just an import test.

## Roadmap

- **Phase 2** — signed/notarized DMG + auto-update (reuses the VEP recipe).
  - ✅ *Spike done:* the PyInstaller **onedir** backend (`backend/transcribe.spec`)
    bundles mlx's Metal libs and runs real transcription frozen. Build with
    `cd backend && ../venv/bin/pyinstaller --clean transcribe.spec`.
  - ⏳ *Remaining:* vendor static `ffmpeg`/`ffprobe` into the app (dev still uses
    Homebrew PATH), add the arm64 startup gate, wire `.github/workflows/release.yml`
    on an arm64 runner (`macos-14`), decide model-delivery (bundle turbo vs
    download-on-first-run).
- **v2 diarization** — for *single-track* content that wasn't multitracked, a
  `whisperx-mlx` speaker pass (needs a HF token). The backend `merge()` seam is
  left uncoupled so this slots in without reshaping the pipeline. For live
  events, multitrack mode is the better tool and needs no token.
