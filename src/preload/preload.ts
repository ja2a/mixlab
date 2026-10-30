import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { MixlabApi } from '../shared/api';

function on<T>(channel: string, cb: (e: T) => void): () => void {
  const h = (_: unknown, e: T) => cb(e);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: MixlabApi = {
  info: () => ipcRenderer.invoke('app:info'),
  pickAudioFiles: () => ipcRenderer.invoke('library:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  inspectFiles: (paths) => ipcRenderer.invoke('library:inspect', paths),
  analyze: (jobs) => ipcRenderer.invoke('analysis:start', jobs),
  onAnalysisProgress: (cb) => on('analysis:progress', cb),
  onAnalysisDone: (cb) => on('analysis:done', cb),
  onAnalysisError: (cb) => on('analysis:error', cb),

  previewStart: (plan, frame) => ipcRenderer.invoke('preview:start', plan, frame),
  previewChunk: (session, frames) => ipcRenderer.invoke('preview:chunk', session, frames),
  previewStop: (session) => ipcRenderer.invoke('preview:stop', session),

  pickExportPath: (name, format) => ipcRenderer.invoke('export:pick', name, format),
  exportStart: (plan, opts) => ipcRenderer.invoke('export:start', plan, opts),
  exportCancel: (id) => ipcRenderer.invoke('export:cancel', id),
  onExportProgress: (cb) => on('export:progress', cb),
  onExportDone: (cb) => on('export:done', cb),
  onExportError: (cb) => on('export:error', cb),

  saveProject: (project, path) => ipcRenderer.invoke('project:save', project, path),
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  relink: (missing) => ipcRenderer.invoke('project:relink', missing),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  setDirty: (dirty) => ipcRenderer.send('app:dirty', dirty),
  closeNow: () => ipcRenderer.send('app:close-now'),
  onMenu: (cb) => on('menu', cb),
};

contextBridge.exposeInMainWorld('mixlab', api);
