import { useCallback, useEffect, useRef, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Upload, AlertOctagon } from 'lucide-react';
import { useStore } from './state/store';
import { useExport } from './state/exportStore';
import { useMix } from './lib/derived';
import { player } from './lib/player';
import { trackHue } from './lib/format';
import { Library, Cover } from './components/Library';
import { Playlist } from './components/Playlist';
import { MixOverview, ZOOM_EVENT } from './components/MixOverview';
import { Inspector } from './components/Inspector';
import { PlayerBar } from './components/PlayerBar';
import { Toolbar } from './components/Toolbar';
import { GenerateModal, ExportModal, SettingsModal, Toasts } from './components/Modals';

function useBootstrap() {
  useEffect(() => {
    const s = useStore.getState();
    window.mixlab.info().then((info) => {
      s.setInfo(info);
      if (info.reducedMotion) document.documentElement.dataset.reducedMotion = 'true';
      document.documentElement.dataset.platform = info.platform;
    });
    const offs = [
      window.mixlab.onAnalysisProgress((e) => useStore.getState().onProgress(e.id, e.progress)),
      window.mixlab.onAnalysisDone((e) => useStore.getState().onDone(e.id, e.meta, e.analysis, e.cacheDir, e.coverUrl)),
      window.mixlab.onAnalysisError((e) => useStore.getState().onError(e.id, e.error)),
      window.mixlab.onExportProgress((e) => { if (e.id === useExport.getState().id) useExport.getState().set({ frames: e.frames, totalFrames: e.totalFrames, stage: e.stage }); }),
      window.mixlab.onExportDone((e) => {
        if (e.id !== useExport.getState().id) return;
        useExport.getState().set({ status: 'done', report: e.report });
        useStore.getState().toast({ kind: 'success', title: 'Mixtape exportée', detail: e.report.outPath.split(/[\\/]/).pop() });
      }),
      window.mixlab.onExportError((e) => {
        if (e.id !== useExport.getState().id) return;
        useExport.getState().set({ status: e.cancelled ? 'cancelled' : 'error', error: e.error });
        useStore.getState().toast({ kind: e.cancelled ? 'info' : 'error', title: e.cancelled ? 'Export annulé' : 'Échec de l’export', detail: e.cancelled ? undefined : e.error });
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);
}

async function saveProject(as = false): Promise<boolean> {
  const s = useStore.getState();
  try {
    const p = await window.mixlab.saveProject(s.serialize(), as ? null : s.projectPath);
    if (!p) return false;
    s.markSaved(p);
    s.toast({ kind: 'success', title: 'Projet enregistré', detail: p.split(/[\\/]/).pop() });
    return true;
  } catch (e: any) {
    s.toast({ kind: 'error', title: 'Enregistrement impossible', detail: e?.message });
    return false;
  }
}

async function openProject() {
  const s = useStore.getState();
  if (s.dirty && !confirm('Le projet actuel contient des modifications non enregistrées. Continuer ?')) return;
  try {
    const r = await window.mixlab.openProject();
    if (!r) return;
    await player().stop();
    s.load(r.path, r.project, r.exists);
    const missing = Object.values(r.exists).filter((x) => !x).length;
    s.toast({ kind: missing ? 'warn' : 'success', title: `Projet « ${r.project.name} » ouvert`, detail: missing ? `${missing} fichier(s) introuvable(s) : utilisez « Rechercher… » dans la bibliothèque.` : undefined });
  } catch (e: any) {
    s.toast({ kind: 'error', title: 'Ouverture impossible', detail: e?.message });
  }
}

export function App() {
  useBootstrap();
  const { mixtape, tracks, pairs, plan, specs } = useMix();
  const importPaths = useStore((s) => s.importPaths);
  const addToMixtape = useStore((s) => s.addToMixtape);
  const moveEntry = useStore((s) => s.moveEntry);
  const dirty = useStore((s) => s.dirty);
  const selection = useStore((s) => s.selection);
  const libTracks = useStore((s) => s.tracks);
  const covers = useStore((s) => s.covers);
  const ffmpegError = useStore((s) => (s.info && !s.info.ffmpeg.ok ? s.info.ffmpeg.error : null));
  const [fileOver, setFileOver] = useState(false);
  const [dragTrack, setDragTrack] = useState<string | null>(null);
  const dragDepth = useRef(0);

  // Keep the preview player on the latest plan (same engine and parameters as export).
  useEffect(() => { player().setPlan(plan); }, [plan]);
  useEffect(() => { window.mixlab.setDirty(dirty); }, [dirty]);

  // Menu commands
  useEffect(() => window.mixlab.onMenu(async (cmd) => {
    const s = useStore.getState();
    switch (cmd) {
      case 'new':
        if (s.dirty && !confirm('Abandonner les modifications non enregistrées ?')) return;
        await player().stop();
        s.reset();
        break;
      case 'open': await openProject(); break;
      case 'save': await saveProject(false); break;
      case 'save-as': await saveProject(true); break;
      case 'save-and-close': if (await saveProject(false)) window.mixlab.closeNow(); break;
      case 'import': await s.importPaths(await window.mixlab.pickAudioFiles()); break;
      case 'export': if (s.active().entries.length) s.setModal('export'); break;
      case 'generate': s.setModal('generate'); break;
      case 'play': player().toggle(); break;
    }
  }), []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const s = useStore.getState();
      if (e.code === 'Space' && !s.modal) { e.preventDefault(); player().toggle(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && s.selection?.kind === 'entry') s.removeEntry(s.selection.entryId);
      else if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void saveProject(e.shiftKey); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'o') { e.preventDefault(); void openProject(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: 'in' })); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: 'out' })); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: 'fit' })); }
      else if (e.key === 'Escape' && !s.modal) s.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // OS file drag & drop anywhere in the window
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setFileOver(true); };
  const onDragLeave = (e: React.DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setFileOver(false); };
  const onDragOver = (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setFileOver(false);
    const paths = Array.from(e.dataTransfer.files).map((f) => window.mixlab.pathForFile(f)).filter(Boolean);
    void importPaths(paths);
  };

  // In-app drag & drop (library → playlist, playlist reordering)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as any;
    if (d?.type === 'library') setDragTrack(d.trackId);
    else {
      const entry = mixtape.entries.find((x) => x.id === e.active.id);
      setDragTrack(entry?.trackId ?? null);
    }
  };
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setDragTrack(null);
    const d = e.active.data.current as any;
    const over = e.over?.id as string | undefined;
    const entries = useStore.getState().active().entries;
    if (d?.type === 'library') {
      if (!over) return;
      const idx = over === 'playlist' ? entries.length : entries.findIndex((x) => x.id === over);
      addToMixtape([d.trackId], idx < 0 ? entries.length : idx);
      return;
    }
    if (!over || over === e.active.id) return;
    const from = entries.findIndex((x) => x.id === e.active.id);
    const to = over === 'playlist' ? entries.length - 1 : entries.findIndex((x) => x.id === over);
    if (from < 0 || to < 0 || from === to) return;
    // Locked entries keep their index.
    if (entries[to].locked) { useStore.getState().toast({ kind: 'warn', title: 'Position verrouillée', detail: 'Déverrouillez ce morceau pour le déplacer.' }); return; }
    moveEntry(from, to);
  }, [addToMixtape, moveEntry]);

  // Ambient light follows the selected / playing track
  const focusTrack = selection?.kind === 'track' ? selection.trackId : selection?.kind === 'entry' ? mixtape.entries.find((x) => x.id === selection.entryId)?.trackId : mixtape.entries[0]?.trackId;
  const hue = focusTrack ? trackHue(focusTrack) : 228;

  return (
    <div className="app" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop} style={{ '--ambient-hue': hue } as React.CSSProperties}>
      <div className="ambient" aria-hidden>
        <span className="orb orb-1" /><span className="orb orb-2" /><span className="orb orb-3" />
      </div>
      <Toolbar onSave={() => void saveProject(false)} />
      {ffmpegError && <div className="fatal glass glass-thick"><AlertOctagon size={16} /> {ffmpegError}</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragTrack(null)}>
        <main className="workspace">
          <Library />
          <div className="center">
            {plan.voices.length > 0 && <MixOverview plan={plan} tracks={tracks} />}
            <Playlist plan={plan} tracks={tracks} pairs={pairs} />
          </div>
          <Inspector plan={plan} mixtape={mixtape} tracks={tracks} pairs={pairs} specs={specs} />
        </main>
        <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
          {dragTrack && libTracks[dragTrack] ? (
            <div className="drag-ghost glass glass-thick">
              <Cover url={covers[dragTrack]} title={libTracks[dragTrack].meta.title} size={30} radius={7} />
              <span>{libTracks[dragTrack].meta.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <PlayerBar plan={plan} />
      {fileOver && (
        <div className="file-drop" aria-hidden>
          <div className="file-drop-card glass glass-thick">
            <div className="file-drop-orb"><Upload size={26} /></div>
            <strong>Déposez pour importer</strong>
            <span>Les morceaux seront analysés sur votre ordinateur</span>
          </div>
        </div>
      )}
      <GenerateModal />
      <ExportModal />
      <SettingsModal />
      <Toasts />
    </div>
  );
}
