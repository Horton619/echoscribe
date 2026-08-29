# -*- mode: python ; coding: utf-8 -*-
# EchoScribe backend — PyInstaller spec (onedir).
#
# onedir (not onefile) on purpose: mlx ships a ~178MB mlx.metallib plus ~24MB of
# dylibs. onefile would re-extract all of that to a temp dir on every launch
# (slow, wasteful). onedir keeps it on disk next to the binary — fast startup and
# mlx's dylib finds its metallib at the expected relative path (mlx/lib/).
#
# The collect_all() hooks pull most of mlx/mlx_whisper, but mlx is a namespace
# package (mlx.__file__ is None), so we ALSO force-add the Metal libs explicitly
# to guarantee they land at mlx/lib/ — that's where core.*.so expects them.

import os
from PyInstaller.utils.hooks import collect_all
import mlx.core

datas, binaries, hiddenimports = [], [], []
for pkg in ("mlx", "mlx_whisper", "tiktoken", "tiktoken_ext", "huggingface_hub"):
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hiddenimports += h
    except Exception:
        pass

# Verified smoke-test clip used by --preflight (jfk.flac → assets/ in bundle).
datas += [(os.path.join(SPECPATH, "assets", "jfk.flac"), "assets")]

# Belt-and-suspenders: mlx's Metal libs, placed at mlx/lib/ in the bundle.
_mlx_lib = os.path.join(os.path.dirname(mlx.core.__file__), "lib")
datas += [(os.path.join(_mlx_lib, "mlx.metallib"), "mlx/lib")]
binaries += [
    (os.path.join(_mlx_lib, "libmlx.dylib"), "mlx/lib"),
    (os.path.join(_mlx_lib, "libjaccl.dylib"), "mlx/lib"),
]

a = Analysis(
    ['transcribe.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,       # onedir
    name='transcribe',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                   # UPX + signed dylibs don't mix; keep off
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch='arm64',
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='transcribe',
)
