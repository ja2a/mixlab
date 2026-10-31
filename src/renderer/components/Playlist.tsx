import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, AudioLines, GripVertical, Headphones, Info, ListPlus, Lock, LockOpen, Play, RotateCcw, Sparkles, Wand2, X, Waves, Blend, Activity, Spline, Layers, Ban, Filter, Repeat, Radio,
} from 'lucide-react';
import { useStore } from '../state/store';
import { player } from '../lib/player';
import { usePlayer } from '../lib/usePlayer';
import { fmtTime, plural, trackHue } from '../lib/format';
import { Button, Chip, IconButton, ScoreGauge, Tooltip, EmptyState, useContextMenu } from './ui';
import { Cover, BpmChip, KeyChip } from './Library';
import { Waveform } from './Waveform';
import type { MixPlan, PlannedTransition, VoicePlan } from '../../core/mix/plan';
import type { PairInfo } from '../lib/derived';
import { transposeKey } from '../../core/music/camelot';
import type { EffectiveTrack, PlaylistEntry, TransitionEffect, TransitionType } from '../../core/types';

export const TYPE_META: Record<TransitionType, { label: string; short: string; icon: typeof Blend }> = {
  crossfade: { label: 'Fondu enchaîné', short: 'Fondu', icon: Blend },
  curve: { label: 'Courbes personnalisées', short: 'Courbes', icon: Spline },
  beatsync: { label: 'Synchronisée sur les temps', short: 'Sur les temps', icon: Activity },
  eq: { label: 'Progressive avec égalisation', short: 'EQ progressif', icon: Waves },
  structure: { label: 'Basée sur la structure', short: 'Structure', icon: Layers },
};

export const EFFECT_META: Record<TransitionEffect, { label: string; short: string; icon: typeof Blend; hint: string }> = {
  none: { label: 'Aucun effet', short: 'Aucun', icon: Ban, hint: 'Transition sans effet.' },
  filter: { label: 'Balayage de filtre', short: 'Filtre', icon: Filter, hint: 'B entre étouffé (passe-bas) et s’ouvre peu à peu, pendant que A perd ses graves (passe-haut) jusqu’à disparaître.' },
  echo: { label: 'Écho', short: 'Écho', icon: Radio, hint: 'Les dernières notes de A partent dans un écho calé sur le tempo, qui résonne par-dessus B.' },
  loop: { label: 'Boucle accélérée', short: 'Boucle', icon: Repeat, hint: 'A répète son dernier temps, puis un demi-temps, puis un quart de temps, juste avant la fin de la transition.' },
};

export const semitonesLabel = (s: number) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)} demi-ton${Math.abs(s) > 1 ? 's' : ''}`;

function TransitionCapsule({ t, info, onAudition }: { t: PlannedTransition; info?: PairInfo; onAudition: () => void }) {
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selection?.kind === 'transition' && s.selection.fromEntryId === t.fromEntryId);
  const meta = TYPE_META[t.type];
  const Icon = meta.icon;
  const locked = info?.spec.locked;
  const pct = (t.rate - 1) * 100;
  return (
    <div className="capsule-wrap">
      <div className="capsule-line" />
      <button
        className={`capsule glass glass-thin sev-${t.severity} ${selected ? 'is-selected' : ''}`}
        onClick={() => select({ kind: 'transition', fromEntryId: t.fromEntryId })}
        data-testid="transition-capsule"
      >
        <span className="capsule-icon"><Icon size={14} /></span>
        <span className="capsule-main">
          <span className="capsule-title">{t.bars ? `${t.bars} mesure${t.bars > 1 ? 's' : ''}` : `${t.duration.toFixed(1).replace('.', ',')} s`} · {meta.short}{t.effect !== 'none' && <> · {EFFECT_META[t.effect].short}</>}</span>
          <span className="capsule-sub">
            {t.synced ? (Math.abs(pct) < 0.05 ? 'calé, sans stretch' : `calé · B ${pct > 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')} %`) : 'non synchronisé'}
            {info?.pair.harmonic.known && <> · {info.pair.harmonic.label.split(' (')[0]}</>}
          </span>
        </span>
        {info && <ScoreGauge value={info.pair.total} size={28} />}
        {t.severity === 'warn' || t.severity === 'problem' ? (
          <Tooltip text={t.notes.join(' · ')}><AlertTriangle size={14} className={t.severity === 'problem' ? 'tone-problem' : 'tone-warn'} /></Tooltip>
        ) : t.severity === 'info' ? (
          <Tooltip text={t.notes.join(' · ')}><Info size={14} className="tone-info" /></Tooltip>
        ) : null}
        {locked && <Lock size={12} className="tone-dim" />}
      </button>
      <IconButton label="Écouter la transition" size="sm" className="capsule-play" onClick={onAudition}><Headphones size={14} /></IconButton>
    </div>
  );
}

const EntryCard = memo(function EntryCard({
  entry, index, voice, track, cover, playing, transition, info, onAudition,
}: {
  entry: PlaylistEntry; index: number; voice?: VoicePlan; track?: EffectiveTrack; cover?: string | null; playing: boolean;
  transition?: PlannedTransition; info?: PairInfo; onAudition: (t: PlannedTransition) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition: tr, isDragging } = useSortable({ id: entry.id, data: { type: 'entry' }, disabled: entry.locked });
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selection?.kind === 'entry' && s.selection.entryId === entry.id);
  const patchEntry = useStore((s) => s.patchEntry);
  const removeEntry = useStore((s) => s.removeEntry);
  const lib = useStore((s) => s.tracks[entry.trackId]);
  const menu = useContextMenu();
  const style = { transform: CSS.Translate.toString(transform), transition: tr };
  const a = track?.analysis;
  const hue = trackHue(entry.trackId);
  const playedLen = voice ? voice.end - voice.start : 0;

  return (
    <div ref={setNodeRef} style={style} className={`entry-wrap ${isDragging ? 'is-dragging' : ''}`} data-testid="playlist-entry" data-entry-id={entry.id}>
      <div
        className={`entry glass glass-thin ${selected ? 'is-selected' : ''} ${playing ? 'is-playing' : ''} ${entry.locked ? 'is-locked' : ''}`}
        style={{ '--hue': hue } as React.CSSProperties}
        onClick={() => select({ kind: 'entry', entryId: entry.id })}
        onContextMenu={(e) => menu.open(e, [
          { label: 'Écouter depuis ce morceau', icon: <Play size={14} />, disabled: !voice, onClick: () => voice && void player().play(voice.start) },
          { label: entry.locked ? 'Déverrouiller la position' : 'Verrouiller la position', icon: entry.locked ? <LockOpen size={14} /> : <Lock size={14} />, onClick: () => patchEntry(entry.id, { locked: !entry.locked }) },
          { separator: true, label: '' },
          { label: 'Retirer de la mixtape', icon: <X size={14} />, danger: true, onClick: () => removeEntry(entry.id) },
        ])}
      >
        <button className="entry-grip" {...attributes} {...listeners} aria-label="Déplacer" disabled={entry.locked}>
          {entry.locked ? <Lock size={13} /> : <GripVertical size={15} />}
        </button>
        <span className="entry-index num">{playing ? <AudioLines size={15} className="tone-accent pulse" /> : String(index + 1).padStart(2, '0')}</span>
        <Cover url={cover} title={lib?.meta.title ?? '?'} size={46} radius={10} />
        <div className="entry-info">
          <div className="entry-title">{lib?.meta.title ?? 'Morceau indisponible'}</div>
          <div className="entry-artist">{lib?.meta.artist}</div>
          <div className="entry-chips">
            {a ? (
              <>
                <BpmChip a={a} bpm={track?.bpm} />
                {(() => { const k = track?.key ? transposeKey(track.key, entry.pitch ?? 0) : null; return <KeyChip camelot={k?.camelot} confidence={k?.confidence} name={k?.name} />; })()}
                {!!entry.pitch && <Chip tone="violet" title="Transposition (tempo inchangé)">{semitonesLabel(entry.pitch)}</Chip>}
                {a.energy !== null && <Chip title="Énergie estimée (1–10)"><span className="energy-bar"><span style={{ width: `${(a.energy / 10) * 100}%` }} /></span><span className="num">{a.energy.toFixed(1).replace('.', ',')}</span></Chip>}
                {entry.gainDb !== 0 && <Chip tone="accent">{entry.gainDb > 0 ? '+' : ''}{entry.gainDb.toFixed(1)} dB</Chip>}
                {(entry.cueIn !== null || entry.cueOut !== null) && <Chip tone="violet">Points perso</Chip>}
              </>
            ) : (
              <Chip tone="warn">{lib?.status === 'missing' ? 'Fichier introuvable' : lib?.status === 'error' ? 'Illisible' : 'Analyse en cours…'}</Chip>
            )}
          </div>
        </div>
        <div className="entry-wave">
          {a && voice && (
            <Waveform
              data={a.waveform}
              duration={a.duration}
              style="bars"
              hue={hue}
              dim={[{ from: 0, to: voice.srcStart }, { from: voice.srcEnd, to: a.duration }]}
            />
          )}
        </div>
        <div className="entry-time">
          <span className="num">{voice ? fmtTime(playedLen) : a ? fmtTime(a.duration) : '—'}</span>
          {voice && <span className="entry-at num">à {fmtTime(voice.start)}</span>}
        </div>
        <div className="entry-actions">
          <IconButton label={entry.locked ? 'Déverrouiller' : 'Verrouiller la position'} size="sm" active={entry.locked} onClick={(e) => { e.stopPropagation(); patchEntry(entry.id, { locked: !entry.locked }); }}>
            {entry.locked ? <Lock size={13} /> : <LockOpen size={13} />}
          </IconButton>
          <IconButton label="Retirer de la mixtape" size="sm" onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}><X size={14} /></IconButton>
        </div>
      </div>
      {transition && <TransitionCapsule t={transition} info={info} onAudition={() => onAudition(transition)} />}
      {menu.node}
    </div>
  );
});

export function Playlist({ plan, tracks, pairs }: { plan: MixPlan; tracks: Map<string, EffectiveTrack>; pairs: Record<string, PairInfo> }) {
  const mixtape = useStore((s) => s.mixtapes.find((m) => m.id === s.activeId)!);
  const covers = useStore((s) => s.covers);
  const libCount = useStore((s) => s.libraryOrder.filter((id) => s.tracks[id]?.status === 'ready').length);
  const addToMixtape = useStore((s) => s.addToMixtape);
  const libraryOrder = useStore((s) => s.libraryOrder);
  const libTracks = useStore((s) => s.tracks);
  const setModal = useStore((s) => s.setModal);
  const restoreManualOrder = useStore((s) => s.restoreManualOrder);
  const setTransition = useStore((s) => s.setTransition);
  const toast = useStore((s) => s.toast);
  const { position, playing } = usePlayer(6);
  const { setNodeRef, isOver } = useDroppable({ id: 'playlist' });
  const voices = new Map(plan.voices.map((v) => [v.entryId, v]));
  const trans = new Map(plan.transitions.map((t) => [t.fromEntryId, t]));
  const current = playing ? plan.voices.filter((v) => position >= v.start && position < v.end).pop()?.entryId : undefined;
  const problems = plan.transitions.filter((t) => t.severity === 'warn' || t.severity === 'problem').length;

  const audition = (t: PlannedTransition) => {
    void player().play(Math.max(0, t.start - 6), Math.min(plan.duration, t.end + 4));
  };

  const optimizeTransitions = () => {
    let n = 0;
    for (const [from, info] of Object.entries(pairs)) {
      if (info.spec.locked) continue;
      const best = [...info.proposals].sort((a, b) => b.score - a.score)[0];
      setTransition(from, { ...best.spec, origin: 'proposal', toEntryId: info.toEntryId });
      n++;
    }
    toast({ kind: 'success', title: n ? `${plural(n, 'transition optimisée', 'transitions optimisées')}` : 'Aucune transition modifiable', detail: n ? 'Ordre conservé ; chaque enchaînement utilise sa meilleure proposition.' : 'Toutes les transitions sont verrouillées.' });
  };

  const ids = mixtape.entries.map((e) => e.id);
  return (
    <section className="playlist" aria-label="Playlist de la mixtape">
      <header className="playlist-head">
        <div>
          <h1 className="playlist-title">{mixtape.name}</h1>
          <p className="playlist-sub">
            {mixtape.entries.length ? (
              <>
                {plural(mixtape.entries.length, 'morceau', 'morceaux')} · <span className="num">{fmtTime(plan.duration)}</span> au total
                {plan.transitions.length > 0 && <> · {plural(plan.transitions.filter((t) => t.synced).length, 'transition calée', 'transitions calées')} sur {plan.transitions.length}</>}
                {problems > 0 && <span className="tone-warn"> · {plural(problems, 'à vérifier', 'à vérifier')}</span>}
              </>
            ) : 'Construisez votre mixtape en glissant des morceaux depuis la bibliothèque.'}
          </p>
        </div>
        <div className="playlist-actions">
          {mixtape.manualOrder && (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={restoreManualOrder}>Ordre manuel</Button>
          )}
          {plan.transitions.length > 0 && (
            <Button size="sm" variant="glass" icon={<Wand2 size={14} />} onClick={optimizeTransitions}>Optimiser les transitions</Button>
          )}
        </div>
      </header>
      <div ref={setNodeRef} className={`playlist-body ${isOver ? 'is-over' : ''}`} data-testid="playlist">
        {mixtape.entries.length === 0 ? (
          <div className={`playlist-empty ${isOver ? 'is-over' : ''}`}>
            <EmptyState
              icon={<ListPlus size={22} />}
              title="Votre mixtape est vide"
              action={
                <div className="row gap-2">
                  <Button variant="glass" disabled={!libCount} icon={<ListPlus size={15} />} onClick={() => addToMixtape(libraryOrder.filter((id) => libTracks[id]?.status === 'ready'))}>Ajouter toute la bibliothèque</Button>
                  <Button variant="primary" disabled={libCount < 2} icon={<Sparkles size={15} />} onClick={() => setModal('generate')}>Générer une mixtape</Button>
                </div>
              }
            >
              Glissez des morceaux ici, ou laissez MixLab proposer un ordre à partir de votre bibliothèque.
            </EmptyState>
          </div>
        ) : (
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {mixtape.entries.map((e, i) => (
              <EntryCard
                key={e.id}
                entry={e}
                index={i}
                voice={voices.get(e.id)}
                track={tracks.get(e.trackId)}
                cover={covers[e.trackId]}
                playing={current === e.id}
                transition={trans.get(e.id)}
                info={pairs[e.id]}
                onAudition={audition}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </section>
  );
}

