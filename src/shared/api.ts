// Contract between the renderer and the main process (exposed by the preload as window.mixlab).

import type { MixPlan } from '../core/mix/plan';
import type { ExportOptions, ExportReport, ExportProgress } from '../core/export/exporter';
import type { ProjectFile, TrackAnalysis, TrackMeta } from '../core/types';

export interface InspectedFile {
  path: string;
  fileName: string;
  size: number;
  fingerprint: string;
  error?: string;
}

export interface AnalysisDone {
  id: string;
  meta: TrackMeta;
  analysis: TrackAnalysis;
  cacheDir: string;
  coverUrl: string | null;
  fromCache: boolean;
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  ffmpeg: { ok: boolean; path?: string; soxr?: boolean; error?: string };
  cacheDir: string;
  reducedMotion: boolean;
}

export interface OpenedProject {
  path: string;
  project: ProjectFile;
  exists: Record<string, boolean>;
}

export interface MixlabApi {
  info(): Promise<AppInfo>;
  pickAudioFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  inspectFiles(paths: string[]): Promise<InspectedFile[]>;
  analyze(jobs: Array<{ id: string; path: string; fingerprint: string }>): Promise<void>;
  onAnalysisProgress(cb: (e: { id: string; progress: number; stage: string }) => void): () => void;
  onAnalysisDone(cb: (e: AnalysisDone) => void): () => void;
  onAnalysisError(cb: (e: { id: string; error: string }) => void): () => void;

  previewStart(plan: MixPlan, frame: number): Promise<number>;
  previewChunk(session: number, frames: number): Promise<{ left: Float32Array; right: Float32Array } | null>;
  previewStop(session: number): Promise<void>;

  pickExportPath(defaultName: string, format: 'mp3' | 'wav'): Promise<string | null>;
  exportStart(plan: MixPlan, opts: ExportOptions): Promise<number>;
  exportCancel(id: number): Promise<void>;
  onExportProgress(cb: (e: { id: number } & ExportProgress) => void): () => void;
  onExportDone(cb: (e: { id: number; report: ExportReport }) => void): () => void;
  onExportError(cb: (e: { id: number; error: string; cancelled: boolean }) => void): () => void;

  saveProject(project: ProjectFile, path: string | null): Promise<string | null>;
  openProject(path?: string): Promise<OpenedProject | null>;
  relink(missing: Array<{ id: string; fileName: string; size: number; fingerprint: string }>): Promise<Record<string, string> | null>;
  reveal(path: string): Promise<void>;
  setDirty(dirty: boolean): void;
  closeNow(): void;
  onMenu(cb: (cmd: string) => void): () => void;
}

declare global {
  interface Window {
    mixlab: MixlabApi;
  }
}
