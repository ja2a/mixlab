import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, Info, Sparkles, Wand2, X, XCircle, Loader2 } from 'lucide-react';
import { useStore } from '../state/store';
import { useExport } from '../state/exportStore';
import { useMix } from '../lib/derived';
import { ARC_SHAPES, arcTarget, estimateSeconds, generateOrders, type ArcShape, type OrderProposal } from '../../core/music/optimize';
import { fmtDb, fmtTime, plural } from '../lib/format';
import { Button, Field, Modal, Segmented, Slider, Toggle, ProgressRing, Chip } from './ui';
import { Cover } from './Library';
import type { PlaylistEntry } from '../../core/types';

function Sparkline({ values, arc = 'free' }: { values: number[]; arc?: ArcShape }) {
  if (values.length < 2) return <svg className="sparkline" />;
  const W = 220, H = 44;
  const lo = Math.min(...values, 1), hi = Math.max(...values, 10);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 4 - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - 8)}`);
  // The chosen shape, drawn over the same vertical span as the energies of this order.
  const elo = Math.min(...values), ehi = Math.max(...values, elo + 3);
  const target = arc === 'free' ? null : Array.from({ length: 41 }, (_, i) => {
    const e = elo + arcTarget(arc, i / 40)! * (ehi - elo);
    return `${(i / 40) * W},${H - 4 - ((e - lo) / Math.max(1e-6, hi - lo)) * (H - 8)}`;
  });
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Courbe d’énergie">
      <defs><linearGradient id="spk" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      <path d={`M0,${H} L${pts.join(' L')} L${W},${H} Z`} fill="url(#spk)" />
      {target && <polyline className="sparkline-target" points={target.join(' ')} fill="none" stroke="var(--ink-3)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent-strong)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const DURATIONS = [30, 45, 60, 90, 120];

export function GenerateModal() {
  const open = useStore((s) => s.modal === 'generate');
  const setModal = useStore((s) => s.setModal);
  const applyOrder = useStore((s) => s.applyOrder);
  const addToMixtape = useStore((s) => s.addToMixtape);
  const setTransition = useStore((s) => s.setTransition);
  const libraryOrder = useStore((s) => s.libraryOrder);
  const libTracks = useStore((s) => s.tracks);
  const covers = useStore((s) => s.covers);
  const toast = useStore((s) => s.toast);
  const { mixtape, tracks, pairs } = useMix();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<OrderProposal[] | null>(null);
  const [chosen, setChosen] = useState<number>(1);
  const [arc, setArc] = useState<ArcShape>('free');
  const [minutes, setMinutes] = useState<number>(0); // 0 = every track

  const fromLibrary = mixtape.entries.filter((e) => tracks.has(e.trackId)).length < 2;
  const source: PlaylistEntry[] = useMemo(() => {
    if (!fromLibrary) return mixtape.entries.filter((e) => tracks.has(e.trackId));
    return libraryOrder.filter((id) => tracks.has(id)).map((id) => ({ id: 'lib:' + id, trackId: id, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
  }, [fromLibrary, mixtape, libraryOrder, tracks]);

  // Length of the whole source as one mix: durations longer than that are not offered.
  const available = useMemo(() => estimateSeconds(source.map((e) => e.trackId), tracks, new Map(source.map((e) => [e.trackId, e])), mixtape.settings), [source, tracks, mixtape.settings]);
  const durations = DURATIONS.filter((m) => m * 60 < available - 60);
  const target = minutes && durations.includes(minutes) ? minutes * 60 : null;

  useEffect(() => {
    if (!open) { setResults(null); return; }
    setBusy(true);
    // Let the modal paint before the optimiser runs.
    const t = setTimeout(() => {
      const r = generateOrders({ entries: source, transitions: fromLibrary ? {} : mixtape.transitions, tracks, settings: mixtape.settings, arc, targetSeconds: target });
      setResults(r);
      setChosen(r.length > 1 ? 1 : 0);
      setBusy(false);
    }, 60);
    return () => clearTimeout(t);
  }, [open, arc, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map(source.map((e) => [e.id, e]));
  const apply = () => {
    const r = results?.[chosen];
    if (!r) return;
    const dropped = source.length - r.order.length;
    if (fromLibrary) addToMixtape(r.order.map((id) => byId.get(id)!.trackId), mixtape.entries.length);
    else if (r.strategy !== 'manual') applyOrder(r.order, dropped > 0);
    setModal(null);
    toast({
      kind: 'success',
      title: r.strategy === 'manual' ? 'Ordre conservé' : `Ordre « ${r.title} » appliqué`,
      detail: dropped > 0 && r.strategy !== 'manual'
        ? `${plural(r.order.length, 'morceau retenu', 'morceaux retenus')} pour environ ${fmtTime(r.seconds)}${fromLibrary ? '.' : ` : ${plural(dropped, 'morceau retiré', 'morceaux retirés')} de la mixtape (toujours dans la bibliothèque).`}`
        : fromLibrary || r.strategy === 'manual' ? undefined : 'Votre ordre manuel est conservé : « Ordre manuel » permet d’y revenir.',
    });
  };
  const keepAndOptimize = () => {
    let n = 0;
    for (const [from, info] of Object.entries(pairs)) {
      if (info.spec.locked) continue;
      const best = [...info.proposals].sort((a, b) => b.score - a.score)[0];
      setTransition(from, { ...best.spec, origin: 'proposal', toEntryId: info.toEntryId });
      n++;
    }
    setModal(null);
    toast({ kind: 'success', title: 'Ordre conservé', detail: `${plural(n, 'transition optimisée', 'transitions optimisées')}.` });
  };

  const locked = source.filter((e) => e.locked).length + Object.values(mixtape.transitions).filter((t) => t.locked).length;
  return (
    <Modal
      open={open}
      onClose={() => setModal(null)}
      width={980}
      title={<><Sparkles size={18} className="tone-accent" /> Générer une mixtape</>}
      subtitle={fromLibrary
        ? `${plural(source.length, 'morceau analysé', 'morceaux analysés')} de la bibliothèque : MixLab cherche des ordres cohérents (tempo, tonalité, énergie, structure).`
        : `${plural(source.length, 'morceau', 'morceaux')} de « ${mixtape.name} »${locked ? ` · ${plural(locked, 'élément verrouillé respecté', 'éléments verrouillés respectés')}` : ''}. Votre ordre actuel n’est remplacé que si vous appliquez une proposition.`}
      footer={
        <>
          {!fromLibrary && <Button variant="ghost" icon={<Wand2 size={14} />} onClick={keepAndOptimize}>Garder mon ordre, optimiser les transitions</Button>}
          <span className="spacer" />
          <Button variant="ghost" onClick={() => setModal(null)}>Annuler</Button>
          <Button variant="primary" disabled={!results?.[chosen]} onClick={apply} data-testid="apply-order">Appliquer cet ordre</Button>
        </>
      }
    >
      <div className="generate-options">
        <div className="generate-option">
          <span className="label">Courbe d’énergie</span>
          <Segmented size="sm" ariaLabel="Courbe d’énergie" value={arc} onChange={setArc} options={[
            { value: 'free' as ArcShape, label: 'Libre', title: 'Chaque proposition suit sa propre logique' },
            ...(Object.keys(ARC_SHAPES) as Array<Exclude<ArcShape, 'free'>>).map((k) => ({ value: k as ArcShape, label: ARC_SHAPES[k].label, title: ARC_SHAPES[k].description })),
          ]} />
        </div>
        {durations.length > 0 && (
          <div className="generate-option">
            <span className="label">Durée</span>
            <Segmented size="sm" ariaLabel="Durée cible" value={target ? minutes : 0} onChange={setMinutes} options={[
              { value: 0, label: 'Tout', title: `Tous les morceaux (environ ${fmtTime(available)})` },
              ...durations.map((m) => ({ value: m, label: m < 60 ? `${m} min` : `${m / 60} h`.replace('1.5', '1,5') })),
            ]} />
          </div>
        )}
      </div>
      {target && <p className="hint generate-hint">MixLab choisit les morceaux qui forment le meilleur mix d’environ {fmtTime(target)}{locked ? ' ; les morceaux verrouillés sont toujours gardés' : ''}. Durées estimées avec des transitions de {mixtape.settings.defaultBars} mesures.</p>}
      {busy || !results ? (
        <div className="generating"><Loader2 size={22} className="spin" /> Calcul des enchaînements…</div>
      ) : (
        <div className="orders">
          {results.map((r, i) => (
            <button key={r.strategy} className={`order-card ${i === chosen ? 'is-active' : ''}`} onClick={() => setChosen(i)} data-testid="order-card">
              <div className="order-head">
                <span className="order-title">{r.title}</span>
                <span className="order-score num">{Math.round(r.meanPair * 100)}</span>
              </div>
              <p className="order-desc">{r.description}</p>
              <Sparkline values={r.energy} arc={r.strategy === 'manual' ? 'free' : arc} />
              <div className="order-stats">
                <Chip tone={target && Math.abs(r.seconds - target) > 300 ? 'warn' : 'neutral'} title="Durée estimée du mix">≈ {fmtTime(r.seconds)}</Chip>
                <Chip tone={r.syncable === r.order.length - 1 ? 'ok' : 'neutral'}>{r.syncable}/{Math.max(0, r.order.length - 1)} calées</Chip>
                <Chip tone="violet">{r.harmonicOk}/{Math.max(0, r.order.length - 1)} harmoniques</Chip>
              </div>
              <ol className="order-list">
                {r.order.slice(0, 8).map((id) => {
                  const e = byId.get(id);
                  const t = e ? libTracks[e.trackId] : null;
                  return t ? <li key={id}><Cover url={covers[t.id]} title={t.meta.title} size={18} radius={4} /><span>{t.meta.title}</span><span className="tone-dim num">{tracks.get(t.id)?.key?.camelot ?? ''}</span></li> : null;
                })}
                {r.order.length > 8 && <li className="tone-dim">+ {r.order.length - 8} autres</li>}
              </ol>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function ExportModal() {
  const open = useStore((s) => s.modal === 'export');
  const setModal = useStore((s) => s.setModal);
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);
  const { mixtape, plan } = useMix();
  const ex = useExport();
  const [title, setTitle] = useState(mixtape.name);
  const [artist, setArtist] = useState('MixLab');
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3');
  const [bitrate, setBitrate] = useState<192 | 256 | 320>(320);
  const [chapters, setChapters] = useState(true);
  const [cue, setCue] = useState(false);
  useEffect(() => { if (open && ex.status !== 'running') setTitle(mixtape.name); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = plan.transitions.filter((t) => t.severity === 'warn' || t.severity === 'problem');
  const start = async () => {
    const safe = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Mixtape';
    const out = await window.mixlab.pickExportPath(safe, format);
    if (!out) return;
    const id = await window.mixlab.exportStart(plan, { format, bitrate, outPath: out, metadata: { title, artist, year: String(new Date().getFullYear()) }, chapters: format === 'mp3' && chapters, cueSheet: cue });
    useExport.getState().set({ id, status: 'running', frames: 0, totalFrames: plan.totalFrames, stage: 'render', startedAt: Date.now(), report: null, error: null });
  };
  const running = ex.status === 'running';
  const frac = ex.totalFrames ? ex.frames / ex.totalFrames : 0;
  const elapsed = (Date.now() - ex.startedAt) / 1000;
  const eta = frac > 0.02 ? elapsed / frac - elapsed : null;

  return (
    <Modal
      open={open}
      onClose={() => setModal(null)}
      width={620}
      title="Exporter la mixtape"
      subtitle={running ? 'Le rendu se fait en arrière-plan : vous pouvez continuer à travailler.' : `${plural(plan.voices.length, 'morceau', 'morceaux')} · ${fmtTime(plan.duration)} · un seul fichier`}
      footer={
        running ? (
          <>
            <span className="spacer" />
            <Button variant="ghost" onClick={() => setModal(null)}>Masquer</Button>
            <Button variant="danger" onClick={() => ex.id !== null && window.mixlab.exportCancel(ex.id)} data-testid="export-cancel">Annuler l’export</Button>
          </>
        ) : ex.status === 'done' ? (
          <>
            <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={() => ex.report && window.mixlab.reveal(ex.report.outPath)}>Afficher le fichier</Button>
            <span className="spacer" />
            <Button variant="ghost" onClick={() => useExport.getState().set({ status: 'idle' })}>Nouvel export</Button>
            <Button variant="primary" onClick={() => { useExport.getState().set({ status: 'idle' }); setModal(null); }}>Terminé</Button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <Button variant="ghost" onClick={() => setModal(null)}>Annuler</Button>
            <Button variant="primary" disabled={!plan.voices.length} onClick={() => start().catch((e) => toast({ kind: 'error', title: 'Export impossible', detail: String(e?.message ?? e) }))} data-testid="export-start">Choisir l’emplacement et exporter…</Button>
          </>
        )
      }
    >
      {running ? (
        <div className="export-running" data-testid="export-running">
          <ProgressRing value={frac} size={96} stroke={5} />
          <div className="export-pct num">{Math.round(frac * 100)} %</div>
          <p className="tone-dim">{ex.stage === 'finalize' ? 'Finalisation de l’encodage…' : `Rendu de ${fmtTime(ex.frames / 44100)} sur ${fmtTime(ex.totalFrames / 44100)}${eta !== null ? ` · environ ${fmtTime(eta)} restantes` : ''}`}</p>
        </div>
      ) : ex.status === 'done' && ex.report ? (
        <div className="export-done" data-testid="export-done">
          <CheckCircle2 size={36} className="tone-ok" />
          <h3>Mixtape exportée</h3>
          <p className="mono-path" title={ex.report.outPath}>{ex.report.outPath}</p>
          <dl className="facts">
            <dt>Durée</dt><dd className="num">{fmtTime(ex.report.duration, true)}</dd>
            <dt>Loudness</dt><dd className="num">{fmtDb(ex.report.lufs, 'LUFS')}</dd>
            <dt>Crête vraie</dt><dd className="num">{fmtDb(ex.report.truePeakDb, 'dBTP')} {ex.report.truePeakDb <= mixtape.settings.ceilingDb + 0.05 ? <Chip tone="ok">sans saturation</Chip> : <Chip tone="warn">au-dessus du plafond</Chip>}</dd>
            <dt>Silences</dt><dd className="num">{ex.report.longestSilence < 0.1 ? <Chip tone="ok">aucun silence entre les morceaux</Chip> : `plus long silence : ${ex.report.longestSilence.toFixed(1)} s`}</dd>
            <dt>Limiteur</dt><dd className="num">réduction max. {ex.report.limiterMaxReductionDb.toFixed(1).replace('.', ',')} dB</dd>
            <dt>Temps de rendu</dt><dd className="num">{(ex.report.elapsedMs / 1000).toFixed(1).replace('.', ',')} s</dd>
          </dl>
        </div>
      ) : (
        <div className="field-stack">
          {ex.status === 'error' && <div className="notes sev-problem"><div className="note"><XCircle size={14} /><span>Échec de l’export : {ex.error}. Votre projet n’a pas été modifié.</span></div></div>}
          {ex.status === 'cancelled' && <div className="notes sev-info"><div className="note"><Info size={14} /><span>Export annulé. Aucun fichier partiel n’a été conservé.</span></div></div>}
          {problems.length > 0 && (
            <div className="notes sev-warn">
              <div className="note"><AlertTriangle size={14} /><span>{plural(problems.length, 'transition mérite', 'transitions méritent')} une vérification avant le rendu :</span></div>
              {problems.slice(0, 4).map((p) => (
                <button key={p.fromEntryId} className="note-link" onClick={() => { select({ kind: 'transition', fromEntryId: p.fromEntryId }); setModal(null); }}>
                  Transition {p.index + 1} ({fmtTime(p.start)}) — {p.notes[0]}
                </button>
              ))}
            </div>
          )}
          <div className="two-col">
            <Field label="Titre"><input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Artiste"><input className="text-input" value={artist} onChange={(e) => setArtist(e.target.value)} /></Field>
          </div>
          <div className="row-between">
            <span className="label">Format</span>
            <Segmented value={format} onChange={setFormat} options={[{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV 24 bits' }]} />
          </div>
          {format === 'mp3' && (
            <div className="row-between">
              <span className="label">Débit</span>
              <Segmented value={bitrate} onChange={setBitrate} options={[{ value: 192, label: '192 kb/s' }, { value: 256, label: '256 kb/s' }, { value: 320, label: '320 kb/s' }]} />
            </div>
          )}
          {format === 'mp3' && <Toggle checked={chapters} onChange={setChapters} label="Chapitres par morceau" hint="Ajoute la liste des morceaux et leurs positions dans les métadonnées ID3 (CHAP)." />}
          <Toggle checked={cue} onChange={setCue} label="Fiche .cue" hint="Crée aussi un fichier .cue à côté du mix (repères de morceaux pour les lecteurs compatibles)." />
          <p className="hint">Rendu par le même moteur que la préécoute : normalisation {mixtape.settings.targetLufs} LUFS, limiteur true-peak {mixtape.settings.ceilingDb} dBTP, encodage LAME à débit constant avec en-tête gapless.</p>
        </div>
      )}
    </Modal>
  );
}

export function SettingsModal() {
  const open = useStore((s) => s.modal === 'settings');
  const setModal = useStore((s) => s.setModal);
  const setSettings = useStore((s) => s.setSettings);
  const info = useStore((s) => s.info);
  const { mixtape } = useMix();
  const st = mixtape.settings;
  return (
    <Modal open={open} onClose={() => setModal(null)} width={560} title="Réglages du mixage" subtitle={`Appliqués à « ${mixtape.name} »`}>
      <div className="field-stack">
        <Slider label="Variation de tempo maximale" min={0} max={12} step={0.5} value={st.maxStretchPct} onChange={(v) => setSettings({ maxStretchPct: v })} format={(v) => `± ${String(v).replace('.', ',')} %`} />
        <p className="hint">Au-delà, la transition n’est pas synchronisée : MixLab propose un fondu à la place.</p>
        <Slider label="Retour au tempo d’origine" min={0} max={64} step={4} value={st.tempoReturnBars} onChange={(v) => setSettings({ tempoReturnBars: v })} format={(v) => `${v} mesures`} />
        <Toggle checked={st.normalize} onChange={(v) => setSettings({ normalize: v })} label="Normaliser le volume des morceaux" hint="Aligne chaque morceau sur la loudness cible (mesurée en LUFS, BS.1770-4)." />
        <Slider label="Loudness cible" min={-23} max={-8} step={0.5} value={st.targetLufs} disabled={!st.normalize} onChange={(v) => setSettings({ targetLufs: v })} format={(v) => `${String(v).replace('.', ',')} LUFS`} />
        <Slider label="Plafond true-peak" min={-3} max={-0.1} step={0.1} value={st.ceilingDb} onChange={(v) => setSettings({ ceilingDb: Math.round(v * 10) / 10 })} format={(v) => `${v.toFixed(1).replace('.', ',')} dBTP`} />
        <div className="row-between"><span className="label">Raccourcir les intros et outros longues</span><Segmented size="sm" ariaLabel="Raccourcir les intros et outros longues" value={st.trimBars} onChange={(v) => setSettings({ trimBars: v })} options={[{ value: 0, label: 'Non' }, ...[8, 16, 32].map((v) => ({ value: v, label: `${v}` }))]} /></div>
        <p className="hint">Une intro ou une outro calme plus longue que ce nombre de mesures est coupée là où une transition a lieu, sur un temps fort. Le premier morceau garde son intro, le dernier son outro.</p>
        <div className="row-between"><span className="label">Durée de transition par défaut</span><Segmented size="sm" value={st.defaultBars} onChange={(v) => setSettings({ defaultBars: v })} options={[4, 8, 16, 32].map((v) => ({ value: v, label: `${v}` }))} /></div>
        <p className="hint tone-dim">FFmpeg : {info?.ffmpeg.ok ? `${info.ffmpeg.path}${info.ffmpeg.soxr ? ' (SoX resampler)' : ''}` : info?.ffmpeg.error}. Cache d’analyse : {info?.cacheDir}</p>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass glass-thick toast-${t.kind}`}>
          <span className="toast-icon">{t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <XCircle size={16} /> : t.kind === 'warn' ? <AlertTriangle size={16} /> : <Info size={16} />}</span>
          <div className="toast-text"><strong>{t.title}</strong>{t.detail && <span>{t.detail}</span>}</div>
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Fermer"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

