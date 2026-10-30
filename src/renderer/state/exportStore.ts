import { create } from 'zustand';
import type { ExportReport } from '../../core/export/exporter';

export interface ExportState {
  id: number | null;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  frames: number;
  totalFrames: number;
  stage: 'render' | 'finalize';
  startedAt: number;
  report: ExportReport | null;
  error: string | null;
  set(p: Partial<ExportState>): void;
}

export const useExport = create<ExportState>()((set) => ({
  id: null,
  status: 'idle',
  frames: 0,
  totalFrames: 0,
  stage: 'render',
  startedAt: 0,
  report: null,
  error: null,
  set: (p) => set(p),
}));
