// Electron main process: window, menus, IPC, worker orchestration.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, systemPreferences } from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findFfmpeg } from '../core/audio/ffmpeg';
import { fingerprint, isAudioFile, loadProject, relink, saveProject } from '../core/project/project';
import { COVER_FILE } from '../core/analysis/analyze';
import type { MixPlan } from '../core/mix/plan';
import type { ExportOptions } from '../core/export/exporter';
import type { InspectedFile } from '../shared/api';
import type { ProjectFile } from '../core/types';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
if (process.env.MIXLAB_USER_DATA) app.setPath('userData', process.env.MIXLAB_USER_DATA);
const cacheRoot = () => path.join(app.getPath('userData'), 'cache');
const bundledFfmpegDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin') : undefined);
const workerFile = path.join(__dirname, 'workers.js');

protocol.registerSchemesAsPrivileged([{ scheme: 'mixlab-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win: BrowserWindow | null = null;
let dirty = false;
let forceClose = false;

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    title: 'MixLab',
    backgroundColor: mac ? '#00000000' : '#0b0b0f',
    ...(mac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 19 }, vibrancy: 'under-window' as const, visualEffectState: 'active' as const, transparent: true }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: '#e8e8ef', height: 52 }, backgroundMaterial: 'acrylic' as const }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  nativeTheme.themeSource = 'dark';
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (dirty && !forceClose) {
      e.preventDefault();
      const r = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        buttons: ['Enregistrer…', 'Ne pas enregistrer', 'Annuler'],
        defaultId: 0,
        cancelId: 2,
        message: 'Enregistrer les modifications du projet ?',
        detail: 'Vos modifications seront perdues si vous ne les enregistrez pas.',
      });
      if (r === 0) win?.webContents.send('menu', 'save-and-close');
      else if (r === 1) { forceClose = true; win?.close(); }
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.VITE_DEV_SERVER_URL ?? 'file://')) e.preventDefault();
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function sendMenu(cmd: string) { win?.webContents.send('menu', cmd); }

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Fichier',
      submenu: [
        { label: 'Nouveau projet', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Ouvrir un projet…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: 'Enregistrer', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Enregistrer sous…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: 'Importer des morceaux…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
        { label: 'Exporter la mixtape…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
        ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'Quitter' }]),
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Lecture',
      submenu: [
        { label: 'Lecture / Pause', accelerator: 'Space', registerAccelerator: false, click: () => sendMenu('play') },
        { label: 'Générer une mixtape', accelerator: 'CmdOrCtrl+G', click: () => sendMenu('generate') },
      ],
    },
    {
      label: 'Présentation',
      submenu: [
        { role: 'togglefullscreen', label: 'Plein écran' },
        ...(isDev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu', label: 'Fenêtre' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- analysis pool ----------

type AnalysisJob = { id: string; path: string; cacheDir: string };
const queue: AnalysisJob[] = [];
const idle: Worker[] = [];
const busy = new Set<Worker>();

function spawnWorker(role: string, extra: Record<string, unknown> = {}) {
  return new Worker(workerFile, { workerData: { role, ffmpegDir: bundledFfmpegDir(), ...extra } });
}

function pump() {
  while (queue.length && idle.length) {
    const w = idle.pop()!;
    const job = queue.shift()!;
    busy.add(w);
    w.postMessage(job);
  }
}

function initPool() {
  const n = Math.max(1, Math.min(4, os.cpus().length - 2));
  for (let i = 0; i < n; i++) {
    const w = spawnWorker('analysis');
    w.on('message', (m: any) => {
      if (m.type === 'progress') win?.webContents.send('analysis:progress', { id: m.id, progress: m.progress, stage: m.stage });
      else {
        if (m.type === 'done') {
          const cover = path.join(m.cacheDir, COVER_FILE);
          win?.webContents.send('analysis:done', {
            id: m.id, meta: m.meta, analysis: m.analysis, cacheDir: m.cacheDir, fromCache: m.fromCache,
            coverUrl: m.meta.hasArtwork && fs.existsSync(cover) ? `mixlab-media://cache/${path.basename(m.cacheDir)}/${COVER_FILE}` : null,
          });
        } else if (m.type === 'error') win?.webContents.send('analysis:error', { id: m.id, error: m.error });
        busy.delete(w);
        idle.push(w);
        pump();
      }
    });
    w.on('error', (e) => console.error('analysis worker', e));
    idle.push(w);
  }
}

// ---------- preview ----------

let preview: Worker | null = null;
let reqSeq = 0;
const pending = new Map<number, (m: any) => void>();
function previewWorker() {
  if (preview) return preview;
  preview = spawnWorker('preview');
  preview.on('message', (m: any) => {
    const r = pending.get(m.reqId);
    if (r) { pending.delete(m.reqId); r(m); }
  });
  preview.on('error', (e) => { console.error('preview worker', e); preview = null; for (const r of pending.values()) r({ type: 'error', error: String(e) }); pending.clear(); });
  return preview;
}
function previewCall(msg: any): Promise<any> {
  const reqId = ++reqSeq;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    previewWorker().postMessage({ ...msg, reqId });
  });
}

// ---------- exports ----------

const exports = new Map<number, Worker>();
let exportSeq = 0;

// ---------- IPC ----------

function walkAudio(p: string, out: string[], depth = 0) {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { out.push(p); return; }
  if (st.isDirectory()) {
    if (depth > 6) return;
    for (const e of fs.readdirSync(p)) if (!e.startsWith('.')) walkAudio(path.join(p, e), out, depth + 1);
  } else if (isAudioFile(p) || depth === 0) out.push(p);
}

function registerIpc() {
  ipcMain.handle('app:info', () => {
    let ffmpeg: any;
    try { const f = findFfmpeg(bundledFfmpegDir() ? [bundledFfmpegDir()!] : []); ffmpeg = { ok: true, path: f.ffmpeg, soxr: f.soxr }; }
    catch (e: any) { ffmpeg = { ok: false, error: e.message }; }
    return {
      version: app.getVersion(), platform: process.platform, ffmpeg, cacheDir: cacheRoot(),
      reducedMotion: process.platform === 'darwin' ? systemPreferences.getAnimationSettings().prefersReducedMotion : false,
    };
  });

  ipcMain.handle('library:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Importer des morceaux',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'aif', 'aiff', 'ogg', 'opus'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('library:inspect', (_e, paths: string[]): InspectedFile[] => {
    const files: string[] = [];
    for (const p of paths) walkAudio(p, files);
    return files.map((p) => {
      const fileName = path.basename(p);
      if (!isAudioFile(p)) return { path: p, fileName, size: 0, fingerprint: '', error: 'Format non pris en charge' };
      try {
        const fp = fingerprint(p);
        if (fp.size === 0) return { path: p, fileName, size: 0, fingerprint: '', error: 'Fichier vide' };
        return { path: p, fileName, ...fp };
      } catch (e: any) {
        return { path: p, fileName, size: 0, fingerprint: '', error: 'Fichier illisible : ' + e.message };
      }
    });
  });

  ipcMain.handle('analysis:start', (_e, jobs: Array<{ id: string; path: string; fingerprint: string }>) => {
    for (const j of jobs) queue.push({ id: j.id, path: j.path, cacheDir: path.join(cacheRoot(), j.fingerprint) });
    pump();
  });

  ipcMain.handle('preview:start', async (_e, plan: MixPlan, frame: number) => {
    const session = ++reqSeq;
    const r = await previewCall({ type: 'start', session, plan, frame });
    if (r.type === 'error') throw new Error(r.error);
    return session;
  });
  ipcMain.handle('preview:chunk', async (_e, session: number, frames: number) => {
    const r = await previewCall({ type: 'chunk', session, frames });
    if (r.type === 'error') throw new Error(r.error);
    return r.data;
  });
  ipcMain.handle('preview:stop', async (_e, session: number) => { await previewCall({ type: 'stop', session }); });

  ipcMain.handle('export:pick', async (_e, name: string, format: 'mp3' | 'wav') => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Exporter la mixtape',
      defaultPath: path.join(app.getPath('music'), `${name}.${format}`),
      filters: [format === 'mp3' ? { name: 'MP3', extensions: ['mp3'] } : { name: 'WAV', extensions: ['wav'] }],
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  ipcMain.handle('export:start', (_e, plan: MixPlan, opts: ExportOptions) => {
    const id = ++exportSeq;
    const w = spawnWorker('export', { plan, opts });
    exports.set(id, w);
    w.on('message', (m: any) => {
      if (m.type === 'progress') win?.webContents.send('export:progress', { id, frames: m.frames, totalFrames: m.totalFrames, stage: m.stage });
      else if (m.type === 'done') win?.webContents.send('export:done', { id, report: m.report });
      else if (m.type === 'error') win?.webContents.send('export:error', { id, error: m.error, cancelled: m.cancelled });
    });
    w.on('error', (e) => win?.webContents.send('export:error', { id, error: String(e), cancelled: false }));
    w.on('exit', () => exports.delete(id));
    return id;
  });
  ipcMain.handle('export:cancel', (_e, id: number) => { exports.get(id)?.postMessage({ type: 'cancel' }); });

  ipcMain.handle('project:save', async (_e, project: ProjectFile, p: string | null) => {
    let target = p;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Enregistrer le projet',
        defaultPath: path.join(app.getPath('documents'), `${project.name || 'Mixtape'}.mixlab`),
        filters: [{ name: 'Projet MixLab', extensions: ['mixlab'] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    saveProject(target, project);
    app.addRecentDocument(target);
    return target;
  });
  ipcMain.handle('project:open', async (_e, p?: string) => {
    let target = p;
    if (!target) {
      const r = await dialog.showOpenDialog(win!, { title: 'Ouvrir un projet', properties: ['openFile'], filters: [{ name: 'Projet MixLab', extensions: ['mixlab'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      target = r.filePaths[0];
    }
    const project = loadProject(target);
    const exists: Record<string, boolean> = {};
    for (const t of project.tracks) exists[t.id] = fs.existsSync(t.path);
    app.addRecentDocument(target);
    return { path: target, project, exists };
  });
  ipcMain.handle('project:relink', async (_e, missing) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Dossier où rechercher les fichiers manquants', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return Object.fromEntries(relink(missing, r.filePaths[0]));
  });
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on('app:dirty', (_e, d: boolean) => {
    dirty = d;
    win?.setDocumentEdited(d);
  });
}

app.whenReady().then(() => {
  // Serve cover art from the cache directory only.
  protocol.handle('mixlab-media', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(cacheRoot(), rel));
    if (!file.startsWith(cacheRoot() + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  fs.mkdirSync(cacheRoot(), { recursive: true });
  buildMenu();
  registerIpc();
  initPool();
  createWindow();
  ipcMain.on('app:close-now', () => { forceClose = true; win?.close(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const w of [...idle, ...busy]) w.terminate();
  preview?.terminate();
  for (const w of exports.values()) { w.postMessage({ type: 'cancel' }); }
  app.quit();
});
