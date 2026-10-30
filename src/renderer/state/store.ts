import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  type LibraryTrack,
  type MixSettings,
  type Mixtape,
  type PlaylistEntry,
  type ProjectFile,
  type TrackAnalysis,
  type TrackOverrides,
  type TransitionSpec,
} from '../../core/types';
import type { AppInfo } from '../../shared/api';

export type Selection = { kind: 'transition'; fromEntryId: string } | { kind: 'entry'; entryId: string } | { kind: 'track'; trackId: string } | null;

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
}

export type ModalName = 'generate' | 'export' | 'settings' | null;

interface State {
  info: AppInfo | null;
  projectName: string;
  projectPath: string | null;
  dirty: boolean;
  tracks: Record<string, LibraryTrack>;
  libraryOrder: string[];
  analyses: Record<string, TrackAnalysis>;
  covers: Record<string, string | null>;
  mixtapes: Mixtape[];
  activeId: string;
  selection: Selection;
  toasts: Toast[];
  modal: ModalName;
  search: string;
  importing: { total: number; done: number } | null;
}

interface Actions {
  setInfo(info: AppInfo): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  setModal(m: ModalName): void;
  setSearch(s: string): void;
  select(s: Selection): void;

  importPaths(paths: string[]): Promise<void>;
  onProgress(id: string, progress: number): void;
  onDone(id: string, meta: LibraryTrack['meta'], analysis: TrackAnalysis, cacheDir: string, coverUrl: string | null): void;
  onError(id: string, error: string): void;
  removeTrack(id: string): void;
  clearLibrary(): void;
  setOverrides(trackId: string, o: TrackOverrides): void;

  active(): Mixtape;
  addToMixtape(trackIds: string[], index?: number): void;
  removeEntry(entryId: string): void;
  moveEntry(from: number, to: number): void;
  patchEntry(entryId: string, patch: Partial<PlaylistEntry>): void;
  setTransition(fromEntryId: string, spec: TransitionSpec): void;
  clearTransition(fromEntryId: string): void;
  patchTransition(fromEntryId: string, base: TransitionSpec, patch: Partial<TransitionSpec>): void;
  applyOrder(order: string[]): void;
  restoreManualOrder(): void;
  setSettings(patch: Partial<MixSettings>): void;
  newMixtape(): void;
  renameMixtape(id: string, name: string): void;
  deleteMixtape(id: string): void;
  setActive(id: string): void;

  setProjectName(n: string): void;
  serialize(): ProjectFile;
  load(path: string, p: ProjectFile, exists: Record<string, boolean>): void;
  reset(): void;
  markSaved(path: string): void;
  relinked(map: Record<string, string>): void;
}

const uid = () => crypto.randomUUID().slice(0, 12);
let toastSeq = 0;

function emptyMixtape(name = 'Mixtape 1'): Mixtape {
  return { id: uid(), name, entries: [], transitions: {}, manualOrder: null, settings: { ...DEFAULT_SETTINGS }, createdAt: Date.now() };
}

const initial = (): State => {
  const m = emptyMixtape();
  return {
    info: null,
    projectName: 'Nouveau projet',
    projectPath: null,
    dirty: false,
    tracks: {},
    libraryOrder: [],
    analyses: {},
    covers: {},
    mixtapes: [m],
    activeId: m.id,
    selection: null,
    toasts: [],
    modal: null,
    search: '',
    importing: null,
  };
};

export const useStore = create<State & Actions>()((set, get) => {
  const mutateActive = (fn: (m: Mixtape) => Mixtape) =>
    set((s) => ({ mixtapes: s.mixtapes.map((m) => (m.id === s.activeId ? fn(m) : m)), dirty: true }));

  return {
    ...initial(),

    setInfo: (info) => set({ info }),
    toast: (t) => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
      setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 8000 : 4500);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setModal: (modal) => set({ modal }),
    setSearch: (search) => set({ search }),
    select: (selection) => set({ selection }),

    importPaths: async (paths) => {
      if (!paths.length) return;
      const files = await window.mixlab.inspectFiles(paths);
      const s = get();
      const byFp = new Map(Object.values(s.tracks).map((t) => [t.fingerprint, t]));
      const added: LibraryTrack[] = [];
      let dupes = 0;
      const errors: string[] = [];
      for (const f of files) {
        if (f.error) { errors.push(`${f.fileName} : ${f.error}`); continue; }
        if (byFp.has(f.fingerprint)) { dupes++; continue; }
        const t: LibraryTrack = {
          id: uid(), path: f.path, fileName: f.fileName, size: f.size, fingerprint: f.fingerprint,
          meta: { title: f.fileName.replace(/\.[^.]+$/, ''), artist: '', album: '', year: '', genre: '', hasArtwork: false },
          status: 'pending', progress: 0, overrides: {}, addedAt: Date.now(),
        };
        byFp.set(f.fingerprint, t);
        added.push(t);
      }
      set((st) => ({
        tracks: { ...st.tracks, ...Object.fromEntries(added.map((t) => [t.id, t])) },
        libraryOrder: [...st.libraryOrder, ...added.map((t) => t.id)],
        importing: added.length ? { total: (st.importing?.total ?? 0) + added.length, done: st.importing?.done ?? 0 } : st.importing,
        dirty: st.dirty || added.length > 0,
      }));
      if (dupes) get().toast({ kind: 'info', title: `${dupes} doublon${dupes > 1 ? 's' : ''} ignoré${dupes > 1 ? 's' : ''}`, detail: 'Ces fichiers sont déjà dans la bibliothèque (contenu identique).' });
      if (errors.length) get().toast({ kind: 'error', title: `${errors.length} fichier${errors.length > 1 ? 's' : ''} non importé${errors.length > 1 ? 's' : ''}`, detail: errors.slice(0, 3).join('\n') });
      if (added.length) await window.mixlab.analyze(added.map((t) => ({ id: t.id, path: t.path, fingerprint: t.fingerprint })));
    },
    onProgress: (id, progress) =>
      set((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], status: 'analyzing', progress } } } : {})),
    onDone: (id, meta, analysis, cacheDir, coverUrl) => {
      const norm = (x: string) => x.trim().toLowerCase();
      const twin = Object.values(get().tracks).find((t) => t.id !== id && t.status === 'ready' && norm(t.meta.title) === norm(meta.title) && norm(t.meta.artist) === norm(meta.artist));
      if (twin) get().toast({ kind: 'warn', title: 'Doublon probable', detail: `« ${meta.title} » (${meta.artist}) existe déjà dans la bibliothèque avec un contenu différent.` });
      set((s) => {
        const t = s.tracks[id];
        if (!t) return {};
        const importing = s.importing ? { ...s.importing, done: s.importing.done + 1 } : null;
        return {
          tracks: { ...s.tracks, [id]: { ...t, meta: { ...meta }, status: 'ready', progress: 1, cacheDir, error: undefined } },
          analyses: { ...s.analyses, [id]: analysis },
          covers: { ...s.covers, [id]: coverUrl },
          importing: importing && importing.done >= importing.total ? null : importing,
        };
      });
    },
    onError: (id, error) =>
      set((s) => {
        const t = s.tracks[id];
        if (!t) return {};
        const importing = s.importing ? { ...s.importing, done: s.importing.done + 1 } : null;
        return {
          tracks: { ...s.tracks, [id]: { ...t, status: 'error', error } },
          importing: importing && importing.done >= importing.total ? null : importing,
        };
      }),
    removeTrack: (id) =>
      set((s) => {
        const tracks = { ...s.tracks };
        delete tracks[id];
        return {
          tracks,
          libraryOrder: s.libraryOrder.filter((x) => x !== id),
          mixtapes: s.mixtapes.map((m) => {
            const gone = new Set(m.entries.filter((e) => e.trackId === id).map((e) => e.id));
            return { ...m, entries: m.entries.filter((e) => !gone.has(e.id)), manualOrder: m.manualOrder?.filter((x) => !gone.has(x)) ?? null };
          }),
          selection: s.selection?.kind === 'track' && s.selection.trackId === id ? null : s.selection,
          dirty: true,
        };
      }),
    clearLibrary: () =>
      set((s) => ({
        tracks: {}, libraryOrder: [], analyses: {}, covers: {},
        mixtapes: s.mixtapes.map((m) => ({ ...m, entries: [], transitions: {}, manualOrder: null })),
        selection: null, dirty: true,
      })),
    setOverrides: (trackId, o) =>
      set((s) => ({ tracks: { ...s.tracks, [trackId]: { ...s.tracks[trackId], overrides: o } }, dirty: true })),

    active: () => {
      const s = get();
      return s.mixtapes.find((m) => m.id === s.activeId) ?? s.mixtapes[0];
    },
    addToMixtape: (trackIds, index) =>
      mutateActive((m) => {
        const ready = trackIds.filter((id) => get().tracks[id] && get().tracks[id].status !== 'error');
        const items: PlaylistEntry[] = ready.map((trackId) => ({ id: uid(), trackId, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
        const entries = [...m.entries];
        entries.splice(index ?? entries.length, 0, ...items);
        return { ...m, entries };
      }),
    removeEntry: (entryId) => {
      mutateActive((m) => {
        const transitions = { ...m.transitions };
        delete transitions[entryId];
        return { ...m, entries: m.entries.filter((e) => e.id !== entryId), transitions, manualOrder: m.manualOrder?.filter((x) => x !== entryId) ?? null };
      });
      const sel = get().selection;
      if ((sel?.kind === 'entry' && sel.entryId === entryId) || (sel?.kind === 'transition' && sel.fromEntryId === entryId)) set({ selection: null });
    },
    moveEntry: (from, to) =>
      mutateActive((m) => {
        const entries = [...m.entries];
        const [e] = entries.splice(from, 1);
        entries.splice(to, 0, e);
        // A manual move defines the new manual order.
        return { ...m, entries, manualOrder: null };
      }),
    patchEntry: (entryId, patch) => mutateActive((m) => ({ ...m, entries: m.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) })),
    setTransition: (fromEntryId, spec) => mutateActive((m) => ({ ...m, transitions: { ...m.transitions, [fromEntryId]: spec } })),
    clearTransition: (fromEntryId) =>
      mutateActive((m) => {
        const transitions = { ...m.transitions };
        delete transitions[fromEntryId];
        return { ...m, transitions };
      }),
    patchTransition: (fromEntryId, base, patch) => {
      const m = get().active();
      const i = m.entries.findIndex((e) => e.id === fromEntryId);
      const to = m.entries[i + 1]?.id;
      get().setTransition(fromEntryId, { ...base, ...patch, origin: patch.origin ?? 'manual', toEntryId: to });
    },
    applyOrder: (order) =>
      mutateActive((m) => {
        const byId = new Map(m.entries.map((e) => [e.id, e]));
        const entries = order.map((id) => byId.get(id)!).filter(Boolean);
        for (const e of m.entries) if (!order.includes(e.id)) entries.push(e);
        return { ...m, entries, manualOrder: m.manualOrder ?? m.entries.map((e) => e.id) };
      }),
    restoreManualOrder: () =>
      mutateActive((m) => {
        if (!m.manualOrder) return m;
        const byId = new Map(m.entries.map((e) => [e.id, e]));
        const entries = m.manualOrder.map((id) => byId.get(id)!).filter(Boolean);
        for (const e of m.entries) if (!m.manualOrder.includes(e.id)) entries.push(e);
        return { ...m, entries, manualOrder: null };
      }),
    setSettings: (patch) => mutateActive((m) => ({ ...m, settings: { ...m.settings, ...patch } })),
    newMixtape: () => {
      const m = emptyMixtape(`Mixtape ${get().mixtapes.length + 1}`);
      set((s) => ({ mixtapes: [...s.mixtapes, m], activeId: m.id, selection: null, dirty: true }));
    },
    renameMixtape: (id, name) => set((s) => ({ mixtapes: s.mixtapes.map((m) => (m.id === id ? { ...m, name } : m)), dirty: true })),
    deleteMixtape: (id) =>
      set((s) => {
        if (s.mixtapes.length <= 1) return {};
        const mixtapes = s.mixtapes.filter((m) => m.id !== id);
        return { mixtapes, activeId: s.activeId === id ? mixtapes[0].id : s.activeId, selection: null, dirty: true };
      }),
    setActive: (activeId) => set({ activeId, selection: null }),

    setProjectName: (projectName) => set({ projectName, dirty: true }),
    serialize: () => {
      const s = get();
      return {
        format: 'mixlab-project', version: 1, name: s.projectName,
        tracks: s.libraryOrder.map((id) => s.tracks[id]).filter(Boolean).map((t) => ({
          id: t.id, path: t.path, fileName: t.fileName, size: t.size, fingerprint: t.fingerprint, meta: t.meta, overrides: t.overrides, addedAt: t.addedAt,
        })),
        mixtapes: s.mixtapes,
        activeMixtapeId: s.activeId,
        savedAt: Date.now(),
      };
    },
    load: (path, p, exists) => {
      const tracks: Record<string, LibraryTrack> = {};
      for (const t of p.tracks) {
        tracks[t.id] = { ...t, status: exists[t.id] ? 'pending' : 'missing', progress: 0, error: exists[t.id] ? undefined : 'Fichier introuvable' };
      }
      set({
        ...initial(),
        info: get().info,
        projectName: p.name,
        projectPath: path,
        tracks,
        libraryOrder: p.tracks.map((t) => t.id),
        mixtapes: p.mixtapes.length ? p.mixtapes : [emptyMixtape()],
        activeId: p.activeMixtapeId && p.mixtapes.some((m) => m.id === p.activeMixtapeId) ? p.activeMixtapeId : (p.mixtapes[0]?.id ?? ''),
        importing: { total: p.tracks.filter((t) => exists[t.id]).length, done: 0 },
      });
      const jobs = p.tracks.filter((t) => exists[t.id]).map((t) => ({ id: t.id, path: t.path, fingerprint: t.fingerprint }));
      if (!jobs.length) set({ importing: null });
      else void window.mixlab.analyze(jobs);
    },
    reset: () => set({ ...initial(), info: get().info }),
    markSaved: (projectPath) => set({ projectPath, dirty: false }),
    relinked: (map) => {
      const s = get();
      const tracks = { ...s.tracks };
      const jobs: Array<{ id: string; path: string; fingerprint: string }> = [];
      for (const [id, p] of Object.entries(map)) {
        if (!tracks[id]) continue;
        tracks[id] = { ...tracks[id], path: p, status: 'pending', error: undefined };
        jobs.push({ id, path: p, fingerprint: tracks[id].fingerprint });
      }
      set({ tracks, dirty: true });
      if (jobs.length) void window.mixlab.analyze(jobs);
    },
  };
});
