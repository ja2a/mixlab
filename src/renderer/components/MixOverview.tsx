import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { player } from '../lib/player';
import { usePlayhead } from '../lib/usePlayer';
import { fmtTime, trackHue } from '../lib/format';
import { Waveform } from './Waveform';
import type { MixPlan } from '../../core/mix/plan';
import type { EffectiveTrack } from '../../core/types';

/** Horizontal overview of the whole mix: staggered lanes, overlaps, transitions, playhead. */
export function MixOverview({ plan, tracks }: { plan: MixPlan; tracks: Map<string, EffectiveTrack> }) {
  const ref = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const [hover, setHover] = useState<number | null>(null);
  const D = Math.max(1, plan.duration);

  usePlayhead(useCallback((pos: number) => {
    if (head.current) head.current.style.left = `${(pos / D) * 100}%`;
  }, [D]));

  const ticks = useMemo(() => {
    const step = D > 3600 ? 600 : D > 1200 ? 300 : D > 480 ? 60 : 30;
    const out: number[] = [];
    for (let t = 0; t <= D; t += step) out.push(t);
    return out;
  }, [D]);

  const posFromEvent = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, ((e.clientX - r.left) / r.width) * D));
  };

  return (
    <section className="overview glass glass-thin" aria-label="Vue d’ensemble du mix">
      <div className="overview-ruler">
        {ticks.map((t) => (
          <span key={t} className="tick" style={{ left: `${(t / D) * 100}%` }}>{fmtTime(t)}</span>
        ))}
      </div>
      <div
        ref={ref}
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
    </section>
  );
}
