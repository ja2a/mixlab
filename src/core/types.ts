// Shared domain types. Pure data: usable from the renderer, the main process and workers.

export const INTERNAL_SAMPLE_RATE = 44100;
export const ANALYSIS_SAMPLE_RATE = 11025;
export const ANALYSIS_VERSION = 3;

export type Mode = 'major' | 'minor';

export interface KeyInfo {
  tonic: number; // 0 = C … 11 = B
  mode: Mode;
  camelot: string; // e.g. "8A"
  name: string; // e.g. "A minor"
  confidence: number; // 0..1
}

export type SectionLabel = 'intro' | 'verse' | 'chorus' | 'drop' | 'break' | 'outro';

export interface Section {
  startBar: number;
  endBar: number; // exclusive
  start: number; // seconds
  end: number; // seconds
  label: SectionLabel;
  energy: number; // 0..1 relative to the track
  vocal: number; // 0..1 heuristic
}

export interface Waveform {
  /** Number of points; each point covers duration / points seconds. */
  points: number;
  /** Peak amplitude 0..255 */
  peak: number[];
  /** Band energies 0..255 (low < 250 Hz, mid 250–2500 Hz, high > 2500 Hz) */
  low: number[];
  mid: number[];
  high: number[];
}

export interface TrackAnalysis {
  version: number;
  duration: number; // decoded duration, seconds
  sourceSampleRate: number;
  sourceChannels: number;
  codec: string;
  bitrate: number | null;

  bpm: number | null;
  bpmConfidence: number; // 0..1
  tempoStability: number; // 0..1, how well a constant grid fits the detected beats
  /** Time (s) of a reference beat of the constant grid. Beat k is at firstBeat + k * 60 / bpm. */
  firstBeat: number | null;
  /** Index (0..3) of the downbeat inside the 4-beat bar, relative to firstBeat. */
  downbeatPhase: number;
  downbeatConfidence: number;

  key: KeyInfo | null;
  tuningCents: number;

  lufs: number | null;
  truePeakDb: number | null;
  samplePeakDb: number | null;
  loudnessRange: number | null;

  silenceStart: number; // seconds of leading silence
  silenceEnd: number; // time where trailing silence begins

  energy: number | null; // 1..10
  onsetRate: number; // onsets / s
  brightness: number; // spectral centroid, Hz
  vocalness: number; // 0..1 heuristic

  /** Per-bar descriptors (only when a reliable grid exists). */
  barEnergy: number[]; // 0..1
  barVocal: number[]; // 0..1
  barLow: number[]; // 0..1 relative low-band energy
  sections: Section[];

  waveform: Waveform;
  /** Human readable notes about what could not be analysed. */
  warnings: string[];
}

export interface TrackMeta {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  hasArtwork: boolean;
}

export type TrackStatus = 'pending' | 'analyzing' | 'ready' | 'error' | 'missing';

export interface TrackOverrides {
  bpm?: number;
  firstBeat?: number;
  downbeatPhase?: number;
  key?: { tonic: number; mode: Mode };
}

export interface LibraryTrack {
  id: string;
  path: string;
  fileName: string;
  size: number;
  fingerprint: string;
  meta: TrackMeta;
  status: TrackStatus;
  error?: string;
  progress?: number;
  overrides: TrackOverrides;
  /** Absolute path of the decoded PCM cache, set once analysed. */
  cacheDir?: string;
  addedAt: number;
}

export type TransitionType = 'crossfade' | 'curve' | 'beatsync' | 'eq' | 'structure';
export type CurveShape = 'linear' | 'equalPower' | 'sCurve' | 'exponential' | 'logarithmic';
export type ProposalKind = 'smooth' | 'energetic' | 'harmonic' | 'surprise';

export interface TransitionSpec {
  type: TransitionType;
  /** Length in bars for beat-based types, used when the grid is reliable. */
  bars: number;
  /** Length in seconds for time-based types (and as fallback). */
  seconds: number;
  fadeOut: CurveShape;
  fadeIn: CurveShape;
  /** Position (s, in the source of the outgoing track) where the transition starts. null = automatic. */
  outStart: number | null;
  /** Position (s, in the source of the incoming track) where it enters. null = automatic. */
  inStart: number | null;
  /** Progressive bass swap / EQ handling. */
  bassSwap: boolean;
  /** Point (0..1) of the bass swap inside the transition. */
  swapPoint: number;
  locked: boolean;
  /** Where the current settings come from. */
  origin: 'auto' | 'proposal' | 'manual';
  proposal?: ProposalKind;
  /** Entry this transition was configured for; a stale spec (different next entry) is ignored unless locked. */
  toEntryId?: string;
}

export interface PlaylistEntry {
  id: string;
  trackId: string;
  locked: boolean;
  /** Playback start (s) inside the source. null = after leading silence. */
  cueIn: number | null;
  /** Playback end (s) inside the source. null = before trailing silence. */
  cueOut: number | null;
  gainDb: number;
}

export interface MixSettings {
  maxStretchPct: number; // default 6
  targetLufs: number; // default -14
  ceilingDb: number; // true-peak ceiling, default -1
  normalize: boolean;
  defaultBars: number;
  /** Tempo of the incoming track returns to its native value over this many bars after the overlap. */
  tempoReturnBars: number;
}

export interface Mixtape {
  id: string;
  name: string;
  entries: PlaylistEntry[];
  /** Transition leaving entry `fromEntryId`. */
  transitions: Record<string, TransitionSpec>;
  /** Snapshot of the user's manual order, preserved when an automatic order is applied. */
  manualOrder: string[] | null;
  settings: MixSettings;
  createdAt: number;
}

export interface ProjectFile {
  format: 'mixlab-project';
  version: 1;
  name: string;
  tracks: Array<Pick<LibraryTrack, 'id' | 'path' | 'fileName' | 'size' | 'fingerprint' | 'meta' | 'overrides' | 'addedAt'>>;
  mixtapes: Mixtape[];
  activeMixtapeId: string | null;
  savedAt: number;
}

export const DEFAULT_SETTINGS: MixSettings = {
  maxStretchPct: 6,
  targetLufs: -14,
  ceilingDb: -1,
  normalize: true,
  defaultBars: 16,
  tempoReturnBars: 16,
};

export function defaultTransition(settings: MixSettings = DEFAULT_SETTINGS): TransitionSpec {
  return {
    type: 'eq',
    bars: settings.defaultBars,
    seconds: 8,
    fadeOut: 'equalPower',
    fadeIn: 'equalPower',
    outStart: null,
    inStart: null,
    bassSwap: true,
    swapPoint: 0.5,
    locked: false,
    origin: 'auto',
  };
}

/** Analysis with user overrides applied. */
export interface EffectiveTrack {
  id: string;
  title: string;
  artist: string;
  analysis: TrackAnalysis;
  bpm: number | null;
  bpmConfidence: number;
  firstBeat: number | null;
  downbeatPhase: number;
  key: KeyInfo | null;
  pcmPath: string;
}
