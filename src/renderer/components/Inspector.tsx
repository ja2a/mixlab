import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Headphones, Info, Lock, LockOpen, RotateCcw, SlidersHorizontal, Sparkles, X, Play,
} from 'lucide-react';
import { useStore } from '../state/store';
import { player } from '../lib/player';
import { usePlayer } from '../lib/usePlayer';
import { planFor, type PairInfo } from '../lib/derived';
import { fmtBpm, fmtDb, fmtTime, keyColor, trackHue } from '../lib/format';
import { Button, Chip, IconButton, ScoreGauge, Segmented, Slider, Stepper, Toggle, EmptyState } from './ui';
import { Cover, BpmChip, KeyChip } from './Library';
import { Waveform } from './Waveform';
import { EFFECT_META, TYPE_META, semitonesLabel } from './Playlist';
import { envelopes, type MixPlan, type PlannedTransition } from '../../core/mix/plan';
import { gridOf, snapToDownbeat, barIndex, withPitch } from '../../core/music/grid';
import { bestTransposition, camelotCode, harmonicMatch, keyName, makeKey } from '../../core/music/camelot';
import type { CurveShape, EffectiveTrack, Mixtape, TransitionEffect, TransitionSpec, TransitionType } from '../../core/types';

const CURVES: Array<{ value: CurveShape; label: string }> = [
  { value: 'equalPower', label: 'Puissance constante' },
  { value: 'linear', label: 'Linéaire' },
  { value: 'sCurve', label: 'Courbe en S' },
  { value: 'exponential', label: 'Exponentielle (lente)' },
  { value: 'logarithmic', label: 'Logarithmique (rapide)' },
];

const PROPOSAL_ICON = { smooth: '≈', energetic: '↑', harmonic: '♪', surprise: '✦' } as const;

function CurvePreview({ t, spec }: { t: PlannedTransition; spec: TransitionSpec }) {
  const env = envelopes({ ...t, fadeIn: spec.fadeIn, fadeOut: spec.fadeOut, bassSwap: t.type === 'crossfade' ? false : spec.bassSwap, swapPoint: spec.swapPoint });
  const W = 320, H = 96, N = 64;
  const path = (fn: (u: number) => number) =>
    Array.from({ length: N + 1 }, (_, i) => {
      const u = i / N;
      return `${i ? 'L' : 'M'}${(u * W).toFixed(1)},${(H - 6 - fn(u) * (H - 12)).toFixed(1)}`;
    }).join(' ');
  return (
    <svg className="curve-preview" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Automation de la transition">
      <defs>
        <linearGradient id="gA" x1="0" x2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.9" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0.2" /></linearGradient>
        <linearGradient id="gB" x1="0" x2="1"><stop offset="0" stopColor="var(--violet)" stopOpacity="0.2" /><stop offset="1" stopColor="var(--violet)" stopOpacity="0.95" /></linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((x) => <line key={x} x1={x * W} x2={x * W} y1={0} y2={H} className="curve-grid" />)}
      <path d={path(env.outFader)} className="curve-a" stroke="url(#gA)" />
      <path d={path(env.inFader)} className="curve-b" stroke="url(#gB)" />
      {env.outEq && <path d={path(env.outEq.low)} className="curve-a-low" />}
      {env.inEq && <path d={path(env.inEq.low)} className="curve-b-low" />}
    </svg>
  );
}

function TransitionStudio({ t, info, plan, mixtape, tracks, specs }: { t: PlannedTransition; info: PairInfo; plan: MixPlan; mixtape: Mixtape; tracks: Map<string, EffectiveTrack>; specs: Record<string, TransitionSpec> }) {
  const patchTransition = useStore((s) => s.patchTransition);
  const setTransition = useStore((s) => s.setTransition);
  const clearTransition = useStore((s) => s.clearTransition);
  const patchEntry = useStore((s) => s.patchEntry);
  const covers = useStore((s) => s.covers);
  const select = useStore((s) => s.select);
  const ps = usePlayer(10);
  const spec = info.spec;
  const eA = mixtape.entries.find((e) => e.id === t.fromEntryId)!;
  const eB = mixtape.entries.find((e) => e.id === t.toEntryId)!;
  const A = withPitch(tracks.get(eA.trackId)!, eA.pitch);
  const B = withPitch(tracks.get(eB.trackId)!, eB.pitch);
  const gA = gridOf(A), gB = gridOf(B);
  // Transposing B (within ±2 semitones, on top of its current shift) when that clearly fixes the harmony.
  const fix = A.key && B.key && info.pair.harmonic.score < 0.6 ? bestTransposition(A.key, B.key, 2) : null;
  const fixPitch = fix && fix.semitones && fix.match.score >= 0.85 ? (eB.pitch ?? 0) + fix.semitones : null;
  const patch = (p: Partial<TransitionSpec>) => patchTransition(t.fromEntryId, spec, p);
  const beatTypes: TransitionType[] = ['beatsync', 'eq', 'structure'];
  const isBeat = beatTypes.includes(spec.type);
  const auditioning = ps.auditioning;

  const listen = (s: TransitionSpec | null, label: string) => {
    const p = s ? planFor(mixtape, tracks, { ...specs, [t.fromEntryId]: { ...s, toEntryId: t.toEntryId } }) : plan;
    const tt = p.transitions.find((x) => x.fromEntryId === t.fromEntryId) ?? t;
    void player().audition(p, label, tt.start - 6, tt.end + 4);
  };

  const nudge = (which: 'out' | 'in', deltaBars: number) => {
    const g = which === 'out' ? gA : gB;
    const cur = which === 'out' ? (spec.outStart ?? t.aStart) : (spec.inStart ?? t.bStart);
    const step = g && t.synced ? g.bar : 1;
    let next = cur + deltaBars * step;
    if (g && t.synced) next = snapToDownbeat(g, next);
    patch(which === 'out' ? { outStart: Math.max(0, next) } : { inStart: Math.max(0, next) });
  };

  return (
    <div className="studio">
      <header className="studio-head">
        <div className="pair">
          <button className="pair-side" onClick={() => select({ kind: 'entry', entryId: eA.id })}>
            <Cover url={covers[A.id]} title={A.title} size={40} />
            <span className="pair-text"><span className="pair-title">{A.title}</span><span className="pair-sub"><span className="num">{fmtBpm(A.bpm)}</span> BPM · {A.key?.camelot ?? '—'}</span></span>
          </button>
          <ArrowRight size={15} className="tone-dim" />
          <button className="pair-side" onClick={() => select({ kind: 'entry', entryId: eB.id })}>
            <Cover url={covers[B.id]} title={B.title} size={40} />
            <span className="pair-text"><span className="pair-title">{B.title}</span><span className="pair-sub"><span className="num">{fmtBpm(B.bpm)}</span> BPM · {B.key?.camelot ?? '—'}</span></span>
          </button>
        </div>
        <div className="compat">
          <ScoreGauge value={info.pair.total} size={52} />
          <div className="compat-rows">
            <CompatRow label="Tempo" value={info.pair.tempo.score} text={info.pair.tempo.label} />
            <CompatRow label="Harmonie" value={info.pair.harmonic.score} text={info.pair.harmonic.label} />
            <CompatRow label="Énergie" value={info.pair.energy.score} text={info.pair.energy.label} />
          </div>
        </div>
      </header>

      <div className="studio-actions">
        <Button variant="primary" icon={<Headphones size={15} />} onClick={() => listen(null, 'current')} data-testid="listen-transition">
          {auditioning === 'current' && ps.playing ? 'Lecture…' : 'Écouter la transition'}
        </Button>
        <IconButton label={spec.locked ? 'Déverrouiller la transition' : 'Verrouiller (l’algorithme ne la modifiera plus)'} active={spec.locked} onClick={() => patch({ locked: !spec.locked, origin: spec.origin })}>
          {spec.locked ? <Lock size={15} /> : <LockOpen size={15} />}
        </IconButton>
        {info.stored && !spec.locked && (
          <IconButton label="Revenir à la transition automatique" onClick={() => clearTransition(t.fromEntryId)}>
            <RotateCcw size={15} />
          </IconButton>
        )}
      </div>

      {t.notes.length > 0 && (
        <div className={`notes sev-${t.severity}`}>
          {t.notes.map((n, i) => (
            <div key={i} className="note">{t.severity === 'info' ? <Info size={13} /> : <AlertTriangle size={13} />}<span>{n}</span></div>
          ))}
        </div>
      )}

      {fix && fixPitch !== null && Math.abs(fixPitch) <= 3 && (
        <div className="notes sev-info" data-testid="pitch-suggestion">
          <div className="note">
            <Info size={13} />
            <span>Transposer B de {semitonesLabel(fix.semitones)} donnerait {A.key!.camelot} → {fix.key.camelot} ({fix.match.label}), sans changer son tempo.</span>
          </div>
          <Button size="sm" variant="glass" onClick={() => patchEntry(eB.id, { pitch: fixPitch })}>Transposer B</Button>
        </div>
      )}

      <section className="studio-section">
        <h3 className="section-title"><Sparkles size={13} /> Propositions</h3>
        <div className="proposals">
          {info.proposals.map((p) => {
            const active = spec.proposal === p.kind && spec.origin !== 'manual';
            return (
              <div key={p.kind} className={`proposal ${active ? 'is-active' : ''}`} data-testid="proposal">
                <div className="proposal-head">
                  <span className={`proposal-glyph k-${p.kind}`}>{PROPOSAL_ICON[p.kind]}</span>
                  <span className="proposal-titles">
                    <span className="proposal-title">{p.title}</span>
                    <span className="proposal-sub">{p.subtitle}</span>
                  </span>
                  <span className="proposal-score num">{Math.round(p.score * 100)}</span>
                </div>
                <ul className="proposal-reasons">
                  {p.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}
                  {p.caveats.map((c, i) => <li key={'c' + i} className="is-caveat">{c}</li>)}
                </ul>
                <div className="proposal-actions">
                  <Button size="sm" variant="ghost" icon={<Headphones size={13} />} onClick={() => listen(p.spec, p.kind)}>
                    {auditioning === p.kind && ps.playing ? 'Lecture…' : 'Écouter'}
                  </Button>
                  <Button size="sm" variant={active ? 'plain' : 'glass'} icon={active ? <Check size={13} /> : undefined} disabled={active || spec.locked} onClick={() => setTransition(t.fromEntryId, { ...p.spec, origin: 'proposal', toEntryId: t.toEntryId })}>
                    {active ? 'Appliquée' : 'Appliquer'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="studio-section">
        <h3 className="section-title"><SlidersHorizontal size={13} /> Réglages</h3>
        <div className="field-stack">
          <div className="type-grid" role="radiogroup" aria-label="Type de transition">
            {(Object.keys(TYPE_META) as TransitionType[]).map((k) => {
              const M = TYPE_META[k];
              const Icon = M.icon;
              return (
                <button key={k} role="radio" aria-checked={spec.type === k} className={`type-tile ${spec.type === k ? 'is-active' : ''}`} onClick={() => patch({ type: k, bassSwap: k === 'eq' || k === 'structure' ? true : spec.bassSwap })} title={M.label}>
                  <Icon size={16} />
                  <span>{M.short}</span>
                </button>
              );
            })}
          </div>
          {spec.type !== t.type && <p className="hint tone-warn">Demandé : {TYPE_META[spec.type].label}. Appliqué : {TYPE_META[t.type].label} (voir les remarques ci-dessus).</p>}

          <div className="row-between">
            <span className="label">Durée</span>
            {isBeat ? (
              <Stepper value={spec.bars} options={[1, 2, 4, 8, 16, 32, 64]} onChange={(v) => patch({ bars: v })} format={(v) => `${v} mesure${v > 1 ? 's' : ''}`} />
            ) : (
              <Stepper value={spec.seconds} options={[0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 20, 30]} onChange={(v) => patch({ seconds: v })} format={(v) => `${String(v).replace('.', ',')} s`} />
            )}
          </div>
          <div className="row-between">
            <span className="label">Effet</span>
            <Segmented size="sm" ariaLabel="Effet de transition" value={spec.effect ?? 'none'} onChange={(v: TransitionEffect) => patch({ effect: v })}
              options={(Object.keys(EFFECT_META) as TransitionEffect[]).map((k) => ({ value: k, label: EFFECT_META[k].short, title: EFFECT_META[k].label }))} />
          </div>
          {(spec.effect ?? 'none') !== 'none' && <p className="hint">{EFFECT_META[spec.effect!].hint}{spec.effect !== 'filter' && !t.synced ? ' Transition non synchronisée : rythme de l’effet fixé à 0,4–0,5 s.' : ''}</p>}
          <div className="row-between muted-row">
            <span>Durée réelle</span>
            <span className="num">{t.duration.toFixed(1).replace('.', ',')} s{t.bars ? ` · ${t.bars} mesures` : ''}</span>
          </div>

          <CurvePreview t={t} spec={spec} />
          <div className="legend">
            <span><i className="lg lg-a" /> Volume A</span><span><i className="lg lg-b" /> Volume B</span>
            {(spec.bassSwap && t.type !== 'crossfade') && <><span><i className="lg lg-al" /> Basses A</span><span><i className="lg lg-bl" /> Basses B</span></>}
          </div>
          <div className="two-col">
            <label className="select-field"><span>Sortie de A</span>
              <select value={spec.fadeOut} onChange={(e) => patch({ fadeOut: e.target.value as CurveShape })}>{CURVES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
            </label>
            <label className="select-field"><span>Entrée de B</span>
              <select value={spec.fadeIn} onChange={(e) => patch({ fadeIn: e.target.value as CurveShape })}>{CURVES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
            </label>
          </div>
          {spec.type !== 'crossfade' && (
            <>
              <Toggle checked={spec.bassSwap} onChange={(v) => patch({ bassSwap: v })} label="Échange des basses" hint="Coupe les basses de B puis les échange avec celles de A : évite que deux kicks/basses se superposent." />
              {spec.bassSwap && <Slider label="Moment de l’échange" min={0.1} max={0.9} step={0.05} value={spec.swapPoint} onChange={(v) => patch({ swapPoint: v })} format={(v) => `${Math.round(v * 100)} %`} />}
            </>
          )}
        </div>
      </section>

      <section className="studio-section">
        <h3 className="section-title">Points de transition</h3>
        <PointRow
          label="Sortie de A"
          value={t.aStart}
          bar={gA && t.synced ? Math.round(barIndex(gA, t.aStart)) + 1 : null}
          auto={spec.outStart === null}
          onNudge={(d) => nudge('out', d)}
          onReset={() => patch({ outStart: null })}
        />
        <PointRow
          label="Entrée de B"
          value={t.bStart}
          bar={gB && t.synced ? Math.round(barIndex(gB, t.bStart)) + 1 : null}
          auto={spec.inStart === null}
          onNudge={(d) => nudge('in', d)}
          onReset={() => patch({ inStart: null })}
        />
        <div className="mini-waves">
          <div className="mini-wave"><Waveform data={A.analysis.waveform} duration={A.analysis.duration} from={Math.max(0, t.aStart - 20)} to={Math.min(A.analysis.duration, t.aEnd + 10)} hue={trackHue(A.id)} dim={[{ from: t.aEnd, to: 1e9 }]} /><span className="mw-label">A</span></div>
          <div className="mini-wave"><Waveform data={B.analysis.waveform} duration={B.analysis.duration} from={Math.max(0, t.bStart - 10)} to={Math.min(B.analysis.duration, t.bEnd + 20)} hue={trackHue(B.id)} dim={[{ from: 0, to: t.bStart }]} /><span className="mw-label">B</span></div>
        </div>
        {t.synced && (
          <p className="hint">
            Tempo : B joue à <span className="num">{(t.rate * 100).toFixed(1).replace('.', ',')} %</span> pendant la transition{t.factor !== 1 ? ` (${t.factor === 2 ? 'demi' : 'double'}-tempo)` : ''}, puis revient progressivement à son tempo d’origine sur {mixtape.settings.tempoReturnBars} mesures quand c’est possible. Time-stretch WSOLA, hauteur préservée.
          </p>
        )}
      </section>

      <section className="studio-section">
        <h3 className="section-title">Niveaux</h3>
        <Slider label={`Gain · ${A.title}`} min={-12} max={12} step={0.5} value={eA.gainDb} onChange={(v) => patchEntry(eA.id, { gainDb: v })} format={(v) => fmtDb(v)} />
        <Slider label={`Gain · ${B.title}`} min={-12} max={12} step={0.5} value={eB.gainDb} onChange={(v) => patchEntry(eB.id, { gainDb: v })} format={(v) => fmtDb(v)} accent="var(--violet)" />
        <p className="hint">Les morceaux sont normalisés à {mixtape.settings.targetLufs} LUFS avant ce réglage ; un limiteur true-peak protège la sortie à {mixtape.settings.ceilingDb} dBTP.</p>
      </section>
    </div>
  );
}

function CompatRow({ label, value, text }: { label: string; value: number; text: string }) {
  return (
    <div className="compat-row" title={text}>
      <span className="compat-label">{label}</span>
      <span className="compat-bar"><span style={{ width: `${Math.round(value * 100)}%` }} /></span>
      <span className="compat-text">{text}</span>
    </div>
  );
}

function PointRow({ label, value, bar, auto, onNudge, onReset }: { label: string; value: number; bar: number | null; auto: boolean; onNudge: (d: number) => void; onReset: () => void }) {
  return (
    <div className="point-row">
      <div className="point-text">
        <span className="label">{label}</span>
        <span className="point-value num">{fmtTime(value, true)}{bar !== null && <span className="tone-dim"> · mesure {bar}</span>}</span>
      </div>
      <div className="nudges">
        <IconButton size="sm" label={bar !== null ? '−8 mesures' : '−8 s'} onClick={() => onNudge(-8)}><ChevronsLeft size={14} /></IconButton>
        <IconButton size="sm" label={bar !== null ? '−1 mesure' : '−1 s'} onClick={() => onNudge(-1)}><ChevronLeft size={14} /></IconButton>
        <IconButton size="sm" label={bar !== null ? '+1 mesure' : '+1 s'} onClick={() => onNudge(1)}><ChevronRight size={14} /></IconButton>
        <IconButton size="sm" label={bar !== null ? '+8 mesures' : '+8 s'} onClick={() => onNudge(8)}><ChevronsRight size={14} /></IconButton>
        <Button size="sm" variant={auto ? 'plain' : 'ghost'} disabled={auto} onClick={onReset}>{auto ? 'Auto' : 'Auto ↺'}</Button>
      </div>
    </div>
  );
}

/** Cue in / out editor on the full waveform with draggable handles. */
function CueEditor({ track, cueIn, cueOut, onChange }: { track: EffectiveTrack; cueIn: number; cueOut: number; onChange: (inS: number | null, outS: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ which: 'in' | 'out'; value: number } | null>(null);
  const a = track.analysis;
  const g = gridOf(track);
  const D = a.duration;
  const vin = drag?.which === 'in' ? drag.value : cueIn;
  const vout = drag?.which === 'out' ? drag.value : cueOut;
  const toTime = (clientX: number, snap: boolean) => {
    const r = ref.current!.getBoundingClientRect();
    let t = Math.max(0, Math.min(D, ((clientX - r.left) / r.width) * D));
    if (snap && g?.reliable) t = snapToDownbeat(g, t);
    return Math.max(0, Math.min(D, t));
  };
  const onDown = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ which, value: which === 'in' ? cueIn : cueOut });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const t = toTime(e.clientX, !e.altKey);
    setDrag({ which: drag.which, value: drag.which === 'in' ? Math.min(t, vout - 4) : Math.max(t, vin + 4) });
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.which === 'in') onChange(drag.value, null);
    else onChange(null, drag.value);
    setDrag(null);
  };
  return (
    <div className="cue-editor">
      <div ref={ref} className="cue-wave" onPointerMove={onMove} onPointerUp={onUp}>
        <Waveform data={a.waveform} duration={D} hue={trackHue(track.id)} dim={[{ from: 0, to: vin }, { from: vout, to: D }]} />
        {a.sections.map((s, i) => (
          <span key={i} className={`section-tag s-${s.label}`} style={{ left: `${(s.start / D) * 100}%`, width: `${((s.end - s.start) / D) * 100}%` }} title={`${s.label} · ${fmtTime(s.start)}`}>{s.label}</span>
        ))}
        <div className="cue-handle cue-in" style={{ left: `${(vin / D) * 100}%` }} onPointerDown={onDown('in')} role="slider" aria-label="Point de début" aria-valuenow={vin}><span>{fmtTime(vin, true)}</span></div>
        <div className="cue-handle cue-out" style={{ left: `${(vout / D) * 100}%` }} onPointerDown={onDown('out')} role="slider" aria-label="Point de fin" aria-valuenow={vout}><span>{fmtTime(vout, true)}</span></div>
      </div>
      <p className="hint">Faites glisser les poignées (calées sur les mesures ; maintenez ⌥ pour un réglage libre).</p>
    </div>
  );
}

function PitchSection({ entryId, mixtape, tracks }: { entryId: string; mixtape: Mixtape; tracks: Map<string, EffectiveTrack> }) {
  const patchEntry = useStore((s) => s.patchEntry);
  const live = mixtape.entries.filter((x) => tracks.has(x.trackId));
  const i = live.findIndex((x) => x.id === entryId);
  const e = live[i];
  if (!e) return null;
  const pitch = e.pitch ?? 0;
  const base = tracks.get(e.trackId)!;
  const key = withPitch(base, pitch).key;
  const prevEntry = i > 0 ? live[i - 1] : null;
  const prevKey = prevEntry ? withPitch(tracks.get(prevEntry.trackId)!, prevEntry.pitch).key : null;
  // Best shift of the original key against the previous track (absolute, so repeated clicks are stable).
  const best = prevKey && base.key ? bestTransposition(prevKey, base.key, 2) : null;
  const now = prevKey && key ? harmonicMatch(prevKey.camelot, key.camelot) : null;
  return (
    <section className="studio-section">
      <h3 className="section-title">Tonalité</h3>
      <div className="row-between">
        <span className="label">Transposition</span>
        <Stepper value={pitch} options={[-3, -2, -1, 0, 1, 2, 3]} onChange={(v) => patchEntry(e.id, { pitch: v })} format={(v) => (v ? semitonesLabel(v) : 'aucune')} />
      </div>
      <div className="row-between muted-row">
        <span>Tonalité jouée</span>
        <span className="num">{key ? `${key.camelot} · ${key.name}` : 'inconnue'}{pitch && base.key ? ` (d’origine ${base.key.camelot})` : ''}</span>
      </div>
      {prevKey && key && now && (
        <div className="row-between muted-row">
          <span>Après le morceau précédent ({prevKey.camelot})</span>
          <span>{now.label}</span>
        </div>
      )}
      {best && (
        <Button size="sm" variant="glass" disabled={best.semitones === pitch} onClick={() => patchEntry(e.id, { pitch: best.semitones })} data-testid="pitch-match">
          {best.semitones === pitch ? 'Déjà accordé avec le morceau précédent' : `Accorder avec le précédent (${best.semitones ? semitonesLabel(best.semitones) : 'sans transposition'} → ${best.key.camelot})`}
        </Button>
      )}
      <p className="hint">Change la hauteur sans changer le tempo (time-stretch et rééchantillonnage). Au-delà de ±2 demi-tons, des artefacts deviennent audibles.</p>
    </section>
  );
}

function EntryStudio({ entryId, plan, mixtape, tracks }: { entryId: string; plan: MixPlan; mixtape: Mixtape; tracks: Map<string, EffectiveTrack> }) {
  const patchEntry = useStore((s) => s.patchEntry);
  const removeEntry = useStore((s) => s.removeEntry);
  const covers = useStore((s) => s.covers);
  const lib = useStore((s) => s.tracks);
  const e = mixtape.entries.find((x) => x.id === entryId);
  if (!e) return null;
  const tr = tracks.get(e.trackId);
  const v = plan.voices.find((x) => x.entryId === entryId);
  if (!tr) return <EmptyState icon={<AlertTriangle size={20} />} title="Morceau indisponible">{lib[e.trackId]?.error ?? 'Analyse en cours ou fichier manquant.'}</EmptyState>;
  const a = tr.analysis;
  const cueIn = e.cueIn ?? a.silenceStart;
  const cueOut = e.cueOut ?? a.silenceEnd;
  return (
    <div className="studio">
      <header className="track-hero">
        <Cover url={covers[tr.id]} title={tr.title} size={72} radius={14} />
        <div>
          <h2 className="hero-title">{tr.title}</h2>
          <p className="hero-sub">{tr.artist}{lib[tr.id]?.meta.album ? ` · ${lib[tr.id].meta.album}` : ''}</p>
          <div className="entry-chips"><BpmChip a={a} bpm={tr.bpm} /><KeyChip camelot={tr.key?.camelot} confidence={tr.key?.confidence} name={tr.key?.name} /></div>
        </div>
      </header>
      <div className="studio-actions">
        <Button variant="primary" icon={<Play size={15} />} disabled={!v} onClick={() => v && void player().play(v.start)}>Écouter depuis ici</Button>
        <IconButton label={e.locked ? 'Déverrouiller la position' : 'Verrouiller la position'} active={e.locked} onClick={() => patchEntry(e.id, { locked: !e.locked })}>{e.locked ? <Lock size={15} /> : <LockOpen size={15} />}</IconButton>
        <IconButton label="Retirer de la mixtape" onClick={() => removeEntry(e.id)}><X size={15} /></IconButton>
      </div>
      <section className="studio-section">
        <h3 className="section-title">Début et fin de lecture</h3>
        <CueEditor track={tr} cueIn={cueIn} cueOut={cueOut} onChange={(i, o) => patchEntry(e.id, { ...(i !== null ? { cueIn: i } : {}), ...(o !== null ? { cueOut: o } : {}) })} />
        <div className="row-between">
          <span className="muted-row num">{fmtTime(cueIn, true)} → {fmtTime(cueOut, true)}</span>
          <Button size="sm" variant="ghost" disabled={e.cueIn === null && e.cueOut === null} icon={<RotateCcw size={13} />} onClick={() => patchEntry(e.id, { cueIn: null, cueOut: null })}>Réinitialiser</Button>
        </div>
        {v && <p className="hint">Dans le mix : de {fmtTime(v.start)} à {fmtTime(v.end)} (source {fmtTime(v.srcStart)} → {fmtTime(v.srcEnd)}).</p>}
      </section>
      <PitchSection entryId={e.id} mixtape={mixtape} tracks={tracks} />
      <section className="studio-section">
        <h3 className="section-title">Niveau</h3>
        <Slider label="Gain du morceau" min={-12} max={12} step={0.5} value={e.gainDb} onChange={(x) => patchEntry(e.id, { gainDb: x })} format={(x) => fmtDb(x)} />
        <p className="hint">Normalisation automatique : {v ? fmtDb(v.normDb) : '—'} (de {fmtDb(a.lufs, 'LUFS')} vers {mixtape.settings.targetLufs} LUFS).</p>
      </section>
      <TrackFacts trackId={tr.id} />
    </div>
  );
}

function TrackFacts({ trackId }: { trackId: string }) {
  const t = useStore((s) => s.tracks[trackId]);
  const a = useStore((s) => s.analyses[trackId]);
  const setOverrides = useStore((s) => s.setOverrides);
  const [bpmText, setBpmText] = useState('');
  const keys = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (let n = 1; n <= 12; n++) for (const letter of ['A', 'B']) {
      for (let tonic = 0; tonic < 12; tonic++) {
        const mode = letter === 'A' ? 'minor' : 'major';
        if (camelotCode(tonic, mode) === `${n}${letter}`) out.push({ value: `${tonic}:${mode}`, label: `${n}${letter} · ${keyName(tonic, mode)}` });
      }
    }
    return out;
  }, []);
  if (!t || !a) return null;
  const o = t.overrides;
  const bpm = o.bpm ?? a.bpm;
  const key = o.key ? makeKey(o.key.tonic, o.key.mode, 1) : a.key;
  const setBpm = (v: number | undefined) => setOverrides(trackId, { ...o, bpm: v && v > 30 && v < 300 ? v : undefined });
  const shiftGrid = (dt: number) => setOverrides(trackId, { ...o, firstBeat: Math.max(0, (o.firstBeat ?? a.firstBeat ?? 0) + dt) });
  return (
    <>
      <section className="studio-section">
        <h3 className="section-title">Analyse musicale</h3>
        <dl className="facts">
          <dt>Tempo</dt><dd><span className="num">{fmtBpm(bpm)}</span> BPM {o.bpm ? <Chip tone="violet">corrigé</Chip> : <span className="tone-dim">· confiance {Math.round(a.bpmConfidence * 100)} %, stabilité {Math.round(a.tempoStability * 100)} %</span>}</dd>
          <dt>Tonalité</dt><dd>{key ? <><span style={{ color: keyColor(key.camelot) }} className="num">{key.camelot}</span> · {key.name} {o.key ? <Chip tone="violet">corrigée</Chip> : <span className="tone-dim">· confiance {Math.round(key.confidence * 100)} %</span>}</> : '—'}</dd>
          <dt>Loudness</dt><dd className="num">{fmtDb(a.lufs, 'LUFS')} · crête {fmtDb(a.truePeakDb, 'dBTP')}{a.loudnessRange !== null ? ` · LRA ${a.loudnessRange.toFixed(1)} LU` : ''}</dd>
          <dt>Énergie</dt><dd className="num">{a.energy !== null ? `${a.energy.toFixed(1)} / 10` : '—'} <span className="tone-dim">· {a.onsetRate.toFixed(1)} attaques/s</span></dd>
          <dt>Durée</dt><dd className="num">{fmtTime(a.duration, true)} <span className="tone-dim">· silence {a.silenceStart.toFixed(2)} s / {(a.duration - a.silenceEnd).toFixed(2)} s</span></dd>
          <dt>Source</dt><dd className="num">{a.codec.toUpperCase()} · {(a.sourceSampleRate / 1000).toFixed(1)} kHz{a.bitrate ? ` · ${Math.round(a.bitrate / 1000)} kb/s` : ''}</dd>
          <dt>Structure</dt><dd>{a.sections.length ? a.sections.map((s) => s.label).join(' · ') : <span className="tone-dim">indisponible</span>}</dd>
        </dl>
        {a.warnings.length > 0 && <div className="notes sev-warn">{a.warnings.map((w, i) => <div className="note" key={i}><AlertTriangle size={13} /><span>{w}</span></div>)}</div>}
      </section>
      <section className="studio-section">
        <h3 className="section-title">Corrections manuelles</h3>
        <div className="row-between">
          <span className="label">BPM</span>
          <div className="row gap-1">
            <input className="num-input" placeholder={fmtBpm(a.bpm)} value={bpmText} onChange={(e) => setBpmText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setBpm(parseFloat(bpmText.replace(',', '.'))); setBpmText(''); } }} aria-label="BPM corrigé" />
            <Button size="sm" variant="ghost" disabled={!bpm} onClick={() => setBpm((bpm ?? 0) / 2)}>÷2</Button>
            <Button size="sm" variant="ghost" disabled={!bpm} onClick={() => setBpm((bpm ?? 0) * 2)}>×2</Button>
            <IconButton size="sm" label="Annuler la correction" disabled={!o.bpm} onClick={() => setBpm(undefined)}><RotateCcw size={13} /></IconButton>
          </div>
        </div>
        <div className="row-between">
          <span className="label">Tonalité</span>
          <div className="row gap-1">
            <select className="select-inline" value={key ? `${key.tonic}:${key.mode}` : ''} onChange={(e) => { const [tn, md] = e.target.value.split(':'); setOverrides(trackId, { ...o, key: { tonic: parseInt(tn, 10), mode: md as 'major' | 'minor' } }); }}>
              {!key && <option value="">—</option>}
              {keys.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <IconButton size="sm" label="Annuler la correction" disabled={!o.key} onClick={() => setOverrides(trackId, { ...o, key: undefined })}><RotateCcw size={13} /></IconButton>
          </div>
        </div>
        {bpm && (
          <div className="row-between">
            <span className="label">Grille rythmique</span>
            <div className="row gap-1">
              <Button size="sm" variant="ghost" onClick={() => shiftGrid(-0.01)}>−10 ms</Button>
              <Button size="sm" variant="ghost" onClick={() => shiftGrid(0.01)}>+10 ms</Button>
              <Button size="sm" variant="ghost" onClick={() => setOverrides(trackId, { ...o, downbeatPhase: (((o.downbeatPhase ?? a.downbeatPhase) + 1) % 4) })}>1er temps +1</Button>
              <IconButton size="sm" label="Annuler" disabled={o.firstBeat === undefined && o.downbeatPhase === undefined} onClick={() => setOverrides(trackId, { ...o, firstBeat: undefined, downbeatPhase: undefined })}><RotateCcw size={13} /></IconButton>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function TrackPanel({ trackId }: { trackId: string }) {
  const t = useStore((s) => s.tracks[trackId]);
  const cover = useStore((s) => s.covers[trackId]);
  const addToMixtape = useStore((s) => s.addToMixtape);
  if (!t) return null;
  return (
    <div className="studio">
      <header className="track-hero">
        <Cover url={cover} title={t.meta.title} size={72} radius={14} />
        <div>
          <h2 className="hero-title">{t.meta.title}</h2>
          <p className="hero-sub">{t.meta.artist}{t.meta.album ? ` · ${t.meta.album}` : ''}{t.meta.year ? ` · ${t.meta.year}` : ''}</p>
          <p className="hero-file" title={t.path}>{t.fileName}</p>
        </div>
      </header>
      <div className="studio-actions">
        <Button variant="glass" disabled={t.status !== 'ready'} onClick={() => addToMixtape([t.id])}>Ajouter à la mixtape</Button>
      </div>
      {t.status === 'error' && <div className="notes sev-problem"><div className="note"><AlertTriangle size={13} /><span>{t.error}</span></div></div>}
      {t.status === 'missing' && <div className="notes sev-warn"><div className="note"><AlertTriangle size={13} /><span>Fichier introuvable : {t.path}</span></div></div>}
      <TrackFacts trackId={trackId} />
    </div>
  );
}

export function Inspector({ plan, mixtape, tracks, pairs, specs }: { plan: MixPlan; mixtape: Mixtape; tracks: Map<string, EffectiveTrack>; pairs: Record<string, PairInfo>; specs: Record<string, TransitionSpec> }) {
  const selection = useStore((s) => s.selection);
  let content: React.ReactNode = null;
  if (selection?.kind === 'transition') {
    const t = plan.transitions.find((x) => x.fromEntryId === selection.fromEntryId);
    const info = pairs[selection.fromEntryId];
    if (t && info) content = <TransitionStudio t={t} info={info} plan={plan} mixtape={mixtape} tracks={tracks} specs={specs} />;
  } else if (selection?.kind === 'entry') content = <EntryStudio entryId={selection.entryId} plan={plan} mixtape={mixtape} tracks={tracks} />;
  else if (selection?.kind === 'track') content = <TrackPanel trackId={selection.trackId} />;
  return (
    <aside className="inspector glass glass-regular" aria-label="Studio de mixage" data-testid="inspector">
      <div className="inspector-scroll" key={selection ? JSON.stringify(selection) : 'none'}>
        {content ?? (
          <EmptyState icon={<SlidersHorizontal size={22} />} title="Studio de mixage">
            Sélectionnez une transition entre deux morceaux pour comparer les propositions, l’écouter et l’ajuster — ou un morceau pour régler ses points de début et de fin.
          </EmptyState>
        )}
      </div>
    </aside>
  );
}
