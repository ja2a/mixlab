// Beat-grid helpers and effective (override-aware) track descriptors.

import { makeKey, transposeKey } from './camelot';
import type { EffectiveTrack, LibraryTrack, Section, TrackAnalysis } from '../types';

export function effectiveTrack(t: LibraryTrack, a: TrackAnalysis): EffectiveTrack {
  const o = t.overrides ?? {};
  const bpm = o.bpm ?? a.bpm;
  return {
    id: t.id,
    title: t.meta.title,
    artist: t.meta.artist,
    analysis: a,
    bpm,
    bpmConfidence: o.bpm ? Math.max(0.9, a.bpmConfidence) : a.bpmConfidence,
    firstBeat: o.firstBeat ?? a.firstBeat ?? (o.bpm ? a.silenceStart : null),
    downbeatPhase: o.downbeatPhase ?? a.downbeatPhase,
    key: o.key ? makeKey(o.key.tonic, o.key.mode, 1) : a.key,
    pcmPath: (t.cacheDir ?? '') + '/pcm.f32',
  };
}

/** The track as heard with a transposition: only the key changes (tempo and grid are kept). */
export function withPitch(t: EffectiveTrack, semitones = 0): EffectiveTrack {
  return semitones && t.key ? { ...t, key: transposeKey(t.key, semitones) } : t;
}

export interface Grid {
  bpm: number;
  beat: number; // seconds per beat
  bar: number; // seconds per bar
  bar0: number; // time of the earliest downbeat >= 0
  reliable: boolean;
  confidence: number;
}

export function gridOf(t: EffectiveTrack): Grid | null {
  if (!t.bpm || t.firstBeat === null || !Number.isFinite(t.firstBeat)) return null;
  const beat = 60 / t.bpm;
  const bar = 4 * beat;
  let bar0 = t.firstBeat + t.downbeatPhase * beat;
  bar0 -= Math.floor(bar0 / bar) * bar;
  const manual = t.bpmConfidence >= 0.9 && t.analysis.bpm !== t.bpm;
  const reliable = manual || (t.bpmConfidence >= 0.3 && t.analysis.tempoStability >= 0.45);
  return { bpm: t.bpm, beat, bar, bar0, reliable, confidence: t.bpmConfidence };
}

export function barIndex(g: Grid, t: number): number {
  return (t - g.bar0) / g.bar;
}

export function downbeat(g: Grid, i: number): number {
  return g.bar0 + i * g.bar;
}

export function downbeatAtOrAfter(g: Grid, t: number): number {
  return downbeat(g, Math.ceil(barIndex(g, t) - 1e-6));
}

export function downbeatAtOrBefore(g: Grid, t: number): number {
  return downbeat(g, Math.floor(barIndex(g, t) + 1e-6));
}

export function snapToDownbeat(g: Grid, t: number): number {
  return downbeat(g, Math.round(barIndex(g, t)));
}

/** Latest phrase boundary (bar index multiple of `phrase`) at or before `t`, not before `min`. */
export function latestPhraseBefore(g: Grid, t: number, min: number, phrases = [16, 8, 4, 1]): number | null {
  for (const p of phrases) {
    const i = Math.floor(barIndex(g, t) / p + 1e-6) * p;
    const x = downbeat(g, i);
    if (x >= min - 1e-6 && x <= t + 1e-6) return x;
  }
  return null;
}

export function sectionAt(sections: Section[], t: number): Section | null {
  return sections.find((s) => t >= s.start - 1e-3 && t < s.end - 1e-3) ?? null;
}

export function outroStart(t: EffectiveTrack): number | null {
  const s = t.analysis.sections;
  const last = s[s.length - 1];
  return last && last.label === 'outro' ? last.start : null;
}

export function introEnd(t: EffectiveTrack): number | null {
  const s = t.analysis.sections;
  return s[0] && s[0].label === 'intro' ? s[0].end : null;
}

export function firstDrop(t: EffectiveTrack): number | null {
  const s = t.analysis.sections.find((x) => x.label === 'drop' || x.label === 'chorus');
  return s ? s.start : null;
}

export function playableStart(t: EffectiveTrack, cueIn: number | null): number {
  return Math.max(0, cueIn ?? t.analysis.silenceStart);
}

export function playableEnd(t: EffectiveTrack, cueOut: number | null): number {
  return Math.min(t.analysis.duration, cueOut ?? t.analysis.silenceEnd);
}

/** Best tempo relationship between the outgoing (bpmA) and incoming (bpmB) tempi. */
export function tempoRelation(bpmA: number, bpmB: number): { factor: number; rate: number; stretchPct: number } {
  let best = { factor: 1, rate: bpmA / bpmB, stretchPct: Math.abs(bpmA / bpmB - 1) * 100 };
  for (const factor of [2, 0.5]) {
    const rate = bpmA / (bpmB * factor);
    const pct = Math.abs(rate - 1) * 100;
    // Half/double time must be clearly better to be chosen.
    if (pct + 1.5 < best.stretchPct) best = { factor, rate, stretchPct: pct };
  }
  return best;
}

/** Below this many bars removed, a lead-in or tail is not worth shortening. */
const MIN_TRIM_BARS = 8;

/**
 * Automatic cue points that shorten a long quiet lead-in (intro and breaks before the first verse, chorus or drop)
 * or tail (breaks and outro after the last one) to `keepBars` bars, on downbeats. Needs a reliable grid.
 * null = nothing to shorten on that side.
 */
export function autoTrim(t: EffectiveTrack, keepBars: number): { cueIn: number | null; cueOut: number | null } {
  const g = gridOf(t);
  const s = t.analysis.sections;
  if (!keepBars || !g?.reliable || s.length < 2) return { cueIn: null, cueOut: null };
  const quiet = (x: Section) => x.label === 'intro' || x.label === 'break' || x.label === 'outro';
  let i = 0;
  while (i < s.length && quiet(s[i])) i++;
  if (i === s.length) return { cueIn: null, cueOut: null };
  let j = s.length;
  while (j > i && quiet(s[j - 1])) j--;
  const keep = keepBars * g.bar;
  const min = MIN_TRIM_BARS * g.bar - 1e-3;
  const inAt = snapToDownbeat(g, s[i].start) - keep;
  const outAt = snapToDownbeat(g, s[j - 1].end) + keep;
  return {
    cueIn: i > 0 && inAt - t.analysis.silenceStart >= min ? inAt : null,
    cueOut: j < s.length && t.analysis.silenceEnd - outAt >= min ? outAt : null,
  };
}

/**
 * Cue points used for an entry: manual ones first, then the automatic trim, applied only where a transition happens
 * (the first track of the mix keeps its intro, the last one its outro).
 */
export function entryCues(
  t: EffectiveTrack,
  e: { cueIn: number | null; cueOut: number | null },
  keepBars: number,
  pos: { first: boolean; last: boolean } = { first: false, last: false },
): { cueIn: number | null; cueOut: number | null; autoIn: boolean; autoOut: boolean } {
  const auto = e.cueIn === null || e.cueOut === null ? autoTrim(t, keepBars) : { cueIn: null, cueOut: null };
  const autoIn = e.cueIn === null && !pos.first && auto.cueIn !== null;
  const autoOut = e.cueOut === null && !pos.last && auto.cueOut !== null;
  return { cueIn: autoIn ? auto.cueIn : e.cueIn, cueOut: autoOut ? auto.cueOut : e.cueOut, autoIn, autoOut };
}
