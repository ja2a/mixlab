import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useStore } from '../state/store';
import { player } from '../lib/player';
import { usePlayhead } from '../lib/usePlayer';
import { fmtTime, trackHue } from '../lib/format';
import { Waveform } from './Waveform';
import { IconButton } from './ui';
import type { MixPlan } from '../../core/mix/plan';
import type { EffectiveTrack } from '../../core/types';

/** Narrowest visible window when fully zoomed in (seconds). */
const MIN_VISIBLE = 15;
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 1200];
/** After a manual scroll, the view stops following the playhead for this long (ms). */
const FOLLOW_PAUSE = 2500;

/** Zoom requests from keyboard shortcuts: 'in' | 'out' | 'fit'. */
export const ZOOM_EVENT = 'mixlab:timeline-zoom';

/** Horizontal overview of the whole mix: staggered lanes, overlaps, transitions, playhead; zoomable. */
export function MixOverview({ plan, tracks }: { plan: MixPlan; tracks: Map<string, EffectiveTrack> }) {
  const viewport = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const [hover, setHover] = useState<number | null>(null);
  const [zoom, setZoomState] = useState(1);
  const D = Math.max(1, plan.duration);
  const maxZoom = Math.max(1, D / MIN_VISIBLE);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const anchor = useRef<{ t: number; cx: number } | null>(null);
  const userScrollAt = useRef(0);

  /** Change the zoom while keeping the time under `clientX` (default: viewport centre) in place. */
  const zoomTo = useCallback((next: number, clientX?: number) => {
    const vp = viewport.current;
    const z = Math.min(maxZoom, Math.max(1, next));
    if (!vp || z === zoomRef.current) return;
    const r = vp.getBoundingClientRect();
    const cx = clientX === undefined ? r.width / 2 : clientX - r.left;
    anchor.current = { t: (vp.scrollLeft + cx) / vp.scrollWidth, cx };
    userScrollAt.current = performance.now();
    setZoomState(z);
  }, [maxZoom]);

  useLayoutEffect(() => {
    const vp = viewport.current;
    if (!vp || !anchor.current) return;
    vp.scrollLeft = anchor.current.t * vp.scrollWidth - anchor.current.cx;
    anchor.current = null;
  }, [zoom]);

  // Keep the zoom valid when the mix gets shorter.
  useEffect(() => { if (zoom > maxZoom) setZoomState(maxZoom); }, [zoom, maxZoom]);

  // Pinch / ⌘-wheel zooms around the cursor; a plain wheel pans when zoomed in.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX);
      } else if (zoomRef.current > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        vp.scrollLeft += e.deltaY;
        userScrollAt.current = performance.now();
      } else if (Math.abs(e.deltaX) > 0) {
        userScrollAt.current = performance.now();
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Keyboard shortcuts (dispatched by App).
  useEffect(() => {
    const on = (e: Event) => {
      const cmd = (e as CustomEvent<'in' | 'out' | 'fit'>).detail;
      if (cmd === 'fit') zoomTo(1);
      else zoomTo(zoomRef.current * (cmd === 'in' ? 2 : 0.5));
    };
    window.addEventListener(ZOOM_EVENT, on);
    return () => window.removeEventListener(ZOOM_EVENT, on);
  }, [zoomTo]);

  // Playhead, and auto-follow while playing unless the user just scrolled.
  usePlayhead(useCallback((pos: number) => {
    if (head.current) head.current.style.left = `${(pos / D) * 100}%`;
    const vp = viewport.current;
    if (!vp || zoomRef.current <= 1 || !player().isActive || performance.now() - userScrollAt.current < FOLLOW_PAUSE) return;
    const x = (pos / D) * vp.scrollWidth;
    const w = vp.clientWidth;
    if (x < vp.scrollLeft + 0.05 * w || x > vp.scrollLeft + 0.85 * w) vp.scrollLeft = x - 0.2 * w;
  }, [D]));

  // Bring the selected transition / track into view.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp || zoom <= 1 || !selection) return;
    let t0: number | null = null, t1: number | null = null;
    if (selection.kind === 'transition') {
      const t = plan.transitions.find((x) => x.fromEntryId === selection.fromEntryId);
      if (t) { t0 = t.start; t1 = t.end; }
    } else if (selection.kind === 'entry') {
      const v = plan.voices.find((x) => x.entryId === selection.entryId);
      if (v) { t0 = v.start; t1 = Math.min(v.end, v.start + (D / zoom) * 0.8); }
    }
    if (t0 === null || t1 === null) return;
    const x0 = (t0 / D) * vp.scrollWidth, x1 = (t1 / D) * vp.scrollWidth;
    if (x0 < vp.scrollLeft || x1 > vp.scrollLeft + vp.clientWidth) {
      vp.scrollTo({ left: Math.max(0, x0 - 0.15 * vp.clientWidth), behavior: 'smooth' });
    }
  }, [selection, zoom, plan, D]);

  const visible = D / zoom;
  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => visible / s <= 10) ?? 1800;
    const out: number[] = [];
    for (let t = 0; t <= D; t += step) out.push(t);
    return out;
  }, [D, visible]);

  const posFromEvent = (e: React.MouseEvent) => {
    const r = lanes.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, ((e.clientX - r.left) / r.width) * D));
  };

  return (
    <section className="overview glass glass-thin" aria-label="Vue d’ensemble du mix">
      <div className="overview-head">
        <span className="section-title">Timeline</span>
        <div className="zoom-controls" role="group" aria-label="Zoom de la timeline">
          <IconButton size="sm" label="Dézoomer (⌘−)" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 2)}><ZoomOut size={14} /></IconButton>
          <span className="zoom-value num" data-testid="zoom-value" title={`${fmtTime(visible)} visibles`}>{zoom <= 1 ? 'Tout' : `${zoom < 10 ? zoom.toFixed(1).replace('.', ',') : Math.round(zoom)}×`}</span>
          <IconButton size="sm" label="Zoomer (⌘+)" disabled={zoom >= maxZoom} onClick={() => zoomTo(zoom * 2)}><ZoomIn size={14} /></IconButton>
          <IconButton size="sm" label="Tout afficher (⌘0)" disabled={zoom <= 1} onClick={() => zoomTo(1)}><Maximize2 size={13} /></IconButton>
        </div>
      </div>
      <div ref={viewport} className={`overview-viewport ${zoom > 1 ? 'is-zoomed' : ''}`} onScroll={() => { if (!anchor.current) userScrollAt.current = performance.now(); }}>
        <div className="overview-content" style={{ width: `${zoom * 100}%` }} data-testid="timeline-content">
          <div className="overview-ruler">
            {ticks.map((t) => (
              <span key={t} className={`tick ${t > D - visible * 0.06 ? 'is-end' : ''}`} style={{ left: `${(t / D) * 100}%` }}>{fmtTime(t)}</span>
            ))}
          </div>
          <div
            ref={lanes}
            className="overview-lanes"
            onMouseMove={(e) => setHover(posFromEvent(e))}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => { void player().seek(posFromEvent(e)); }}
            data-testid="mix-overview"
          >
            {plan.transitions.map((t) => (
              <button
                key={t.fromEntryId}
                className={`ov-transition sev-${t.severity} ${selection?.kind === 'transition' && selection.fromEntryId === t.fromEntryId ? 'is-selected' : ''}`}
                style={{ left: `${(t.start / D) * 100}%`, width: `${(t.duration / D) * 100}%` }}
                onClick={(e) => { e.stopPropagation(); select({ kind: 'transition', fromEntryId: t.fromEntryId }); }}
                title={`Transition ${t.index + 1} · ${fmtTime(t.start)} – ${fmtTime(t.end)}`}
              />
            ))}
            {plan.voices.map((v, i) => {
              const tr = tracks.get(v.trackId);
              const hue = trackHue(v.trackId);
              const sel = selection?.kind === 'entry' && selection.entryId === v.entryId;
              return (
                <div
                  key={v.entryId}
                  className={`ov-block lane-${i % 2} ${sel ? 'is-selected' : ''}`}
                  style={{ left: `${(v.start / D) * 100}%`, width: `${((v.end - v.start) / D) * 100}%`, '--hue': hue } as React.CSSProperties}
                  onClick={(e) => { e.stopPropagation(); select({ kind: 'entry', entryId: v.entryId }); }}
                  onDoubleClick={(e) => { e.stopPropagation(); void player().play(v.start); }}
                >
                  {tr && <Waveform data={tr.analysis.waveform} duration={tr.analysis.duration} from={v.srcStart} to={v.srcEnd} style="fill" hue={hue} />}
                  <span className="ov-label">{v.title}</span>
                </div>
              );
            })}
            <div ref={head} className="playhead" />
            {hover !== null && (
              <div className="hover-line" style={{ left: `${(hover / D) * 100}%` }}>
                <span>{fmtTime(hover)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
