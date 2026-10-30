import { useMemo } from 'react';
import { useStore } from '../state/store';
import { effectiveTrack } from '../../core/music/grid';
import { proposeTransitions, type TransitionProposal } from '../../core/music/suggest';
import { buildPlan, type MixPlan } from '../../core/mix/plan';
import type { PairScore } from '../../core/music/compat';
import type { EffectiveTrack, Mixtape, TransitionSpec } from '../../core/types';

export function useEffectiveTracks(): Map<string, EffectiveTrack> {
  const tracks = useStore((s) => s.tracks);
  const analyses = useStore((s) => s.analyses);
  return useMemo(() => {
    const m = new Map<string, EffectiveTrack>();
    for (const t of Object.values(tracks)) {
      const a = analyses[t.id];
      if (t.status === 'ready' && a && t.cacheDir) m.set(t.id, effectiveTrack(t, a));
    }
    return m;
  }, [tracks, analyses]);
}

export interface PairInfo {
  fromEntryId: string;
  toEntryId: string;
  pair: PairScore;
  proposals: TransitionProposal[];
  spec: TransitionSpec; // the spec actually used (stored or automatic)
  stored: TransitionSpec | null;
}

/** Effective transition specs: stored specs that still apply, otherwise the "smooth" proposal. */
export function resolveTransitions(m: Mixtape, tracks: Map<string, EffectiveTrack>): { specs: Record<string, TransitionSpec>; pairs: Record<string, PairInfo> } {
  const specs: Record<string, TransitionSpec> = {};
  const pairs: Record<string, PairInfo> = {};
  const live = m.entries.filter((e) => tracks.has(e.trackId));
  for (let i = 0; i + 1 < live.length; i++) {
    const a = live[i], b = live[i + 1];
    const A = tracks.get(a.trackId)!, B = tracks.get(b.trackId)!;
    const { pair, proposals } = proposeTransitions(A, a, B, b, m.settings);
    const stored = m.transitions[a.id] ?? null;
    const applies = stored && (stored.locked || stored.toEntryId === b.id);
    const spec = applies ? stored! : { ...proposals[0].spec, origin: 'auto' as const, toEntryId: b.id };
    specs[a.id] = spec;
    pairs[a.id] = { fromEntryId: a.id, toEntryId: b.id, pair, proposals, spec, stored: applies ? stored : null };
  }
  return { specs, pairs };
}

export function planFor(m: Mixtape, tracks: Map<string, EffectiveTrack>, specs?: Record<string, TransitionSpec>): MixPlan {
  const s = specs ?? resolveTransitions(m, tracks).specs;
  return buildPlan({ mixtape: { entries: m.entries, transitions: s, settings: m.settings }, tracks });
}

export function useMix() {
  const mixtapes = useStore((s) => s.mixtapes);
  const activeId = useStore((s) => s.activeId);
  const mixtape = mixtapes.find((m) => m.id === activeId) ?? mixtapes[0];
  const tracks = useEffectiveTracks();
  return useMemo(() => {
    const { specs, pairs } = resolveTransitions(mixtape, tracks);
    const plan = buildPlan({ mixtape: { entries: mixtape.entries, transitions: specs, settings: mixtape.settings }, tracks });
    return { mixtape, tracks, specs, pairs, plan };
  }, [mixtape, tracks]);
}
