// Global playlist ordering: simulated annealing over track orders under lock constraints,
// with several objectives (fluidity, energy arc, harmony, surprise).

import { PairCache, type PairScore } from './compat';
import type { EffectiveTrack, MixSettings, PlaylistEntry, TransitionSpec } from '../types';

export type Strategy = 'fluid' | 'energy' | 'harmonic' | 'surprise';

export interface OrderProposal {
  strategy: Strategy | 'manual';
  title: string;
  description: string;
  order: string[]; // entry ids
  score: number; // 0..1 average objective
  meanPair: number; // average raw compatibility
  syncable: number; // number of beat-matchable transitions
  harmonicOk: number; // transitions with compatible keys
  energy: number[]; // energy per position
}

const META: Record<Strategy, { title: string; description: string }> = {
  fluid: { title: 'Fluide', description: 'Maximise la compatibilité globale (tempo, tonalité, énergie, structure) de chaque enchaînement.' },
  energy: { title: 'Montée en puissance', description: 'Construit un arc d’énergie : échauffement, montée, sommet vers 70 %, puis redescente.' },
  harmonic: { title: 'Harmonique', description: 'Privilégie les enchaînements harmoniques (roue Camelot) tout en gardant des tempos synchronisables.' },
  surprise: { title: 'Contrastes maîtrisés', description: 'Recherche des changements de couleur (modulations, demi-tempo, ruptures d’énergie) restant synchronisables.' },
};

function rng(seed: number) {
  let s = seed >>> 0 || 7;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface Unit {
  ids: string[]; // entry ids in fixed internal order
  pinned: number | null; // fixed start index
}

/** Group entries into units: chains glued by locked transitions; pin units that contain a locked entry. */
export function buildUnits(entries: PlaylistEntry[], transitions: Record<string, TransitionSpec>): Unit[] {
  const units: Unit[] = [];
  let cur: Unit | null = null;
  entries.forEach((e, i) => {
    if (!cur) cur = { ids: [], pinned: null };
    cur.ids.push(e.id);
    if (e.locked && cur.pinned === null) cur.pinned = i - (cur.ids.length - 1);
    const glued = transitions[e.id]?.locked && i < entries.length - 1;
    if (!glued) { units.push(cur); cur = null; }
  });
  if (cur) units.push(cur);
  return units;
}

/** Lay out free units around pinned units. Returns null if impossible. */
export function layout(free: Unit[], pinned: Unit[], n: number): string[] | null {
  const out: string[] = [];
  const pins = [...pinned].sort((a, b) => a.pinned! - b.pinned!);
  const queue = [...free];
  let pi = 0;
  while (out.length < n) {
    const pos = out.length;
    if (pi < pins.length && pins[pi].pinned === pos) {
      out.push(...pins[pi].ids);
      pi++;
      continue;
    }
    const gap = (pi < pins.length ? pins[pi].pinned! : n) - pos;
    const k = queue.findIndex((u) => u.ids.length <= gap);
    if (k < 0) return null;
    out.push(...queue[k].ids);
    queue.splice(k, 1);
  }
  return queue.length === 0 && pi === pins.length ? out : null;
}

function pairObjective(s: Strategy, p: PairScore): number {
  switch (s) {
    case 'fluid': return p.total;
    case 'harmonic': return 0.55 * p.harmonic.score + 0.3 * p.tempo.score + 0.15 * p.energy.score;
    case 'energy': return 0.45 * p.tempo.score + 0.25 * p.harmonic.score + 0.15 * p.structure.score + 0.15 * p.vocal.score;
    case 'surprise': {
      const colour = ['boost', 'semitone', 'relative', 'diagonal'].includes(p.harmonic.relation) ? 1 : p.harmonic.relation === 'same' ? 0.2 : 0.5;
      const contrast = Math.min(1, Math.abs(p.energy.delta) / 2.5);
      const groove = p.tempo.factor !== 1 && p.tempo.syncable ? 1 : 0.3;
      return 0.4 * p.tempo.score + 0.25 * colour + 0.2 * contrast + 0.15 * groove;
    }
  }
}

function arcPenalty(s: Strategy, energies: number[]): number {
  const n = energies.length;
  if (n < 3) return 0;
  const lo = Math.min(...energies), hi = Math.max(...energies);
  if (s === 'energy') {
    let pen = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const tgt = x < 0.7 ? x / 0.7 : 1 - ((x - 0.7) / 0.3) * 0.45;
      const e = hi > lo ? (energies[i] - lo) / (hi - lo) : 0.5;
      pen += (e - tgt) ** 2;
    }
    return (0.9 * pen) / n;
  }
  if (s === 'fluid' || s === 'harmonic') {
    let pen = 0;
    for (let i = 1; i < n; i++) pen += Math.max(0, Math.abs(energies[i] - energies[i - 1]) - 2) / 4;
    return (0.5 * pen) / (n - 1);
  }
  return 0;
}

export interface OptimizeInput {
  entries: PlaylistEntry[];
  transitions: Record<string, TransitionSpec>;
  tracks: Map<string, EffectiveTrack>;
  settings: MixSettings;
  strategies?: Strategy[];
  iterations?: number;
}

export function evaluateOrder(order: string[], strategy: Strategy, byId: Map<string, PlaylistEntry>, cache: PairCache, tracks: Map<string, EffectiveTrack>) {
  let sum = 0, raw = 0, sync = 0, harm = 0;
  const energies = order.map((id) => tracks.get(byId.get(id)!.trackId)?.analysis.energy ?? 5);
  for (let i = 0; i + 1 < order.length; i++) {
    const p = cache.get(byId.get(order[i])!.trackId, byId.get(order[i + 1])!.trackId);
    sum += pairObjective(strategy, p);
    raw += p.total;
    if (p.tempo.syncable) sync++;
    if (p.harmonic.score >= 0.6) harm++;
  }
  const m = Math.max(1, order.length - 1);
  return { score: sum / m - arcPenalty(strategy, energies), meanPair: raw / m, sync, harm, energies };
}

export function generateOrders(input: OptimizeInput): OrderProposal[] {
  const { entries, transitions, tracks, settings } = input;
  const usable = entries.filter((e) => tracks.has(e.trackId));
  const byId = new Map(usable.map((e) => [e.id, e]));
  const cache = new PairCache(tracks, settings);
  const strategies = input.strategies ?? ['fluid', 'energy', 'harmonic', 'surprise'];
  const units = buildUnits(usable, transitions);
  const pinned = units.filter((u) => u.pinned !== null);
  const freeUnits = units.filter((u) => u.pinned === null);
  const n = usable.length;
  const manualOrder = usable.map((e) => e.id);
  const results: OrderProposal[] = [];

  for (const [si, strategy] of strategies.entries()) {
    const rand = rng(1234 + si * 977 + n);
    const score = (free: Unit[]) => {
      const order = layout(free, pinned, n);
      return order ? { order, s: evaluateOrder(order, strategy, byId, cache, tracks).score } : null;
    };
    // Greedy start: nearest neighbour on the free units from the best first unit.
    let best: { free: Unit[]; order: string[]; s: number } | null = null;
    const starts = freeUnits.length ? freeUnits.slice(0, 12) : [];
    for (const first of starts.length ? starts : [null]) {
      const remaining = freeUnits.filter((u) => u !== first);
      const seq: Unit[] = first ? [first] : [];
      while (remaining.length) {
        const last = seq.length ? seq[seq.length - 1].ids[seq[seq.length - 1].ids.length - 1] : null;
        let bi = 0, bv = -Infinity;
        remaining.forEach((u, i) => {
          const v = last ? pairObjective(strategy, cache.get(byId.get(last)!.trackId, byId.get(u.ids[0])!.trackId)) : 0;
          if (v > bv) { bv = v; bi = i; }
        });
        seq.push(remaining.splice(bi, 1)[0]);
      }
      const r = score(seq);
      if (r && (!best || r.s > best.s)) best = { free: seq, order: r.order, s: r.s };
    }
    if (!best) {
      const r = score(freeUnits);
      if (!r) continue;
      best = { free: [...freeUnits], order: r.order, s: r.s };
    }
    // Simulated annealing
    let cur = { ...best, free: [...best.free] };
    const iters = input.iterations ?? Math.min(60000, 1500 * Math.max(4, freeUnits.length));
    let T = 0.08;
    const cool = Math.pow(0.0005 / T, 1 / iters);
    for (let it = 0; it < iters && freeUnits.length > 1; it++, T *= cool) {
      const cand = [...cur.free];
      const a = Math.floor(rand() * cand.length);
      let b = Math.floor(rand() * cand.length);
      if (a === b) b = (b + 1) % cand.length;
      const mv = rand();
      if (mv < 0.4) [cand[a], cand[b]] = [cand[b], cand[a]];
      else if (mv < 0.75) { const [u] = cand.splice(a, 1); cand.splice(b, 0, u); }
      else { const i = Math.min(a, b), j = Math.max(a, b); const seg = cand.slice(i, j + 1).reverse(); cand.splice(i, seg.length, ...seg); }
      const r = score(cand);
      if (!r) continue;
      if (r.s >= cur.s || rand() < Math.exp((r.s - cur.s) / T)) {
        cur = { free: cand, order: r.order, s: r.s };
        if (r.s > best.s) best = { free: cand, order: r.order, s: r.s };
      }
    }
    const ev = evaluateOrder(best.order, strategy, byId, cache, tracks);
    results.push({
      strategy, title: META[strategy].title, description: META[strategy].description, order: best.order,
      score: ev.score, meanPair: ev.meanPair, syncable: ev.sync, harmonicOk: ev.harm, energy: ev.energies,
    });
  }

  // Deduplicate identical orders (keep the first strategy that found it).
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const k = r.order.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const manual = evaluateOrder(manualOrder, 'fluid', byId, cache, tracks);
  unique.unshift({
    strategy: 'manual', title: 'Ordre actuel', description: 'Votre ordre, conservé tel quel.', order: manualOrder,
    score: manual.score, meanPair: manual.meanPair, syncable: manual.sync, harmonicOk: manual.harm, energy: manual.energies,
  });
  return unique;
}
