// Camelot wheel helpers.

import type { KeyInfo, Mode } from '../types';

export const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function camelotNumber(tonic: number, mode: Mode): number {
  const majorTonic = mode === 'major' ? tonic : (tonic + 3) % 12;
  return ((majorTonic * 7 + 7) % 12) + 1;
}

export function camelotCode(tonic: number, mode: Mode): string {
  return `${camelotNumber(tonic, mode)}${mode === 'major' ? 'B' : 'A'}`;
}

export function keyName(tonic: number, mode: Mode): string {
  return `${PITCH_NAMES[tonic]} ${mode === 'major' ? 'majeur' : 'mineur'}`;
}

export function makeKey(tonic: number, mode: Mode, confidence: number): KeyInfo {
  return { tonic, mode, camelot: camelotCode(tonic, mode), name: keyName(tonic, mode), confidence };
}

export function parseCamelot(code: string): { num: number; letter: 'A' | 'B' } | null {
  const m = /^(\d{1,2})([AB])$/i.exec(code.trim());
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  return { num, letter: m[2].toUpperCase() as 'A' | 'B' };
}

export type HarmonicRelation =
  | 'same'
  | 'adjacent' // ±1 same letter
  | 'relative' // same number, other letter
  | 'diagonal' // ±1 and other letter
  | 'boost' // +2 (whole-tone "energy boost")
  | 'semitone' // +7 on the wheel = +1 semitone modulation
  | 'distant';

export interface HarmonicMatch {
  relation: HarmonicRelation;
  score: number; // 0..1
  steps: number; // signed wheel distance (-6..6)
  label: string;
}

const LABELS: Record<HarmonicRelation, string> = {
  same: 'même tonalité',
  adjacent: 'tonalité voisine',
  relative: 'relative majeur/mineur',
  diagonal: 'voisine diagonale',
  boost: 'montée d’énergie (+2)',
  semitone: 'modulation d’un demi-ton',
  distant: 'tonalités éloignées',
};

export function harmonicMatch(a: string, b: string): HarmonicMatch {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return { relation: 'distant', score: 0.4, steps: 0, label: 'tonalité inconnue' };
  let steps = (pb.num - pa.num + 12) % 12;
  if (steps > 6) steps -= 12;
  const sameLetter = pa.letter === pb.letter;
  let relation: HarmonicRelation;
  let score: number;
  if (steps === 0 && sameLetter) { relation = 'same'; score = 1; }
  else if (steps === 0) { relation = 'relative'; score = 0.88; }
  else if (Math.abs(steps) === 1 && sameLetter) { relation = 'adjacent'; score = 0.9; }
  else if (Math.abs(steps) === 1) { relation = 'diagonal'; score = 0.68; }
  else if (steps === 2 && sameLetter) { relation = 'boost'; score = 0.62; }
  else if (Math.abs(steps) === 5 && sameLetter) { relation = 'semitone'; score = 0.5; }
  else { relation = 'distant'; score = Math.max(0.05, 0.4 - 0.06 * Math.abs(steps)); }
  return { relation, score, steps, label: LABELS[relation] };
}

/** Colour hue (degrees) of a Camelot number, matching the conventional wheel. */
export function camelotHue(code: string): number {
  const p = parseCamelot(code);
  if (!p) return 0;
  return ((p.num - 1) * 30 + 75) % 360;
}
