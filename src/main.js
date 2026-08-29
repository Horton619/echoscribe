'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// EchoScribe — Electron main process.
//
// Adapted from SlideFluid's main process. Same three-part architecture:
//   • BrowserWindow + auto-updater (electron-updater).
//   • SettingsStore (persisted JSON in userData) + rotating Logger.
//   • TranscriptionJob — spawns the Python backend, parses NDJSON line-by-line,
//     forwards every event to the renderer on `transcription:message`.
//
// ⚠ CLI flags + NDJSON types are a three-way contract (this file + backend
//   transcribe.py + renderer app.js). See docs/IPC.md.
//
// Key invariants:
//   • Every backend → renderer message goes through `_handleMessage` (mirrors
//     warn/error into the log for post-mortem diagnosis). Don't bypass it.
//   • Settings reads/writes go through SettingsStore only.
//   • Auto-updater is a no-op in dev (`!app.isPackaged`).
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.setName('EchoScribe');   // namespaces userData/log under EchoScribe/ in dev too
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Accepted media. ffmpeg decodes all of these (audio is auto-extracted from
// video containers — no stripping step needed). One source of truth shared by
// the file picker and the drag-drop scanner.
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'caf', 'amr'];
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts'];
const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS];
const SUPPORTED_MEDIA = new RegExp('\\.(' + MEDIA_EXTS.join('|') + ')$', 'i');

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

class SettingsStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'echoscribe-settings.json');
    this._data = this._load();
  }

  _defaults() {
    return {
      outputDir: null,
      model: 'mlx-community/whisper-large-v3-turbo',
      chunkLength: 1200,           // seconds (~20 min)
      overlap: 10,                 // seconds
      vocabHint: '',               // passed as --initial-prompt
      language: '',                // '' = auto-detect
      outputTxt: true,
      outputSrt: true,
      autoOpenOnComplete: true,
      skin: 'professional',        // professional | fun
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return Object.assign(this._defaults(), JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      }
    } catch (e) {
      console.warn('Settings load failed, using defaults:', e.message);
    }
    return this._defaults();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
    } catch (e) {
      console.error('Settings save failed:', e.message);
    }
  }

  get(key) { return this._data[key]; }
  set(key, value) { this._data[key] = value; this.save(); }
  getAll() { return { ...this._data }; }
  setAll(obj) { Object.assign(this._data, obj); this.save(); }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this._rotate();
    } catch (_) {}
  }

  _rotate() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      if (fs.statSync(this.filePath).size > 2 * 1024 * 1024) {
        const old = this.filePath + '.1';
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(this.filePath, old);
      }
    } catch (_) {}
  }

  _write(level, msg) {
    try {
      fs.appendFileSync(this.filePath, `[${new Date().toISOString()}] [${level}] ${msg}\n`, 'utf8');
    } catch (_) {}
  }

  info(msg)  { this._write('INFO',  String(msg)); }
  warn(msg)  { this._write('WARN',  String(msg)); }
  error(msg) { this._write('ERROR', String(msg)); }

  getTail(n = 100) {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean).slice(-n);
    } catch (e) {
      return [`[Logger read error: ${e.message}]`];
    }
  }
}

function log(level, msg) {
  if (global.logger) global.logger[level](msg);
  else console[level === 'info' ? 'log' : level](msg);
}

// ---------------------------------------------------------------------------
// Path resolution (dev vs packaged)
// ---------------------------------------------------------------------------

function resolvePythonBackend() {
  // Packaged: PyInstaller onedir bundle at resources/backend/transcribe/transcribe.
  // Dev: null → venv python + script.
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'transcribe.exe' : 'transcribe';
    return path.join(process.resourcesPath, 'backend', 'transcribe', exe);
  }
  return null;
}

function resolveBackendScript() {
  return path.join(__dirname, '..', 'backend', 'transcribe.py');
}

function devPython() {
  const venv = path.join(__dirname, '..', 'venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}

// ffmpeg: dev relies on PATH (Homebrew). Packaged will point at a vendored
// binary (phase 2). null → backend uses PATH.
function resolveFfmpegDir() {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'ffmpeg');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// Spawn the backend (packaged binary or dev python+script) with extra args.
function spawnBackend(extraArgs) {
  const backendExe = resolvePythonBackend();
  if (backendExe) return spawn(backendExe, extraArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  return spawn(devPython(), [resolveBackendScript(), ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
}

// ---------------------------------------------------------------------------
// TranscriptionJob
// ---------------------------------------------------------------------------

class TranscriptionJob {
  constructor(opts) {
    Object.assign(this, opts);   // files, outputDir, model, chunkLength, overlap,
                                 // vocabHint, language, formats, win, and (multitrack)
                                 // multitrack, speakers, sessionName, perSpeaker
    this.proc = null;
    this.cancelled = false;
  }

  _buildArgs() {
    const args = [
      '--ipc',
      '--model', this.model,
      '--chunk-length', String(this.chunkLength),
      '--overlap', String(this.overlap),
      '--formats', this.formats,
      '--output-dir', this.outputDir,
    ];
    if (this.vocabHint) args.push('--initial-prompt', this.vocabHint);
    if (this.language)  args.push('--language', this.language);
    if (this.multitrack) {
      args.push('--multitrack');
      args.push('--speakers', JSON.stringify(this.speakers || []));
      args.push('--session-name', this.sessionName || 'session');
      if (this.perSpeaker) args.push('--per-speaker');
      args.push('--script-timestamps', this.scriptTimestamps === false ? 'no' : 'yes');
    }
    const ffmpegDir = resolveFfmpegDir();
    if (ffmpegDir) args.push('--ffmpeg-path', ffmpegDir);
    args.push(...this.files);
    return args;
  }

  start() {
    const args = this._buildArgs();
    log('info', `spawn backend: ${args.slice(0, 8).join(' ')} … (${this.files.length} file(s))`);
    this.proc = spawnBackend(args);

    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { this._handleMessage(JSON.parse(line)); }
        catch (_) { log('warn', `non-JSON stdout: ${line}`); }
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        log('warn', `python stderr: ${text}`);
        this._send('transcription:stderr', { message: text });
      }
    });

    this.proc.on('close', (code, signal) => {
      log('info', `python exited: code=${code} signal=${signal}`);
      this._send('transcription:exit', { code, signal, cancelled: this.cancelled });
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      log('error', `spawn error: ${err.message}`);
      this._send('transcription:spawn_error', { message: err.message });
    });
  }

  cancel() {
    if (this.proc) {
      this.cancelled = true;
      this.proc.kill('SIGTERM');
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'error')      log('error', `[backend error] ${msg.file || ''}: ${msg.message || ''}`);
    else if (msg.type === 'warn')  log('warn',  `[backend warn] ${msg.file || ''}: ${msg.message || ''}`);
    this._send('transcription:message', msg);
  }

  _send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function runPreflight(win) {
  const proc = spawnBackend(['--preflight', '--ipc']);
  let output = '';
  proc.stdout.on('data', (d) => (output += d.toString()));
  proc.stderr.on('data', (d) => log('warn', `preflight stderr: ${d.toString().trim()}`));
  proc.on('close', (code) => {
    let results = null;
    for (const line of output.split('\n')) {
      try {
        const msg = JSON.parse(line.trim());
        if (msg.type === 'preflight_result') { results = msg.results; break; }
      } catch (_) {}
    }
    const outputDir = global.settings ? global.settings.get('outputDir') : null;
    if (results) {
      results.output_folder = checkOutputFolderWritable(outputDir);
      results.disk_space = checkDiskSpace(outputDir);
      results.app_version = { ok: true, message: `v${app.getVersion()} — ${process.platform} ${process.arch}` };
    }
    if (win && !win.isDestroyed()) win.webContents.send('preflight:result', { results, exitCode: code });
  });
  proc.on('error', (err) => {
    if (win && !win.isDestroyed()) win.webContents.send('preflight:result', { results: null, error: err.message });
  });
}

function checkOutputFolderWritable(dir) {
  if (!dir) return { ok: false, message: 'No output folder configured' };
  try {
    const testFile = path.join(dir, `.echoscribe_write_test_${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true, message: dir };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function checkDiskSpace(dir) {
  if (!dir) return { ok: false, message: 'No output folder configured' };
  try {
    if (typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(dir);
      const freeMB = Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
      const ok = freeMB >= 500;
      return { ok, message: `${freeMB} MB free${ok ? '' : ' — WARNING: low disk space'}` };
    }
    return { ok: true, message: 'Disk space check unavailable on this platform' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;
let currentJob = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: '#070910',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    if (currentJob) currentJob.cancel();
    mainWindow = null;
  });

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => log('warn', `Launch update check failed: ${err.message}`));
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  global.logger = new Logger(path.join(app.getPath('userData'), 'echoscribe.log'));
  global.logger.info(`--- EchoScribe ${app.getVersion()} started (${process.platform} ${process.arch}) ---`);
  global.settings = new SettingsStore();
  global.logger.info(`Settings loaded from ${global.settings.filePath}`);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => { if (global.logger) global.logger.info('App quitting'); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// --- Settings ---
ipcMain.handle('settings:getAll', () => global.settings.getAll());
ipcMain.handle('settings:set', (e, key, value) => { global.settings.set(key, value); return true; });
ipcMain.handle('settings:setAll', (e, obj) => { global.settings.setAll(obj); return true; });

// --- File dialogs ---
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select audio or video files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio / Video', extensions: MEDIA_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:openFolder', async (e, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder',
    defaultPath: defaultPath || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  global.settings.set('outputDir', result.filePaths[0]);
  return result.filePaths[0];
});

// --- Shell ---
ipcMain.handle('shell:openFolder', (e, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) { shell.openPath(folderPath); return true; }
  return false;
});

// Reveal a specific file in Finder (selects it).
ipcMain.handle('shell:revealFile', (e, filePath) => {
  if (filePath && fs.existsSync(filePath)) { shell.showItemInFolder(filePath); return true; }
  return false;
});

// --- Media scan: expand files/folders → flat list of supported media ---
ipcMain.handle('media:scan', async (e, itemPaths) => {
  function scanDir(dir) {
    const out = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...scanDir(full));
        else if (SUPPORTED_MEDIA.test(entry.name)) out.push(full);
      }
    } catch (_) {}
    return out.sort();
  }
  const result = [];
  const skipped = [];      // directly-dropped files that aren't media
  const seen = new Set();
  for (const p of itemPaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        for (const f of scanDir(p)) if (!seen.has(f)) { seen.add(f); result.push(f); }
      } else if (SUPPORTED_MEDIA.test(p)) {
        if (!seen.has(p)) { seen.add(p); result.push(p); }
      } else {
        skipped.push(path.basename(p));
      }
    } catch (_) {}
  }
  return { files: result, skipped };
});

// --- Media probe: duration + planned chunk count for one file ---
ipcMain.handle('media:probe', async (e, filePath, chunkLength, overlap) => {
  const args = ['--probe', filePath, '--ipc',
    '--chunk-length', String(chunkLength ?? 1200), '--overlap', String(overlap ?? 10)];
  const ffmpegDir = resolveFfmpegDir();
  if (ffmpegDir) args.push('--ffmpeg-path', ffmpegDir);
  return new Promise((resolve) => {
    let output = '';
    const proc = spawnBackend(args);
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => log('warn', `probe stderr: ${d.toString().trim()}`));
    proc.on('close', () => {
      for (const line of output.split('\n')) {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === 'probe_result') { resolve(msg); return; }
        } catch (_) {}
      }
      resolve({ ok: false, error: 'No probe_result from backend' });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// --- Transcription ---
ipcMain.handle('transcription:start', async (e, payload) => {
  if (currentJob) return { ok: false, error: 'A transcription is already running.' };
  const {
    files, outputDir, model, chunkLength, overlap, vocabHint, language, formats,
    multitrack, speakers, sessionName, perSpeaker, scriptTimestamps,
  } = payload;

  const folderCheck = checkOutputFolderWritable(outputDir);
  if (!folderCheck.ok) return { ok: false, error: `Output folder not writable: ${folderCheck.message}` };

  currentJob = new TranscriptionJob({
    files, outputDir, model,
    chunkLength: chunkLength ?? 1200,
    overlap: overlap ?? 10,
    vocabHint: vocabHint || '',
    language: language || '',
    formats: formats || 'txt,srt',
    multitrack: !!multitrack,
    speakers: speakers || [],
    sessionName: sessionName || 'session',
    perSpeaker: perSpeaker !== false,
    scriptTimestamps: scriptTimestamps !== false,
    win: mainWindow,
  });
  currentJob.start();
  return { ok: true };
});

ipcMain.handle('transcription:cancel', () => {
  if (currentJob) { currentJob.cancel(); currentJob = null; return true; }
  return false;
});

ipcMain.on('transcription:jobDone', () => { currentJob = null; });

// --- Preflight ---
ipcMain.handle('preflight:run', () => { runPreflight(mainWindow); return true; });

// --- Model management (pre-cache for offline use) ---
ipcMain.handle('models:status', async () => {
  return new Promise((resolve) => {
    let output = '';
    const proc = spawnBackend(['--models-status', '--ipc']);
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => log('warn', `models:status stderr: ${d.toString().trim()}`));
    proc.on('close', () => {
      for (const line of output.split('\n')) {
        try { const m = JSON.parse(line.trim()); if (m.type === 'models_status') { resolve(m.models); return; } }
        catch (_) {}
      }
      resolve(null);
    });
    proc.on('error', () => resolve(null));
  });
});

let modelsProc = null;
ipcMain.handle('models:download', () => {
  if (modelsProc) return { ok: false, error: 'A download is already running.' };
  modelsProc = spawnBackend(['--download-models', '--ipc']);
  let buf = '';
  const send = (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('models:progress', payload); };
  modelsProc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { send(JSON.parse(line)); } catch (_) {}
    }
  });
  modelsProc.stderr.on('data', (d) => log('info', `models download: ${d.toString().trim()}`));
  modelsProc.on('close', () => { modelsProc = null; send({ type: 'models_done' }); });
  modelsProc.on('error', (err) => { modelsProc = null; send({ type: 'model_download', state: 'error', message: err.message }); });
  return { ok: true };
});

// --- Log ---
ipcMain.handle('log:getPath', () => global.logger ? global.logger.filePath : null);
ipcMain.handle('log:getTail', (e, n) => global.logger ? global.logger.getTail(n || 100) : []);
ipcMain.handle('log:openFile', () => {
  if (global.logger && fs.existsSync(global.logger.filePath)) { shell.openPath(global.logger.filePath); return true; }
  return false;
});

// --- App info ---
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:getPlatform', () => ({ platform: process.platform, arch: process.arch, version: app.getVersion() }));

// ---------------------------------------------------------------------------
// Auto-updater (no-op in dev)
// ---------------------------------------------------------------------------

const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = {
  info:  (m) => log('info',  `[updater] ${m}`),
  warn:  (m) => log('warn',  `[updater] ${m}`),
  error: (m) => log('error', `[updater] ${m}`),
  debug: () => {},
};

let _userOptedToDownload = false;
let _pendingUpdateVersion = null;

function _sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', payload);
}

autoUpdater.on('checking-for-update', () => _sendUpdateStatus({ state: 'checking' }));
autoUpdater.on('update-not-available', (info) => _sendUpdateStatus({ state: 'current', version: info?.version || app.getVersion() }));
autoUpdater.on('update-available', async (info) => {
  _pendingUpdateVersion = info.version;
  _sendUpdateStatus({ state: 'available', version: info.version });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update available', message: `EchoScribe ${info.version} is available.`,
    detail: 'A new version is ready to download. The current version keeps working until you install.',
  });
  if (response === 0) {
    _userOptedToDownload = true;
    autoUpdater.downloadUpdate().catch((err) => {
      log('warn', `Update download failed: ${err.message}`);
      _sendUpdateStatus({ state: 'error', message: err.message });
    });
  }
});
autoUpdater.on('download-progress', (p) => _sendUpdateStatus({ state: 'downloading', percent: Math.round(p.percent || 0), version: _pendingUpdateVersion }));
autoUpdater.on('update-downloaded', async (info) => {
  _sendUpdateStatus({ state: 'ready', version: info.version });
  if (!mainWindow || mainWindow.isDestroyed() || !_userOptedToDownload) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['Restart and install', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update ready', message: `EchoScribe ${info.version} is ready to install.`,
    detail: 'Restart now to apply the update. The app reopens automatically.',
  });
  if (response === 0) autoUpdater.quitAndInstall();
});
autoUpdater.on('error', (err) => {
  log('warn', `Auto-updater error: ${err?.message || err}`);
  _sendUpdateStatus({ state: 'error', message: err?.message || String(err) });
});

ipcMain.handle('update:check', async () => {
  try { await autoUpdater.checkForUpdates(); return true; }
  catch (err) { _sendUpdateStatus({ state: 'error', message: err?.message || String(err) }); return false; }
});
ipcMain.handle('update:download', async () => {
  try { _userOptedToDownload = true; await autoUpdater.downloadUpdate(); return true; }
  catch (err) { _sendUpdateStatus({ state: 'error', message: err?.message || String(err) }); return false; }
});
ipcMain.on('update:install', () => autoUpdater.quitAndInstall());
