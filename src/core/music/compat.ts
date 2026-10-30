// Pairwise compatibility between an outgoing track A and an incoming track B.

import { harmonicMatch, type HarmonicRelation } from './camelot';
import { gridOf, introEnd, outroStart, tempoRelation } from './grid';
import type { EffectiveTrack, MixSettings } from '../types';

export interface PairScore {
  total: number; // 0..1
  tempo: { score: number; stretchPct: number; factor: number; syncable: boolean; known: boolean; label: string };
  harmonic: { score: number; relation: HarmonicRelation | 'unknown'; label: string; known: boolean };
  energy: { score: number; delta: number; label: string };
  structure: { score: number; hasOutro: boolean; hasIntro: boolean };
  vocal: { score: number; clash: number };
  loudnessDiff: number | null;
  reasons: string[];
}

const fmtPct = (x: number) => `${x.toFixed(1).replace('.', ',')} %`;
const fmt1 = (x: number) => x.toFixed(1).replace('.', ',');
const fmtBpm = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : fmt1(x));

function edgeMean(arr: number[], fromEnd: boolean, n = 16): number {
  if (!arr.length) return 0;
  const s = fromEnd ? arr.slice(-n) : arr.slice(0, n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function pairScore(A: EffectiveTrack, B: EffectiveTrack, settings: Pick<MixSettings, 'maxStretchPct'>): PairScore {
  const reasons: string[] = [];
  const gA = gridOf(A), gB = gridOf(B);

  // Tempo
  let tempo: PairScore['tempo'];
  if (A.bpm && B.bpm) {
    const rel = tempoRelation(A.bpm, B.bpm);
    const max = settings.maxStretchPct;
    let s: number;
    if (rel.stretchPct <= 0.3) s = 1;
    else if (rel.stretchPct <= max) s = 1 - 0.55 * Math.pow(rel.stretchPct / max, 1.3);
    else s = Math.max(0, 0.3 - (rel.stretchPct - max) / 25);
    if (rel.factor !== 1) s *= 0.85;
    const conf = Math.min(A.bpmConfidence, B.bpmConfidence);
    s = s * conf + 0.45 * (1 - conf);
    const syncable = !!gA?.reliable && !!gB?.reliable && rel.stretchPct <= max;
    const label = rel.factor !== 1
      ? `${rel.factor === 2 ? 'demi' : 'double'}-tempo (${fmtBpm(A.bpm)} ↔ ${fmtBpm(B.bpm)} BPM, ${fmtPct(rel.stretchPct)})`
      : rel.stretchPct < 0.3
        ? `même tempo (${fmtBpm(A.bpm)} BPM)`
        : `tempo ${fmtBpm(A.bpm)} → ${fmtBpm(B.bpm)} BPM (${fmtPct(rel.stretchPct)})`;
    tempo = { score: s, stretchPct: rel.stretchPct, factor: rel.factor, syncable, known: true, label };
    if (syncable) reasons.push(rel.stretchPct < 0.3 && rel.factor === 1 ? `Tempos identiques : calage sur les temps sans time-stretch` : `Tempo compatible : ${label}, synchronisation possible`);
    else if (rel.stretchPct > max) reasons.push(`Écart de tempo trop important (${fmtPct(rel.stretchPct)}) pour un beatmatch`);
    else reasons.push('Grille rythmique peu fiable : calage approximatif');
  } else {
    tempo = { score: 0.4, stretchPct: 0, factor: 1, syncable: false, known: false, label: 'tempo inconnu' };
    reasons.push('BPM indisponible : transition sans synchronisation');
  }

  // Harmony
  let harmonic: PairScore['harmonic'];
  if (A.key && B.key) {
    const hm = harmonicMatch(A.key.camelot, B.key.camelot);
    const conf = Math.min(A.key.confidence, B.key.confidence);
    const s = hm.score * (0.4 + 0.6 * conf) + 0.5 * (1 - (0.4 + 0.6 * conf));
    harmonic = { score: s, relation: hm.relation, label: `${A.key.camelot} → ${B.key.camelot} (${hm.label})`, known: true };
    if (hm.score >= 0.85) reasons.push(`Harmonie : ${harmonic.label}`);
    else if (hm.score >= 0.6) reasons.push(`Changement harmonique intéressant : ${harmonic.label}`);
    else reasons.push(`Tonalités éloignées (${A.key.camelot} → ${B.key.camelot}) : préférer un mélange court`);
  } else {
    harmonic = { score: 0.45, relation: 'unknown', label: 'tonalité inconnue', known: false };
  }

  // Energy
  const eA = A.analysis.energy ?? 5, eB = B.analysis.energy ?? 5;
  const delta = eB - eA;
  const eScore = 1 - Math.min(1, Math.abs(delta) / 4);
  const energy = {
    score: eScore,
    delta,
    label: Math.abs(delta) < 0.6 ? 'énergie stable' : delta > 0 ? `énergie en hausse (+${fmt1(delta)})` : `énergie en baisse (${fmt1(delta)})`,
  };
  if (Math.abs(delta) < 1.5) reasons.push(`Énergie cohérente (${fmt1(eA)} → ${fmt1(eB)})`);
  else reasons.push(`Saut d’énergie ${delta > 0 ? 'montant' : 'descendant'} (${fmt1(eA)} → ${fmt1(eB)})`);

  // Structure
  const hasOutro = outroStart(A) !== null;
  const hasIntro = introEnd(B) !== null;
  const structure = { score: hasOutro && hasIntro ? 1 : hasOutro || hasIntro ? 0.72 : 0.5, hasOutro, hasIntro };
  if (hasOutro && hasIntro) reasons.push('Outro de A et intro de B disponibles pour un long mélange');

  // Vocal overlap (heuristic)
  const vA = edgeMean(A.analysis.barVocal, true);
  const vB = edgeMean(B.analysis.barVocal, false);
  const clash = vA * vB;
  const vocal = { score: 1 - clash, clash };
  if (clash > 0.45) reasons.push('Présence mélodique/vocale probable des deux côtés : risque de superposition');

  const loudnessDiff = A.analysis.lufs !== null && B.analysis.lufs !== null ? B.analysis.lufs - A.analysis.lufs : null;

  const total = 0.36 * tempo.score + 0.28 * harmonic.score + 0.16 * energy.score + 0.1 * structure.score + 0.1 * vocal.score;
  return { total, tempo, harmonic, energy, structure, vocal, loudnessDiff, reasons };
}

/** Cache of pair scores keyed by track ids. */
export class PairCache {
  private map = new Map<string, PairScore>();
  constructor(private readonly tracks: Map<string, EffectiveTrack>, private readonly settings: Pick<MixSettings, 'maxStretchPct'>) {}
  get(a: string, b: string): PairScore {
    const k = a + '>' + b;
    let v = this.map.get(k);
    if (!v) {
      v = pairScore(this.tracks.get(a)!, this.tracks.get(b)!, this.settings);
      this.map.set(k, v);
    }
    return v;
  }
}
