// Worker thread entry point. One bundle, three roles selected by workerData.role:
//  - analysis: decodes and analyses tracks (one job at a time per worker)
//  - preview:  renders mix chunks on demand for the player (stateful sessions)
//  - export:   renders the whole mix to a file

import { parentPort, workerData } from 'node:worker_threads';
import { analyzeTrack, loadCachedAnalysis } from '../core/analysis/analyze';
import { findFfmpeg } from '../core/audio/ffmpeg';
import { PcmReader } from '../core/audio/pcm';
import { MixRenderer } from '../core/mix/renderer';
import { exportMix, ExportCancelled } from '../core/export/exporter';
import type { MixPlan } from '../core/mix/plan';

const port = parentPort!;
const role: 'analysis' | 'preview' | 'export' = workerData.role;
if (workerData.ffmpegDir) process.env.MIXLAB_FFMPEG_DIR = workerData.ffmpegDir;

if (role === 'analysis') {
  port.on('message', async (job: { id: string; path: string; cacheDir: string }) => {
    try {
      findFfmpeg();
      const cached = loadCachedAnalysis(job.cacheDir);
      if (cached) {
        port.postMessage({ type: 'done', id: job.id, ...cached, cacheDir: job.cacheDir, fromCache: true });
        return;
      }
      let last = 0;
      const out = await analyzeTrack(job.path, job.cacheDir, (p, stage) => {
        const now = Date.now();
        if (now - last > 120 || p >= 1) {
          last = now;
          port.postMessage({ type: 'progress', id: job.id, progress: p, stage });
        }
      });
      port.postMessage({ type: 'done', id: job.id, ...out, cacheDir: job.cacheDir, fromCache: false });
    } catch (e: any) {
      port.postMessage({ type: 'error', id: job.id, error: e?.message ?? String(e) });
    }
  });
}

if (role === 'preview') {
  const sessions = new Map<number, { renderer: MixRenderer; readers: PcmReader[] }>();
  const stop = (id: number) => {
    const s = sessions.get(id);
    if (!s) return;
    s.renderer.close();
    for (const r of s.readers) r.close();
    sessions.delete(id);
  };
  port.on('message', (m: any) => {
    try {
      if (m.type === 'start') {
        // Only one live session at a time keeps file handles bounded.
        for (const id of [...sessions.keys()]) stop(id);
        const readers: PcmReader[] = [];
        const renderer = new MixRenderer(m.plan as MixPlan, (p) => { const r = new PcmReader(p); readers.push(r); return r; });
        renderer.seek(m.frame);
        sessions.set(m.session, { renderer, readers });
        port.postMessage({ type: 'started', reqId: m.reqId });
      } else if (m.type === 'chunk') {
        const s = sessions.get(m.session);
        if (!s) return port.postMessage({ type: 'chunk', reqId: m.reqId, data: null });
        const { left, right } = s.renderer.render(m.frames);
        port.postMessage({ type: 'chunk', reqId: m.reqId, data: { left, right } }, [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer]);
      } else if (m.type === 'stop') {
        stop(m.session);
        port.postMessage({ type: 'stopped', reqId: m.reqId });
      }
    } catch (e: any) {
      port.postMessage({ type: 'error', reqId: m.reqId, error: e?.message ?? String(e) });
    }
  });
}

if (role === 'export') {
  const ac = new AbortController();
  port.on('message', (m: any) => { if (m?.type === 'cancel') ac.abort(); });
  exportMix(workerData.plan as MixPlan, workerData.opts, (p) => port.postMessage({ type: 'progress', ...p }), ac.signal)
    .then((report) => port.postMessage({ type: 'done', report }))
    .catch((e: any) => port.postMessage({ type: 'error', error: e?.message ?? String(e), cancelled: e instanceof ExportCancelled }));
}
