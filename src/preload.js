'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// EchoScribe — Preload (contextBridge surface).
//
// This file IS the renderer's IPC contract. Every method maps to an
// `ipcMain.handle` in main.js; event listeners map to `webContents.send` sites.
// ⚠ See docs/IPC.md before adding or renaming anything on `window.echoscribe`.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

function makeListener(channel) {
  return (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('echoscribe', {

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  setSettings: (obj) => ipcRenderer.invoke('settings:setAll', obj),

  // --- File / folder dialogs ---
  openFilePicker: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolderPicker: (defaultPath) => ipcRenderer.invoke('dialog:openFolder', defaultPath),

  // --- Shell ---
  openFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath),
  revealFile: (filePath) => ipcRenderer.invoke('shell:revealFile', filePath),

  // --- Media ---
  /** Expand files/folders → { files: string[], skipped: string[] } (skipped = dropped non-media basenames). */
  scanPaths: (paths) => ipcRenderer.invoke('media:scan', paths),
  /** Duration + planned chunk count for one file: {ok, duration, chunks}. */
  probeMedia: (filePath, chunkLength, overlap) =>
    ipcRenderer.invoke('media:probe', filePath, chunkLength, overlap),

  // --- Transcription ---
  /**
   * Start a batch OR multitrack transcription.
   * payload.batch:      { files, outputDir, model, chunkLength, overlap, vocabHint, language, formats }
   * payload.multitrack: same + { multitrack:true, speakers:[], sessionName, perSpeaker:true }
   * The renderer sets multitrack fields only in multitrack mode.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  startTranscription: (payload) => ipcRenderer.invoke('transcription:start', payload),
  cancelTranscription: () => ipcRenderer.invoke('transcription:cancel'),
  notifyJobDone: () => ipcRenderer.send('transcription:jobDone'),

  // --- Transcription events (subscribe returns an unsubscribe fn) ---
  /** Each NDJSON line from the backend: {type:'media_info'|'start'|'progress'|'done'|'warn'|'error'|'batch_done', ...} */
  onTranscriptionMessage: makeListener('transcription:message'),
  onTranscriptionStderr: makeListener('transcription:stderr'),
  onTranscriptionExit: makeListener('transcription:exit'),
  onTranscriptionSpawnError: makeListener('transcription:spawn_error'),

  // --- Preflight ---
  runPreflight: () => ipcRenderer.invoke('preflight:run'),
  onPreflightResult: makeListener('preflight:result'),

  // --- Model management (pre-cache for offline use) ---
  /** Returns [{repo, label, cached}] or null. */
  getModelsStatus: () => ipcRenderer.invoke('models:status'),
  /** Start downloading all models. Progress arrives via onModelsProgress. */
  downloadModels: () => ipcRenderer.invoke('models:download'),
  /** Fired per model: {type:'model_download', repo, label, state:'downloading'|'done'|'cached'|'error'} and {type:'models_done'}. */
  onModelsProgress: makeListener('models:progress'),

  // --- Log ---
  getLogPath: () => ipcRenderer.invoke('log:getPath'),
  getLogTail: (n) => ipcRenderer.invoke('log:getTail', n || 100),
  openLogFile: () => ipcRenderer.invoke('log:openFile'),

  // --- App info ---
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),

  // --- Auto-updater ---
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateStatus: makeListener('update:status'),

  // --- Review & Polish window ---
  review: {
    /** Open (or re-point) the Review window to a specific review doc. */
    open: (docPath) => ipcRenderer.invoke('review:open', docPath),
    /** Path of the doc the window was opened for (call on load). */
    pending: () => ipcRenderer.invoke('review:pending'),
    /** Read + parse a review doc: {ok, doc, path}. */
    load: (docPath) => ipcRenderer.invoke('review:load', docPath),
    /** Regenerate txt/ttxt/srt from an edited doc: {ok, outputs}. */
    reexport: (doc) => ipcRenderer.invoke('review:reexport', doc),
    /** Write <base>.polish-log.txt into dir: {ok, path}. */
    writeLog: (dir, base, text) => ipcRenderer.invoke('review:writeLog', dir, base, text),
    /** Fired when a new finished file should replace the window's doc. */
    onOpenDoc: makeListener('review:opendoc'),
  },
});
