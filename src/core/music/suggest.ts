// Transition proposals for a pair of consecutive tracks, computed from their real analysis.

import { pairScore, type PairScore } from './compat';
import { entryCues, firstDrop, gridOf, introEnd, outroStart, playableEnd, playableStart, snapToDownbeat } from './grid';
import type { EffectiveTrack, MixSettings, PlaylistEntry, ProposalKind, TransitionSpec } from '../types';

export interface TransitionProposal {
  kind: ProposalKind;
  title: string;
  subtitle: string;
  spec: TransitionSpec;
  score: number; // 0..1, for this proposal's objective
  reasons: string[];
  caveats: string[];
}

const TITLES: Record<ProposalKind, string> = {
  smooth: 'La plus fluide',
  energetic: 'La plus énergique',
  harmonic: 'La plus harmonique',
  surprise: 'Surprenante mais cohérente',
};

function pow2Below(x: number, choices = [32, 16, 8, 4]): number {
  return choices.find((c) => c <= x) ?? 4;
}

function base(overrides: Partial<TransitionSpec>): TransitionSpec {
  return {
    type: 'eq', bars: 16, seconds: 8, fadeOut: 'equalPower', fadeIn: 'equalPower', outStart: null, inStart: null,
    bassSwap: true, swapPoint: 0.5, locked: false, origin: 'proposal', ...overrides,
  };
}

export function proposeTransitions(
  A: EffectiveTrack, eA: PlaylistEntry,
  B: EffectiveTrack, eB: PlaylistEntry,
  settings: MixSettings,
): { pair: PairScore; proposals: TransitionProposal[] } {
  const pair = pairScore(A, B, settings);
  const gA = gridOf(A), gB = gridOf(B);
  const sync = pair.tempo.syncable;
  const cA = entryCues(A, eA, settings.trimBars, { first: false, last: false });
  const cB = entryCues(B, eB, settings.trimBars, { first: false, last: false });
  const aEnd = playableEnd(A, cA.cueOut);
  const bStart = playableStart(B, cB.cueIn);
  const outro = outroStart(A);
  const intro = introEnd(B);
  const drop = firstDrop(B);
  const outroBars = gA && outro !== null ? Math.max(0, Math.floor((aEnd - outro) / gA.bar)) : 0;
  const introBars = gB && intro !== null ? Math.max(0, Math.floor((intro - bStart) / gB.bar)) : 0;
  const hm = pair.harmonic;
  const proposals: TransitionProposal[] = [];
  const tempoReason = pair.tempo.label;

  // 1. Smooth: long beat-matched EQ blend over outro/intro.
  {
    const reasons: string[] = [];
    const caveats: string[] = [];
    let spec: TransitionSpec;
    if (sync && gA && gB) {
      const room = Math.max(outroBars, introBars, 8);
      const clash = hm.known && hm.score < 0.4;
      const bars = clash ? 8 : pow2Below(Math.min(room >= 8 ? room : 16, hm.score >= 0.6 ? 32 : 16));
      const outStart = outro !== null && outroBars >= bars ? snapToDownbeat(gA, outro) : null;
      spec = base({ type: introBars >= 4 && outroBars >= 4 ? 'structure' : 'eq', bars, outStart, inStart: null, swapPoint: 0.5 });
      reasons.push(`Calage sur les mesures, ${bars} mesures`, tempoReason);
      if (outStart !== null) reasons.push('Sortie au début de l’outro de A');
      if (introBars) reasons.push(`Entrée sur l’intro de B (${introBars} mesures)`);
      reasons.push('Échange progressif des basses à mi-transition');
      if (clash) caveats.push('Tonalités éloignées : mélange volontairement limité à 8 mesures');
    } else {
      spec = base({ type: 'curve', seconds: 12, fadeOut: 'sCurve', fadeIn: 'sCurve', bassSwap: false });
      reasons.push('Long fondu en S de 12 s');
      caveats.push(pair.tempo.known ? 'Pas de synchronisation possible : fondu non calé sur les temps' : 'BPM inconnu : fondu non calé sur les temps');
    }
    if (hm.known) reasons.push(`Harmonie : ${hm.label}`);
    const score = 0.4 * pair.tempo.score + 0.22 * hm.score + 0.2 * pair.structure.score + 0.18 * pair.energy.score;
    proposals.push({ kind: 'smooth', title: TITLES.smooth, subtitle: spec.type === 'curve' ? 'Fondu long' : `${spec.bars} mesures · EQ`, spec, score, reasons, caveats });
  }

  // 2. Energetic: short punchy blend, B enters on its drop when there is one early enough.
  {
    const reasons: string[] = [];
    const caveats: string[] = [];
    let spec: TransitionSpec;
    const dropUsable = drop !== null && gB && drop - bStart < (playableEnd(B, cB.cueOut) - bStart) * 0.45 && drop > bStart + 1;
    if (sync && gA && gB) {
      const bars = dropUsable ? 8 : 4;
      const inStart = dropUsable ? snapToDownbeat(gB, drop! - bars * gB.bar) : null;
      spec = base({ type: 'eq', bars, inStart, swapPoint: 0.75, fadeIn: 'logarithmic', fadeOut: 'exponential', effect: dropUsable ? 'loop' : 'filter' });
      reasons.push(`Mélange court de ${bars} mesures`, tempoReason);
      if (dropUsable) reasons.push('B entre juste avant son premier drop : A finit en boucle accélérée, l’énergie explose à la fin de la transition');
      else reasons.push('Balayage de filtre : B s’ouvre pendant que A s’efface dans les aigus');
      reasons.push('Bass swap tardif pour garder la tension');
    } else {
      spec = base({ type: 'curve', seconds: 3, fadeOut: 'exponential', fadeIn: 'logarithmic', bassSwap: false, inStart: dropUsable ? drop! : null });
      reasons.push('Enchaînement rapide (3 s)');
      if (dropUsable) reasons.push('B démarre directement sur son drop');
      caveats.push('Transition non synchronisée');
    }
    if (pair.energy.delta > 0.4) reasons.push(`Gain d’énergie : ${pair.energy.label}`);
    const eUp = Math.max(0, Math.min(1, 0.5 + pair.energy.delta / 4));
    const score = 0.35 * pair.tempo.score + 0.35 * eUp + 0.15 * (dropUsable ? 1 : 0.4) + 0.15 * hm.score;
    proposals.push({ kind: 'energetic', title: TITLES.energetic, subtitle: spec.type === 'curve' ? 'Coupe rapide' : `${spec.bars} mesures · drop`, spec, score, reasons, caveats });
  }

  // 3. Harmonic: length driven by key compatibility.
  {
    const reasons: string[] = [];
    const caveats: string[] = [];
    let spec: TransitionSpec;
    const tier = !hm.known ? 'unknown' : hm.score >= 0.6 ? 'good' : hm.score >= 0.4 ? 'partial' : 'clash';
    if (sync && gA && gB) {
      const bars = tier === 'good' ? pow2Below(Math.max(16, Math.min(32, Math.max(outroBars, introBars)))) : tier === 'partial' || tier === 'unknown' ? 8 : 4;
      spec = base({ type: 'eq', bars, swapPoint: tier === 'good' ? 0.5 : 0.4, fadeIn: tier === 'good' ? 'sCurve' : 'equalPower' });
      reasons.push(
        tier === 'good' ? `Long mélange de ${bars} mesures : les tonalités se superposent bien`
          : tier === 'partial' ? `Compatibilité harmonique partielle : superposition de ${bars} mesures`
          : tier === 'clash' ? 'Tonalités peu compatibles : superposition limitée à 4 mesures'
          : `Mélange de ${bars} mesures`,
        tempoReason,
      );
    } else {
      const good = tier === 'good';
      spec = base({ type: 'curve', seconds: good ? 10 : tier === 'partial' ? 6 : 4, fadeOut: 'equalPower', fadeIn: 'equalPower', bassSwap: false });
      reasons.push(good ? 'Fondu de 10 s sur des tonalités compatibles' : 'Fondu court pour éviter le conflit harmonique');
      caveats.push('Transition non synchronisée');
    }
    if (hm.known) reasons.unshift(`Tonalités ${hm.label}`);
    else caveats.push('Tonalité inconnue : choix harmonique non vérifiable');
    const score = 0.55 * hm.score + 0.3 * pair.tempo.score + 0.15 * pair.vocal.score;
    proposals.push({ kind: 'harmonic', title: TITLES.harmonic, subtitle: hm.known ? hm.label : 'tonalité inconnue', spec, score, reasons, caveats });
  }

  // 4. Surprise: half/double-time, energy-boost modulation or entry on B's break.
  {
    const reasons: string[] = [];
    const caveats: string[] = [];
    let spec: TransitionSpec;
    let novelty = 0.4;
    const brk = B.analysis.sections.find((s) => s.label === 'break' && s.start > bStart + 8);
    if (sync && gA && gB && pair.tempo.factor !== 1) {
      spec = base({ type: 'beatsync', bars: 8, bassSwap: true, swapPoint: 0.5, fadeIn: 'sCurve', fadeOut: 'sCurve' });
      reasons.push(`Calage en ${pair.tempo.factor === 2 ? 'demi' : 'double'}-tempo : changement de groove`, tempoReason);
      novelty = 0.9;
    } else if (sync && gA && gB && (hm.relation === 'boost' || hm.relation === 'semitone' || hm.relation === 'relative')) {
      spec = base({ type: 'eq', bars: 8, swapPoint: 0.6, fadeIn: 'logarithmic' });
      reasons.push(`Modulation assumée (${hm.label}) sur 8 mesures`, tempoReason);
      novelty = 0.8;
    } else if (sync && gA && gB && brk) {
      spec = base({ type: 'eq', bars: 8, inStart: snapToDownbeat(gB, brk.start), swapPoint: 0.5 });
      reasons.push('B entre directement sur son break : respiration inattendue', tempoReason);
      novelty = 0.75;
    } else if (sync && gA && gB) {
      spec = base({ type: 'beatsync', bars: 2, bassSwap: false, fadeOut: 'exponential', fadeIn: 'logarithmic', effect: 'echo' });
      reasons.push('Cut quasi sec sur 2 mesures, calé sur la fin de phrase, avec un écho de A calé sur le tempo', tempoReason);
      novelty = 0.6;
    } else {
      spec = base({ type: 'curve', seconds: 1.5, fadeOut: 'exponential', fadeIn: 'logarithmic', bassSwap: false, effect: 'echo' });
      reasons.push('Coupe franche en fin de phrase (1,5 s), A s’éteint en écho');
      caveats.push('Transition non synchronisée');
      novelty = 0.5;
    }
    const score = 0.4 * novelty + 0.35 * pair.tempo.score + 0.25 * Math.max(hm.score, 0.4);
    proposals.push({ kind: 'surprise', title: TITLES.surprise, subtitle: spec.type === 'curve' ? 'Coupe franche' : `${spec.bars} mesures`, spec, score, reasons, caveats });
  }

  for (const p of proposals) p.spec.proposal = p.kind;
  return { pair, proposals };
}
