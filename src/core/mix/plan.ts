// Mix planning: turns a mixtape (order + transition specs) and analysed tracks into an exact
// timeline of voices with tempo curves, gain automation and EQ automation.
// The same plan drives preview and export, so what is heard is what is rendered.

import { evalBreakpoints, fadeIn, fadeOut, ramp, sampleCurve, type Breakpoint } from './curves';
import {
  downbeatAtOrAfter,
  gridOf,
  latestPhraseBefore,
  outroStart,
  introEnd,
  playableEnd,
  playableStart,
  snapToDownbeat,
  tempoRelation,
  withPitch,
  type Grid,
} from '../music/grid';
import { harmonicMatch } from '../music/camelot';
import {
  defaultTransition,
  INTERNAL_SAMPLE_RATE,
  type EffectiveTrack,
  type MixSettings,
  type Mixtape,
  type TransitionEffect,
  type TransitionSpec,
  type TransitionType,
} from '../types';

export interface RateSegment {
  t0: number; // output seconds relative to voice start
  t1: number;
  r0: number; // playback rate (source s per output s) at t0
  r1: number; // at t1 (linear in between)
}

export interface VoicePlan {
  entryId: string;
  trackId: string;
  title: string;
  artist: string;
  pcmPath: string;
  start: number; // output seconds
  end: number;
  srcStart: number; // source seconds at `start`
  srcEnd: number;
  segments: RateSegment[];
  /** Relative output time after which the rate is exactly 1 (0 when never stretched). */
  stretchUntil: number;
  gain: number; // linear (normalisation + user gain)
  normDb: number;
  fader: Breakpoint[];
  eq: { low: Breakpoint[]; mid: Breakpoint[]; high: Breakpoint[] } | null;
  /** Transposition in semitones (0 = none); rendered by resampled WSOLA, tempo unchanged. */
  pitch: number;
  /** Filter knob automation: < 0 low-pass, > 0 high-pass, 0 = bypass (see SweepFilter). */
  filter: Breakpoint[] | null;
  /** Tempo-synced echo fed from this voice (pre-fader); its tail rings `tail` seconds past `end`. */
  echo: { delay: number; feedback: number; send: Breakpoint[]; tail: number } | null;
  /** Loop roll: output [start, end) replays the beat starting at `start`, then ½ and ¼ beat. */
  loop: { start: number; end: number; beat: number } | null;
}

export type Severity = 'ok' | 'info' | 'warn' | 'problem';

export interface PlannedTransition {
  index: number;
  fromEntryId: string;
  toEntryId: string;
  requestedType: TransitionType;
  type: TransitionType;
  synced: boolean;
  factor: number;
  rate: number;
  stretchPct: number;
  start: number;
  end: number;
  duration: number;
  bars: number | null;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  bassSwap: boolean;
  swapPoint: number;
  fadeOut: TransitionSpec['fadeOut'];
  fadeIn: TransitionSpec['fadeIn'];
  effect: TransitionEffect;
  /** Beat length of the outgoing track in output seconds (null when not beat-matched). */
  beat: number | null;
  notes: string[];
  severity: Severity;
}

export interface MixPlan {
  sampleRate: number;
  duration: number;
  totalFrames: number;
  voices: VoicePlan[];
  transitions: PlannedTransition[];
  warnings: string[];
  settings: MixSettings;
}

// ---------- tempo curve helpers ----------

/** Source position (s) of a voice at relative output time t. */
export function srcAtRel(v: Pick<VoicePlan, 'srcStart' | 'segments'>, t: number): number {
  let s = v.srcStart;
  for (const g of v.segments) {
    if (t <= g.t0) break;
    const end = Math.min(t, g.t1);
    const d = end - g.t0;
    const slope = g.t1 > g.t0 && Number.isFinite(g.t1) ? (g.r1 - g.r0) / (g.t1 - g.t0) : 0;
    s += g.r0 * d + 0.5 * slope * d * d;
    if (t <= g.t1) break;
  }
  return s;
}

export function rateAtRel(v: Pick<VoicePlan, 'segments'>, t: number): number {
  for (const g of v.segments) {
    if (t < g.t1) {
      if (!Number.isFinite(g.t1) || g.t1 === g.t0) return g.r0;
      return g.r0 + ((g.r1 - g.r0) * (t - g.t0)) / (g.t1 - g.t0);
    }
  }
  return v.segments.length ? v.segments[v.segments.length - 1].r1 : 1;
}

/** Inverse of srcAtRel (bisection; the mapping is strictly increasing). */
export function relAtSrc(v: Pick<VoicePlan, 'srcStart' | 'segments'>, src: number): number {
  if (src <= v.srcStart) return 0;
  let lo = 0, hi = Math.max(1, (src - v.srcStart) * 2);
  while (srcAtRel(v, hi) < src) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (srcAtRel(v, m) < src) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

// ---------- planning ----------

interface Working {
  entryId: string;
  track: EffectiveTrack;
  grid: Grid | null;
  start: number;
  srcStart: number;
  rateIn: number;
  dIn: number; // incoming overlap (output s)
  cueIn: number | null;
  cueOut: number | null;
  gainDb: number;
  segments: RateSegment[];
  stretchUntil: number;
}

const SYNC_TYPES: TransitionType[] = ['beatsync', 'eq', 'structure'];

function buildSegments(rateIn: number, dIn: number, ramp: number, rateOut: number): { segments: RateSegment[]; stretchUntil: number } {
  if (Math.abs(rateIn - 1) < 1e-5 && Math.abs(rateOut - 1) < 1e-5) {
    return { segments: [{ t0: 0, t1: Infinity, r0: 1, r1: 1 }], stretchUntil: 0 };
  }
  const segs: RateSegment[] = [];
  if (dIn > 0) segs.push({ t0: 0, t1: dIn, r0: rateIn, r1: rateIn });
  if (ramp > 0) segs.push({ t0: dIn, t1: dIn + ramp, r0: rateIn, r1: rateOut });
  segs.push({ t0: dIn + ramp, t1: Infinity, r0: rateOut, r1: rateOut });
  return { segments: segs, stretchUntil: Math.abs(rateOut - 1) < 1e-5 ? dIn + ramp : Infinity };
}

export interface PlanInput {
  mixtape: Pick<Mixtape, 'entries' | 'transitions' | 'settings'>;
  tracks: Map<string, EffectiveTrack>;
}

export function buildPlan({ mixtape, tracks }: PlanInput): MixPlan {
  const settings = mixtape.settings;
  const sr = INTERNAL_SAMPLE_RATE;
  const warnings: string[] = [];
  const entries = mixtape.entries.filter((e) => {
    const ok = tracks.has(e.trackId);
    if (!ok) warnings.push('Un morceau de la playlist n’est pas disponible (fichier manquant ou non analysé) et a été ignoré.');
    return ok;
  });
  const voices: VoicePlan[] = [];
  const transitions: PlannedTransition[] = [];
  if (!entries.length) return { sampleRate: sr, duration: 0, totalFrames: 0, voices, transitions, warnings, settings };

  const mk = (i: number): Working => {
    const e = entries[i];
    const t = withPitch(tracks.get(e.trackId)!, e.pitch);
    return {
      entryId: e.id, track: t, grid: gridOf(t), start: 0, srcStart: playableStart(t, e.cueIn), rateIn: 1, dIn: 0,
      cueIn: e.cueIn, cueOut: e.cueOut, gainDb: e.gainDb, segments: [], stretchUntil: 0,
    };
  };

  let cur = mk(0);
  const ends: Array<{ end: number; srcEnd: number }> = [];
  const works: Working[] = [];

  for (let i = 0; i < entries.length; i++) {
    const A = cur;
    const aEndMax = playableEnd(A.track, A.cueOut);
    const voiceTmp = (segments: RateSegment[]) => ({ srcStart: A.srcStart, segments });
    const isLast = i === entries.length - 1;

    // Tempo return of A after its incoming overlap.
    const needsReturn = Math.abs(A.rateIn - 1) > 1e-5;
    const rampDefault = needsReturn && A.grid ? (settings.tempoReturnBars * A.grid.bar) / ((A.rateIn + 1) / 2) : needsReturn ? 8 : 0;

    if (isLast) {
      let segInfo = buildSegments(A.rateIn, A.dIn, rampDefault, 1);
      // Shorten / drop the return ramp if the track ends first.
      const endRel = relAtSrc(voiceTmp(segInfo.segments), aEndMax);
      if (endRel < A.dIn + rampDefault) segInfo = buildSegments(A.rateIn, A.dIn, 0, A.rateIn);
      A.segments = segInfo.segments;
      A.stretchUntil = segInfo.stretchUntil;
      const endRel2 = relAtSrc(voiceTmp(A.segments), aEndMax);
      works.push(A);
      ends.push({ end: A.start + endRel2, srcEnd: aEndMax });
      break;
    }

    const B = mk(i + 1);
    const spec: TransitionSpec = mixtape.transitions[A.entryId] ?? defaultTransition(settings);
    const notes: string[] = [];
    let severity: Severity = 'ok';
    const bump = (s: Severity) => {
      const order: Severity[] = ['ok', 'info', 'warn', 'problem'];
      if (order.indexOf(s) > order.indexOf(severity)) severity = s;
    };

    // Try with a full tempo return first, then without.
    const attempts: Array<{ ramp: number; rateOut: number }> = needsReturn
      ? [{ ramp: rampDefault, rateOut: 1 }, { ramp: rampDefault / 2, rateOut: 1 }, { ramp: 0, rateOut: A.rateIn }]
      : [{ ramp: 0, rateOut: 1 }];

    type Resolved = {
      segInfo: ReturnType<typeof buildSegments>;
      synced: boolean; factor: number; rate: number; stretchPct: number;
      D: number; bars: number | null; aStart: number; bStart: number; type: TransitionType;
    };
    let resolved = null as Resolved | null;

    const wantSync = SYNC_TYPES.includes(spec.type);
    let syncBlocked: string | null = null;
    const gA = A.grid, gB = B.grid;

    const trySynced = (att: { ramp: number; rateOut: number }, allowReduce: boolean): Resolved | null => {
      if (!gA || !gB) { syncBlocked = `BPM indisponible pour ${!gA ? A.track.title : B.track.title}`; return null; }
      if (!gA.reliable || !gB.reliable) { syncBlocked = `grille rythmique peu fiable (${!gA.reliable ? A.track.title : B.track.title})`; return null; }
      const rel = tempoRelation(gA.bpm * att.rateOut, gB.bpm);
      if (rel.stretchPct > settings.maxStretchPct) {
        syncBlocked = `écart de tempo de ${rel.stretchPct.toFixed(1)} % (limite ${settings.maxStretchPct} %)`;
        return null;
      }
      const segInfo = buildSegments(A.rateIn, A.dIn, att.ramp, att.rateOut);
      const aMin = srcAtRel(voiceTmp(segInfo.segments), A.dIn + att.ramp) - 1e-3;
      let bars = spec.bars;
      if (spec.type === 'structure') {
        const outro = outroStart(A.track);
        const intro = introEnd(B.track);
        const outroBars = outro !== null ? Math.round((aEndMax - outro) / gA.bar) : spec.bars;
        const introBars = intro !== null ? Math.round((intro - downbeatAtOrAfter(gB, playableStart(B.track, B.cueIn) - 0.02)) / gB.bar) : spec.bars;
        const fit = Math.min(spec.bars, Math.max(4, Math.min(outroBars, introBars * (rel.factor === 2 ? 2 : 1))));
        bars = [32, 16, 8, 4].find((b) => b <= fit) ?? 4;
      }
      const wanted = bars;
      for (; bars >= 1; bars = bars > 4 ? bars / 2 : bars - 1) {
        if (!allowReduce && bars !== wanted) break;
        const D = (bars * gA.bar) / att.rateOut;
        const srcLenA = bars * gA.bar;
        let aStart: number | null;
        const outro = outroStart(A.track);
        if (spec.outStart !== null) {
          aStart = snapToDownbeat(gA, spec.outStart);
          if (aStart + srcLenA > aEndMax + 0.01) aStart = latestPhraseBefore(gA, aEndMax - srcLenA, aMin, [1]);
        } else if (spec.type === 'structure' && outro !== null && snapToDownbeat(gA, outro) + srcLenA <= aEndMax + 0.01 && snapToDownbeat(gA, outro) >= aMin) {
          aStart = snapToDownbeat(gA, outro);
        } else {
          aStart = latestPhraseBefore(gA, aEndMax - srcLenA, aMin, [8, 4, 1]);
        }
        if (aStart === null || aStart < aMin) continue;
        const bStart = Math.max(0, spec.inStart !== null ? snapToDownbeat(gB, spec.inStart) : downbeatAtOrAfter(gB, playableStart(B.track, B.cueIn) - 0.02));
        if (bStart + D * rel.rate > playableEnd(B.track, B.cueOut)) continue;
        if (bars !== wanted) notes.push(`Durée réduite à ${bars} mesures (morceau trop court)`);
        return { segInfo, synced: true, factor: rel.factor, rate: rel.rate, stretchPct: rel.stretchPct, D, bars, aStart, bStart, type: spec.type };
      }
      return null;
    };

    const tryTimed = (att: { ramp: number; rateOut: number }): Resolved | null => {
      const segInfo = buildSegments(A.rateIn, A.dIn, att.ramp, att.rateOut);
      const aMin = srcAtRel(voiceTmp(segInfo.segments), A.dIn + att.ramp) - 1e-3;
      const D = Math.max(0.5, Math.min(spec.seconds, 30));
      let aStart = spec.outStart ?? aEndMax - D * att.rateOut;
      if (aStart + D * att.rateOut > aEndMax) aStart = aEndMax - D * att.rateOut;
      if (gA && gA.reliable && spec.outStart === null) {
        const snapped = latestPhraseBefore(gA, aStart, aMin, [4, 1]);
        if (snapped !== null) aStart = snapped;
      }
      if (aStart < aMin) return null;
      let bStart = spec.inStart ?? playableStart(B.track, B.cueIn);
      if (bStart + D > playableEnd(B.track, B.cueOut)) bStart = Math.max(0, playableEnd(B.track, B.cueOut) - D);
      return { segInfo, synced: false, factor: 1, rate: 1, stretchPct: 0, D, bars: null, aStart, bStart, type: spec.type === 'beatsync' ? 'crossfade' : spec.type };
    };

    if (wantSync) {
      for (const att of attempts) if (!resolved) resolved = trySynced(att, false);
      for (const att of attempts) if (!resolved) resolved = trySynced(att, true);
    }
    for (const att of attempts) if (!resolved) resolved = tryTimed(att);

    if (!resolved) {
      // Track too short for anything sensible: butt-join with a short crossfade at the end.
      const segInfo = buildSegments(A.rateIn, A.dIn, 0, A.rateIn);
      const D = Math.min(1, Math.max(0.05, (aEndMax - A.srcStart) / 4));
      resolved = {
        segInfo, synced: false, factor: 1, rate: 1, stretchPct: 0, D, bars: null,
        aStart: Math.max(A.srcStart, aEndMax - D * A.rateIn), bStart: playableStart(B.track, B.cueIn), type: 'crossfade',
      };
      notes.push('Morceau trop court pour la transition demandée : fondu court de secours');
      bump('problem');
    }

    if (wantSync && !resolved.synced) {
      notes.push(`Synchronisation impossible : ${syncBlocked ?? 'pas de point de mesure compatible'}. Fondu enchaîné non synchronisé utilisé.`);
      bump('warn');
    }
    if (resolved.synced) {
      if (resolved.stretchPct > 4) { notes.push(`Time-stretch important (${resolved.stretchPct.toFixed(1)} %) : artefacts possibles`); bump('warn'); }
      if (resolved.factor !== 1) { notes.push(resolved.factor === 2 ? 'Calage en demi-tempo' : 'Calage en double tempo'); bump('info'); }
      const dbc = Math.min(A.track.analysis.downbeatConfidence, B.track.analysis.downbeatConfidence);
      if (dbc < 0.15) { notes.push('Position des premiers temps de mesure incertaine'); bump('info'); }
    }
    if (A.track.key && B.track.key && resolved.D > 16.5) {
      const hm = harmonicMatch(A.track.key.camelot, B.track.key.camelot);
      if (hm.score < 0.35 && Math.min(A.track.key.confidence, B.track.key.confidence) > 0.3) {
        notes.push(`Tonalités éloignées (${A.track.key.camelot} → ${B.track.key.camelot}) sur un long chevauchement`);
        bump('warn');
      }
    }

    A.segments = resolved.segInfo.segments;
    A.stretchUntil = resolved.segInfo.stretchUntil;
    const tStart = A.start + relAtSrc(voiceTmp(A.segments), resolved.aStart);
    const tEnd = tStart + resolved.D;
    const effect = spec.effect ?? 'none';
    const beat = resolved.synced && gA ? gA.beat / rateAtRel({ segments: A.segments }, tStart - A.start) : null;
    if (effect === 'loop' && !loopWindow({ effect, beat, bars: resolved.bars, duration: resolved.D, end: tEnd })) {
      notes.push('Transition trop courte pour une boucle : effet ignoré');
      bump('info');
    }
    works.push(A);
    ends.push({ end: tEnd, srcEnd: srcAtRel(voiceTmp(A.segments), tEnd - A.start) });

    B.start = tStart;
    B.srcStart = resolved.bStart;
    B.rateIn = resolved.rate;
    B.dIn = resolved.D;

    transitions.push({
      index: i,
      fromEntryId: A.entryId,
      toEntryId: B.entryId,
      requestedType: spec.type,
      type: resolved.type,
      synced: resolved.synced,
      factor: resolved.factor,
      rate: resolved.rate,
      stretchPct: resolved.stretchPct,
      start: tStart,
      end: tEnd,
      duration: resolved.D,
      bars: resolved.bars,
      aStart: resolved.aStart,
      aEnd: resolved.aStart + resolved.D * rateAtRel({ segments: A.segments }, tStart - A.start),
      bStart: resolved.bStart,
      bEnd: resolved.bStart + resolved.D * resolved.rate,
      bassSwap: spec.bassSwap && resolved.type !== 'crossfade',
      swapPoint: spec.swapPoint,
      fadeOut: spec.fadeOut,
      fadeIn: spec.fadeIn,
      effect,
      beat,
      notes,
      severity,
    });
    cur = B;
  }

  // Build voices with automation.
  for (let i = 0; i < works.length; i++) {
    const w = works[i];
    const tIn = i > 0 ? transitions[i - 1] : null;
    const tOut = i < transitions.length ? transitions[i] : null;
    const normDb = settings.normalize && w.track.analysis.lufs !== null ? Math.max(-12, Math.min(12, settings.targetLufs - w.track.analysis.lufs)) : 0;
    const gain = Math.pow(10, (normDb + w.gainDb) / 20);
    const fader: Breakpoint[] = [];
    let low: Breakpoint[] = [], mid: Breakpoint[] = [], high: Breakpoint[] = [];
    let eqUsed = false;
    let filter: Breakpoint[] = [];
    let echo: VoicePlan['echo'] = null;
    let loop: VoicePlan['loop'] = null;
    const start = w.start;
    const end = ends[i].end;
    if (tIn) {
      const env = envelopes(tIn);
      fader.push(...sampleCurve(tIn.start, tIn.end, env.inFader));
      if (env.inFilter) filter.push(...sampleCurve(tIn.start, tIn.end, env.inFilter));
      if (env.inEq) {
        eqUsed = true;
        low.push(...sampleCurve(tIn.start, tIn.end, env.inEq.low));
        mid.push(...sampleCurve(tIn.start, tIn.end, env.inEq.mid));
        high.push(...sampleCurve(tIn.start, tIn.end, env.inEq.high));
      }
    } else {
      fader.push({ t: start, v: 0 }, { t: start + 0.005, v: 1 });
    }
    if (tOut) {
      const env = envelopes(tOut);
      fader.push(...sampleCurve(tOut.start, tOut.end, env.outFader));
      if (env.outFilter) filter.push(...sampleCurve(tOut.start, tOut.end, env.outFilter));
      if (env.outSend) {
        const delay = Math.max(0.1, Math.min(1, tOut.beat ?? ECHO_FALLBACK_DELAY));
        echo = { delay, feedback: ECHO_FEEDBACK, send: sampleCurve(tOut.start, tOut.end, env.outSend), tail: delay * Math.ceil(Math.log(0.002) / Math.log(ECHO_FEEDBACK)) };
      }
      loop = loopWindow(tOut);
      if (env.outEq) {
        eqUsed = true;
        low.push(...sampleCurve(tOut.start, tOut.end, env.outEq.low));
        mid.push(...sampleCurve(tOut.start, tOut.end, env.outEq.mid));
        high.push(...sampleCurve(tOut.start, tOut.end, env.outEq.high));
      }
    } else {
      fader.push({ t: end - 0.005, v: 1 }, { t: end, v: 0 });
    }
    if (eqUsed) {
      // Fill the other side with unity so interpolation stays flat between transitions.
      const fill = (bp: Breakpoint[]) => {
        if (!tIn || !bp.length || bp[0].t > start + 1e-6) bp.unshift({ t: start, v: 1 });
        if (!tOut || bp[bp.length - 1].t < end - 1e-6) bp.push({ t: end, v: 1 });
        return bp.sort((a, b) => a.t - b.t);
      };
      low = fill(low); mid = fill(mid); high = fill(high);
    }
    fader.sort((a, b) => a.t - b.t);
    if (filter.length) {
      if (filter[0].t > start + 1e-6) filter.unshift({ t: start, v: 0 });
      if (filter[filter.length - 1].t < end - 1e-6) filter.push({ t: end, v: 0 });
      filter.sort((a, b) => a.t - b.t);
    }
    voices.push({
      entryId: w.entryId,
      trackId: w.track.id,
      title: w.track.title,
      artist: w.track.artist,
      pcmPath: w.track.pcmPath,
      start,
      end,
      srcStart: w.srcStart,
      srcEnd: ends[i].srcEnd,
      segments: w.segments,
      stretchUntil: w.stretchUntil,
      gain,
      normDb,
      fader,
      eq: eqUsed ? { low, mid, high } : null,
      pitch: entries[i].pitch ?? 0,
      filter: filter.length ? filter : null,
      echo,
      loop,
    });
  }

  const duration = voices.length ? voices[voices.length - 1].end : 0;
  return { sampleRate: sr, duration, totalFrames: Math.round(duration * sr), voices, transitions, warnings, settings };
}

const ECHO_FEEDBACK = 0.55;
const ECHO_FALLBACK_DELAY = 0.375;

/** Output window of a loop roll at the end of a transition (whole beats), or null when it does not fit. */
export function loopWindow(t: Pick<PlannedTransition, 'effect' | 'beat' | 'bars' | 'duration' | 'end'>): VoicePlan['loop'] {
  if (t.effect !== 'loop') return null;
  const beat = t.beat ?? 0.5;
  let beats = t.bars === null ? 4 : t.bars >= 8 ? 8 : t.bars >= 4 ? 4 : 2;
  while (beats > 1 && beats * beat > t.duration / 2) beats /= 2;
  if (beats * beat > t.duration * 0.6) return null;
  return { start: t.end - beats * beat, end: t.end, beat };
}

type Fn = (u: number) => number;
interface Envelopes {
  outFader: Fn;
  inFader: Fn;
  outEq: { low: Fn; mid: Fn; high: Fn } | null;
  inEq: { low: Fn; mid: Fn; high: Fn } | null;
  outFilter?: Fn;
  inFilter?: Fn;
  outSend?: Fn;
}

type EnvInput = Pick<PlannedTransition, 'type' | 'fadeIn' | 'fadeOut' | 'bassSwap' | 'swapPoint' | 'duration' | 'synced' | 'rate'> &
  Partial<Pick<PlannedTransition, 'effect' | 'beat' | 'bars' | 'end'>>;

/** Gain, EQ and effect automation of a transition, as functions of the progress u ∈ [0,1]. */
export function envelopes(t: EnvInput): Envelopes {
  const env = baseEnvelopes(t);
  const fo = t.fadeOut;
  switch (t.effect ?? 'none') {
    case 'filter':
      // The outgoing track is high-passed away while the incoming one opens up from a low-pass.
      env.outFilter = (u) => ramp(u, 0.15, 1, 0, 1);
      env.inFilter = (u) => ramp(u, 0, 0.6, -0.85, 0);
      break;
    case 'echo':
      // A is sent into the echo over its last beats, then its dry signal is gone: the repeats ring over B.
      env.outFader = (u) => fadeOut(fo, Math.min(1, Math.max(0, (u - 0.5) / 0.42)));
      env.outSend = (u) => (u < 0.85 ? ramp(u, 0.55, 0.8, 0, 1) : ramp(u, 0.9, 0.96, 1, 0));
      break;
    case 'loop': {
      const w = loopWindow({ effect: 'loop', beat: t.beat ?? null, bars: t.bars ?? null, duration: t.duration, end: t.end ?? t.duration });
      if (w) {
        // A plays on until the roll starts, then fades out through it.
        const uL = 1 - (w.end - w.start) / t.duration;
        env.outFader = (u) => fadeOut(fo, Math.min(1, Math.max(0, (u - uL) / (1 - uL))));
      }
      break;
    }
  }
  return env;
}

function baseEnvelopes(t: EnvInput): Envelopes {
  const fo = t.fadeOut, fi = t.fadeIn;
  // Swap width: about one beat when possible, never shorter than 40 ms.
  const sw = Math.min(0.12, Math.max(0.04 / Math.max(t.duration, 0.1), 0.5 / Math.max(t.duration, 0.5)));
  const p = Math.min(0.9, Math.max(0.1, t.swapPoint));
  const swapIn = (u: number) => ramp(u, p - sw / 2, p + sw / 2, 0, 1);
  const swapOut = (u: number) => ramp(u, p - sw / 2, p + sw / 2, 1, 0);

  if (t.type === 'eq' || t.type === 'structure') {
    // DJ-style blend: the incoming track is brought up first with its bass cut, the basses are swapped,
    // then the outgoing track's mids/highs and fader go down. Neither fader dips mid-transition.
    return {
      inFader: (u) => fadeIn(fi, Math.min(1, u / 0.5)),
      outFader: (u) => fadeOut(fo, Math.max(0, (u - 0.5) / 0.5)),
      inEq: {
        low: t.bassSwap ? swapIn : () => 1,
        mid: (u) => ramp(u, 0.15, 0.6, 0.55, 1),
        high: (u) => ramp(u, 0.0, 0.5, 0.7, 1),
      },
      outEq: {
        low: t.bassSwap ? swapOut : () => 1,
        mid: (u) => ramp(u, 0.45, 0.85, 1, 0.6),
        high: (u) => ramp(u, 0.5, 0.9, 1, 0.55),
      },
    };
  }
  const eq = t.bassSwap && t.type !== 'crossfade';
  return {
    inFader: (u) => fadeIn(fi, u),
    outFader: (u) => fadeOut(fo, u),
    inEq: eq ? { low: swapIn, mid: () => 1, high: () => 1 } : null,
    outEq: eq ? { low: swapOut, mid: () => 1, high: () => 1 } : null,
  };
}

export { evalBreakpoints };
