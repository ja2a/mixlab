import { memo, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { AlertTriangle, FolderSearch, ListPlus, MoreHorizontal, Music2, Plus, Search, SlidersHorizontal, Trash2, Upload, FileQuestion } from 'lucide-react';
import { useStore } from '../state/store';
import { Chip, IconButton, ProgressRing, Tooltip, useContextMenu, EmptyState, Button } from './ui';
import { fmtBpm, fmtTime, keyColor, plural } from '../lib/format';
import type { LibraryTrack, TrackAnalysis } from '../../core/types';
import { makeKey } from '../../core/music/camelot';

export function Cover({ url, title, size = 40, radius = 8 }: { url?: string | null; title: string; size?: number; radius?: number }) {
  const initials = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 33 + title.charCodeAt(i)) % 360;
  return url ? (
    <img className="cover" src={url} alt="" style={{ width: size, height: size, borderRadius: radius }} draggable={false} />
  ) : (
    <div
      className="cover cover-fallback"
      style={{ width: size, height: size, borderRadius: radius, background: `linear-gradient(140deg, hsl(${h} 55% 34%), hsl(${(h + 60) % 360} 60% 18%))`, fontSize: size * 0.34 }}
      aria-hidden
    >
      {initials || <Music2 size={size * 0.45} />}
    </div>
  );
}

export function BpmChip({ a, bpm }: { a?: TrackAnalysis; bpm?: number | null }) {
  const value = bpm ?? a?.bpm ?? null;
  const conf = a?.bpmConfidence ?? 0;
  if (!value) return <Chip title="BPM non détecté">— BPM</Chip>;
  return (
    <Chip title={`Confiance ${Math.round(conf * 100)} %`}>
      <span className={`conf-dot ${conf >= 0.6 ? 'hi' : conf >= 0.3 ? 'mid' : 'lo'}`} />
      <span className="num">{fmtBpm(value)}</span>
    </Chip>
  );
}

export function KeyChip({ camelot, confidence, name }: { camelot?: string; confidence?: number; name?: string }) {
  if (!camelot) return <Chip title="Tonalité non détectée">—</Chip>;
  return (
    <Chip title={`${name ?? ''} · confiance ${Math.round((confidence ?? 0) * 100)} %`} style={{ color: keyColor(camelot), background: keyColor(camelot, 0.14), boxShadow: `inset 0 0 0 0.5px ${keyColor(camelot, 0.35)}` }}>
      <span className="num">{camelot}</span>
    </Chip>
  );
}

const Row = memo(function Row({ t, a, cover, inMix, onMenu }: { t: LibraryTrack; a?: TrackAnalysis; cover?: string | null; inMix: boolean; onMenu: (e: React.MouseEvent) => void }) {
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selection?.kind === 'track' && s.selection.trackId === t.id);
  const addToMixtape = useStore((s) => s.addToMixtape);
  const draggable = t.status === 'ready';
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${t.id}`, data: { type: 'library', trackId: t.id }, disabled: !draggable });
  const o = t.overrides;
  const key = o.key ? makeKey(o.key.tonic, o.key.mode, 1) : a?.key;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`lib-row ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} status-${t.status}`}
      onClick={() => select({ kind: 'track', trackId: t.id })}
      onDoubleClick={() => draggable && addToMixtape([t.id])}
      onContextMenu={onMenu}
      data-testid="library-row"
    >
      <Cover url={cover} title={t.meta.title} size={38} />
      <div className="lib-main">
        <div className="lib-title" title={t.meta.title}>{t.meta.title}</div>
        <div className="lib-sub">
          {t.status === 'ready' && a ? (
            <>
              <span className="lib-artist" title={t.meta.artist}>{t.meta.artist}</span>
              <span className="dot-sep" />
              <span className="num">{fmtTime(a.duration)}</span>
            </>
          ) : t.status === 'error' ? (
            <span className="lib-error" title={t.error}>Illisible · {t.error}</span>
          ) : t.status === 'missing' ? (
            <span className="lib-error">Fichier introuvable</span>
          ) : (
            <span className="lib-pending">{t.status === 'analyzing' ? `Analyse… ${Math.round((t.progress ?? 0) * 100)} %` : 'En attente'}</span>
          )}
        </div>
      </div>
      <div className="lib-meta">
        {t.status === 'ready' && a ? (
          <>
            <BpmChip a={a} bpm={o.bpm} />
            <KeyChip camelot={key?.camelot} confidence={key?.confidence} name={key?.name} />
          </>
        ) : t.status === 'analyzing' || t.status === 'pending' ? (
          <ProgressRing value={t.progress ?? 0} indeterminate={t.status === 'pending'} size={18} />
        ) : t.status === 'error' ? (
          <Tooltip text={t.error ?? 'Erreur'}><AlertTriangle size={16} className="tone-problem" /></Tooltip>
        ) : (
          <FileQuestion size={16} className="tone-warn" />
        )}
        {inMix && <span className="in-mix-dot" title="Dans la mixtape" />}
      </div>
    </div>
  );
});

export function Library() {
  const tracks = useStore((s) => s.tracks);
  const order = useStore((s) => s.libraryOrder);
  const analyses = useStore((s) => s.analyses);
  const covers = useStore((s) => s.covers);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const importing = useStore((s) => s.importing);
  const importPaths = useStore((s) => s.importPaths);
  const addToMixtape = useStore((s) => s.addToMixtape);
  const removeTrack = useStore((s) => s.removeTrack);
  const clearLibrary = useStore((s) => s.clearLibrary);
  const select = useStore((s) => s.select);
  const relinked = useStore((s) => s.relinked);
  const toast = useStore((s) => s.toast);
  const mixtape = useStore((s) => s.mixtapes.find((m) => m.id === s.activeId));
  const isMac = useStore((s) => s.info?.platform === 'darwin');
  const menu = useContextMenu();
  const [sort, setSort] = useState<'added' | 'bpm' | 'key' | 'title'>('added');

  const inMix = useMemo(() => new Set(mixtape?.entries.map((e) => e.trackId)), [mixtape]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let ids = order.filter((id) => tracks[id]);
    if (q) ids = ids.filter((id) => `${tracks[id].meta.title} ${tracks[id].meta.artist} ${tracks[id].meta.album} ${analyses[id]?.key?.camelot ?? ''}`.toLowerCase().includes(q));
    const bpmOf = (id: string) => tracks[id].overrides.bpm ?? analyses[id]?.bpm ?? 999;
    if (sort === 'bpm') ids = [...ids].sort((a, b) => bpmOf(a) - bpmOf(b));
    if (sort === 'title') ids = [...ids].sort((a, b) => tracks[a].meta.title.localeCompare(tracks[b].meta.title));
    if (sort === 'key') ids = [...ids].sort((a, b) => (analyses[a]?.key?.camelot ?? 'zz').localeCompare(analyses[b]?.key?.camelot ?? 'zz', undefined, { numeric: true }));
    return ids;
  }, [order, tracks, analyses, search, sort]);

  const ready = order.filter((id) => tracks[id]?.status === 'ready');
  const missing = order.filter((id) => tracks[id]?.status === 'missing');
  const notInMix = ready.filter((id) => !inMix.has(id));
  const total = order.length;

  const pick = async () => importPaths(await window.mixlab.pickAudioFiles());
  const doRelink = async () => {
    const m = missing.map((id) => ({ id, fileName: tracks[id].fileName, size: tracks[id].size, fingerprint: tracks[id].fingerprint }));
    const r = await window.mixlab.relink(m);
    if (!r) return;
    const n = Object.keys(r).length;
    relinked(r);
    toast({ kind: n ? 'success' : 'warn', title: n ? `${plural(n, 'fichier retrouvé', 'fichiers retrouvés')}` : 'Aucun fichier retrouvé', detail: n < m.length ? `${m.length - n} toujours manquant(s).` : undefined });
  };

  return (
    <aside className="sidebar glass glass-regular" aria-label="Bibliothèque">
      <header className="panel-head">
        <div>
          <h2 className="panel-title">Bibliothèque</h2>
          <p className="panel-sub">{total ? `${plural(total, 'morceau', 'morceaux')} · ${ready.length} analysé${ready.length > 1 ? 's' : ''}` : 'Aucun morceau'}</p>
        </div>
        <div className="panel-actions">
          <IconButton label="Importer des morceaux (⌘I)" onClick={pick}><Plus size={17} /></IconButton>
          <IconButton
            label="Options de la bibliothèque"
            onClick={(e) => menu.open(e, [
              { label: 'Ajouter tous les morceaux à la mixtape', icon: <ListPlus size={14} />, disabled: !notInMix.length, onClick: () => addToMixtape(notInMix) },
              { label: 'Trier par ordre d’ajout', onClick: () => setSort('added') },
              { label: 'Trier par BPM', onClick: () => setSort('bpm') },
              { label: 'Trier par tonalité (Camelot)', onClick: () => setSort('key') },
              { label: 'Trier par titre', onClick: () => setSort('title') },
              { separator: true, label: '' },
              { label: 'Vider la bibliothèque du projet', icon: <Trash2 size={14} />, danger: true, disabled: !total, onClick: () => { if (confirm('Retirer tous les morceaux du projet ? Les fichiers originaux ne sont pas modifiés.')) clearLibrary(); } },
            ])}
          >
            <MoreHorizontal size={17} />
          </IconButton>
        </div>
      </header>

      {importing && (
        <div className="import-progress" role="status">
          <div className="import-progress-head">
            <span>Analyse musicale</span>
            <span className="num">{importing.done}/{importing.total}</span>
          </div>
          <div className="bar"><span style={{ width: `${(importing.done / Math.max(1, importing.total)) * 100}%` }} /></div>
        </div>
      )}

      {missing.length > 0 && (
        <div className="banner banner-warn">
          <FileQuestion size={15} />
          <span>{plural(missing.length, 'fichier introuvable', 'fichiers introuvables')}</span>
          <Button size="sm" variant="ghost" icon={<FolderSearch size={14} />} onClick={doRelink}>Rechercher…</Button>
        </div>
      )}

      {total > 0 && (
        <div className="search">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Titre, artiste, tonalité…" aria-label="Rechercher" />
          {sort !== 'added' && <span className="search-sort"><SlidersHorizontal size={12} /> {sort === 'bpm' ? 'BPM' : sort === 'key' ? 'Clé' : 'A–Z'}</span>}
        </div>
      )}

      <div className="lib-list" data-testid="library-list">
        {total === 0 ? (
          <div className="dropzone" onClick={pick} role="button" tabIndex={0}>
            <div className="dropzone-orb"><Upload size={22} /></div>
            <h3>Déposez vos morceaux ici</h3>
            <p>MP3 (et WAV, FLAC, AAC) — plusieurs fichiers ou un dossier entier. Tout est analysé sur votre ordinateur.</p>
            <Button variant="glass" size="sm">Parcourir…</Button>
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Search size={20} />} title="Aucun résultat">Aucun morceau ne correspond à « {search} ».</EmptyState>
        ) : (
          list.map((id) => (
            <Row
              key={id}
              t={tracks[id]}
              a={analyses[id]}
              cover={covers[id]}
              inMix={inMix.has(id)}
              onMenu={(e) => menu.open(e, [
                { label: 'Ajouter à la mixtape', icon: <ListPlus size={14} />, disabled: tracks[id].status !== 'ready', onClick: () => addToMixtape([id]) },
                { label: 'Infos et corrections', icon: <SlidersHorizontal size={14} />, onClick: () => select({ kind: 'track', trackId: id }) },
                { label: isMac ? 'Afficher dans le Finder' : 'Afficher dans l’explorateur', icon: <FolderSearch size={14} />, disabled: tracks[id].status === 'missing', onClick: () => window.mixlab.reveal(tracks[id].path) },
                { separator: true, label: '' },
                { label: 'Retirer de la bibliothèque', icon: <Trash2 size={14} />, danger: true, onClick: () => removeTrack(id) },
              ])}
            />
          ))
        )}
      </div>
      {total > 0 && (
        <footer className="sidebar-foot">
          <button className="mini-drop" onClick={pick}>
            <Upload size={13} /> Glissez des fichiers n’importe où pour les importer
          </button>
        </footer>
      )}
      {menu.node}
    </aside>
  );
}
