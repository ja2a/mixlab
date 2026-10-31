// Global playlist ordering: simulated annealing over track orders under lock constraints,
// with several objectives (fluidity, energy arc, harmony, surprise).

import { PairCache, type PairScore } from './compat';
import { entryCues, gridOf, playableEnd, playableStart } from './grid';
import type { EffectiveTrack, MixSettings, PlaylistEntry, TransitionSpec } from '../types';

export type Strategy = 'fluid' | 'energy' | 'harmonic' | 'surprise';

/** Target energy shape over the whole mixtape. 'free' keeps each strategy's own preference. */
export type ArcShape = 'free' | 'rise' | 'peak' | 'plateau' | 'waves' | 'fall';

export const ARC_SHAPES: Record<Exclude<ArcShape, 'free'>, { label: string; description: string; target: (x: number) => number }> = {
  rise: { label: 'Montée', description: 'L’énergie monte du début à la fin.', target: (x) => 0.1 + 0.9 * x },
  peak: { label: 'Pic', description: 'Échauffement, sommet vers 70 %, puis redescente.', target: (x) => (x < 0.7 ? x / 0.7 : 1 - ((x - 0.7) / 0.3) * 0.45) },
  plateau: { label: 'Plateau', description: 'Montée rapide, longue phase intense, fin en douceur.', target: (x) => (x < 0.3 ? 0.2 + (x / 0.3) * 0.75 : x < 0.85 ? 0.95 : 0.95 - ((x - 0.85) / 0.15) * 0.35) },
  waves: { label: 'Vagues', description: 'Deux montées successives, avec une respiration au milieu.', target: (x) => 0.5 - 0.4 * Math.cos(4 * Math.PI * x) },
  fall: { label: 'Descente', description: 'Commence fort et se calme progressivement.', target: (x) => 1 - 0.85 * x },
};

/** Expected target energy (0..1) at relative position x ∈ [0,1], or null for 'free'. */
export function arcTarget(shape: ArcShape, x: number): number | null {
  return shape === 'free' ? null : ARC_SHAPES[shape].target(Math.max(0, Math.min(1, x)));
}

/** Rough mix length of an order: playable lengths minus typical overlaps (default transition length). */
export function estimateSeconds(trackIds: string[], tracks: Map<string, EffectiveTrack>, entries: Map<string, PlaylistEntry> | null, settings: Pick<MixSettings, 'defaultBars' | 'trimBars'>): number {
  let s = 0;
  trackIds.forEach((id, i) => {
    const t = tracks.get(id);
    if (!t) return;
    const c = entryCues(t, entries?.get(id) ?? { cueIn: null, cueOut: null }, settings.trimBars, { first: i === 0, last: i === trackIds.length - 1 });
    s += Math.max(0, playableEnd(t, c.cueOut) - playableStart(t, c.cueIn));
    if (i < trackIds.length - 1) s -= overlapOf(t, settings);
  });
  return Math.max(0, s);
}

function overlapOf(t: EffectiveTrack, settings: Pick<MixSettings, 'defaultBars'>): number {
  const g = gridOf(t);
  return g?.reliable ? Math.min(30, settings.defaultBars * g.bar) : 8;
}

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
  seconds: number; // estimated mix length
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

function arcPenalty(s: Strategy, energies: number[], arc: ArcShape): number {
  const n = energies.length;
  if (n < 3) return 0;
  let total = 0;
  // With a chosen shape every strategy follows it (the energy strategy most closely);
  // otherwise only the energy strategy draws its default peak.
  const shape = arc !== 'free' ? arc : s === 'energy' ? 'peak' : null;
  if (shape) {
    // Energies are on a 1..10 scale; normalise on a span of at least 3 so near-equal tracks are not over-fitted.
    const lo = Math.min(...energies), hi = Math.max(...energies, lo + 3);
    let pen = 0;
    for (let i = 0; i < n; i++) pen += ((energies[i] - lo) / (hi - lo) - ARC_SHAPES[shape].target(i / (n - 1))) ** 2;
    total += ((s === 'energy' ? (arc !== 'free' ? 1.4 : 0.9) : 0.6) * pen) / n;
  }
  if (s === 'fluid' || s === 'harmonic') {
    let pen = 0;
    for (let i = 1; i < n; i++) pen += Math.max(0, Math.abs(energies[i] - energies[i - 1]) - 2) / 4;
    total += (0.5 * pen) / (n - 1);
  }
  return total;
}

export interface OptimizeInput {
  entries: PlaylistEntry[];
  transitions: Record<string, TransitionSpec>;
  tracks: Map<string, EffectiveTrack>;
  settings: MixSettings;
  strategies?: Strategy[];
  iterations?: number;
  /** Energy shape to follow (default 'free'). */
  arc?: ArcShape;
  /** Target mix length (s): only part of the tracks is used, chosen by the optimiser. Locked tracks are always kept. */
  targetSeconds?: number | null;
}

export function evaluateOrder(order: string[], strategy: Strategy, byId: Map<string, PlaylistEntry>, cache: PairCache, tracks: Map<string, EffectiveTrack>, arc: ArcShape = 'free') {
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
  return { score: sum / m - arcPenalty(strategy, energies, arc), meanPair: raw / m, sync, harm, energies };
}

export function generateOrders(input: OptimizeInput): OrderProposal[] {
  const { entries, transitions, tracks, settings } = input;
  const usable = entries.filter((e) => tracks.has(e.trackId));
  const byId = new Map(usable.map((e) => [e.id, e]));
  const cache = new PairCache(tracks, settings);
  // With a chosen shape the energy strategy leads, so it survives deduplication and is preselected.
  const strategies = input.strategies ?? (input.arc && input.arc !== 'free' ? ['energy', 'fluid', 'harmonic', 'surprise'] : ['fluid', 'energy', 'harmonic', 'surprise']);
  const units = buildUnits(usable, transitions);
  const pinned = units.filter((u) => u.pinned !== null);
  const freeUnits = units.filter((u) => u.pinned === null);
  const n = usable.length;
  const manualOrder = usable.map((e) => e.id);
  const results: OrderProposal[] = [];
  const arc = input.arc ?? 'free';
  const target = input.targetSeconds ?? null;
  const cueOf = new Map(usable.map((e) => [e.trackId, e]));
  const seconds = (order: string[]) => estimateSeconds(order.map((id) => byId.get(id)!.trackId), tracks, cueOf, settings);
  // Per-entry contribution to the estimated length (playable length minus a typical overlap).
  const net = new Map(usable.map((e) => {
    const t = tracks.get(e.trackId)!;
    const c = entryCues(t, e, settings.trimBars);
    return [e.id, playableEnd(t, c.cueOut) - playableStart(t, c.cueIn) - overlapOf(t, settings)];
  }));
  const meanOverlap = usable.reduce((s, e) => s + overlapOf(tracks.get(e.trackId)!, settings), 0) / Math.max(1, usable.length);
  const pinnedNet = pinned.reduce((s, u) => s + u.ids.reduce((a, id) => a + net.get(id)!, 0), 0);
  const pinnedCount = pinned.reduce((s, u) => s + u.ids.length, 0);

  /** The free units actually used: all of them, or the prefix that best reaches the target length. */
  const realize = (free: Unit[]): string[] | null => {
    if (target === null) return layout(free, pinned, n);
    let est = pinnedNet + meanOverlap, count = pinnedCount, k = 0;
    const estAt: number[] = [est];
    while (k < free.length && est < target) {
      for (const id of free[k].ids) { est += net.get(id)!; count++; }
      k++;
      estAt.push(est);
    }
    if (k > 0 && Math.abs(estAt[k - 1] - target) < Math.abs(est - target) && count - free[k - 1].ids.length >= 2) k--;
    for (; k <= free.length; k++) {
      const used = free.slice(0, k);
      const order = layout(used, pinned, pinnedCount + used.reduce((s, u) => s + u.ids.length, 0));
      if (order && order.length >= Math.min(2, n)) return order;
    }
    return null;
  };

  for (const [si, strategy] of strategies.entries()) {
    const rand = rng(1234 + si * 977 + n);
    const score = (free: Unit[]) => {
      const order = realize(free);
      if (!order) return null;
      let s = evaluateOrder(order, strategy, byId, cache, tracks, arc).score;
      if (target !== null) s -= (0.6 * Math.abs(seconds(order) - target)) / target;
      return { order, s };
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
    const ev = evaluateOrder(best.order, strategy, byId, cache, tracks, arc);
    const shaped = strategy === 'energy' && arc !== 'free';
    results.push({
      strategy,
      title: shaped ? `Courbe : ${ARC_SHAPES[arc].label}` : META[strategy].title,
      description: shaped ? `Suit au plus près la courbe d’énergie choisie : ${ARC_SHAPES[arc].description.toLowerCase()}` : META[strategy].description,
      order: best.order,
      score: ev.score, meanPair: ev.meanPair, syncable: ev.sync, harmonicOk: ev.harm, energy: ev.energies, seconds: seconds(best.order),
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
    score: manual.score, meanPair: manual.meanPair, syncable: manual.sync, harmonicOk: manual.harm, energy: manual.energies, seconds: seconds(manualOrder),
  });
  return unique;
}
