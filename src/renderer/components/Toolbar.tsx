import { useState } from 'react';
import { Plus, Settings2, Share, Sparkles, Save, Trash2, PencilLine } from 'lucide-react';
import { useStore } from '../state/store';
import { useExport } from '../state/exportStore';
import { Button, IconButton, ProgressRing, useContextMenu } from './ui';

export function GenerateButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button className="generate-btn" disabled={disabled} onClick={onClick} data-testid="generate-button">
      <span className="generate-rim" aria-hidden />
      <span className="generate-inner">
        <Sparkles size={15} />
        <span>Générer une mixtape</span>
      </span>
    </button>
  );
}

export function Toolbar({ onSave }: { onSave: () => void }) {
  const projectName = useStore((s) => s.projectName);
  const setProjectName = useStore((s) => s.setProjectName);
  const mixtapes = useStore((s) => s.mixtapes);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const newMixtape = useStore((s) => s.newMixtape);
  const renameMixtape = useStore((s) => s.renameMixtape);
  const deleteMixtape = useStore((s) => s.deleteMixtape);
  const setModal = useStore((s) => s.setModal);
  const dirty = useStore((s) => s.dirty);
  const isMac = useStore((s) => s.info?.platform === 'darwin');
  const readyCount = useStore((s) => Object.values(s.tracks).filter((t) => t.status === 'ready').length);
  const entries = useStore((s) => s.mixtapes.find((m) => m.id === s.activeId)?.entries.length ?? 0);
  const ex = useExport();
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState(false);
  const menu = useContextMenu();

  return (
    <header className={`toolbar ${isMac ? 'is-mac' : 'is-win'}`}>
      <div className="toolbar-left">
        <div className="brand" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24"><defs><linearGradient id="brand-out" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#9cb9ff" /><stop offset="1" stopColor="#4a78ff" /></linearGradient><linearGradient id="brand-in" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#7656ff" /><stop offset="1" stopColor="#d2bdff" /></linearGradient></defs><path d="M3 7C10.15 7 13.85 17 21 17" pathLength={1} strokeDasharray="0.343 0.314 1" fill="none" stroke="url(#brand-out)" strokeWidth="2.5" strokeLinecap="round" /><path d="M3 17C10.15 17 13.85 7 21 7" fill="none" stroke="url(#brand-in)" strokeWidth="2.5" strokeLinecap="round" /></svg>
        </div>
        {editName ? (
          <input className="project-input" autoFocus defaultValue={projectName} onBlur={(e) => { setProjectName(e.target.value.trim() || 'Sans titre'); setEditName(false); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditName(false); }} />
        ) : (
          <button className="project-name" onDoubleClick={() => setEditName(true)} title="Double-cliquez pour renommer le projet">
            {projectName}{dirty && <span className="dirty-dot" title="Modifications non enregistrées" />}
          </button>
        )}
        <nav className="tabs" aria-label="Mixtapes">
          {mixtapes.map((m) =>
            editing === m.id ? (
              <input key={m.id} className="tab-input" autoFocus defaultValue={m.name} onBlur={(e) => { renameMixtape(m.id, e.target.value.trim() || m.name); setEditing(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
            ) : (
              <button
                key={m.id}
                className={`tab ${m.id === activeId ? 'is-active' : ''}`}
                onClick={() => setActive(m.id)}
                onDoubleClick={() => setEditing(m.id)}
                onContextMenu={(e) => menu.open(e, [
                  { label: 'Renommer', icon: <PencilLine size={14} />, onClick: () => setEditing(m.id) },
                  { label: 'Supprimer cette mixtape', icon: <Trash2 size={14} />, danger: true, disabled: mixtapes.length <= 1, onClick: () => { if (confirm(`Supprimer « ${m.name} » ?`)) deleteMixtape(m.id); } },
                ])}
              >
                {m.name}<span className="tab-count num">{m.entries.length}</span>
              </button>
            ),
          )}
          <IconButton label="Nouvelle mixtape" size="sm" onClick={newMixtape}><Plus size={14} /></IconButton>
        </nav>
      </div>
      <div className="toolbar-right">
        {ex.status === 'running' && (
          <button className="export-pill" onClick={() => setModal('export')}>
            <ProgressRing value={ex.totalFrames ? ex.frames / ex.totalFrames : 0} size={16} />
            <span className="num">Export {Math.round((ex.frames / Math.max(1, ex.totalFrames)) * 100)} %</span>
          </button>
        )}
        <GenerateButton disabled={readyCount < 2} onClick={() => setModal('generate')} />
        <Button variant="glass" icon={<Share size={15} />} disabled={entries === 0} onClick={() => setModal('export')} data-testid="export-button">Exporter</Button>
        <IconButton label="Enregistrer le projet (⌘S)" onClick={onSave}><Save size={16} /></IconButton>
        <IconButton label="Réglages du mixage" onClick={() => setModal('settings')}><Settings2 size={16} /></IconButton>
      </div>
      {menu.node}
    </header>
  );
}
