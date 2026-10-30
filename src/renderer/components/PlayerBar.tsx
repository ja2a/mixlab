import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX, Headphones } from 'lucide-react';
import { player } from '../lib/player';
import { usePlayer, usePlayhead } from '../lib/usePlayer';
import { useStore } from '../state/store';
import { fmtTime } from '../lib/format';
import { IconButton } from './ui';
import { Cover } from './Library';
import type { MixPlan } from '../../core/mix/plan';

function Spectrum({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const an = player().analyser;
    const data = new Uint8Array(an.frequencyBinCount);
    const bars = 36;
    const level = new Float32Array(bars);
    let raf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      an.getByteFrequencyData(data);
      const nyq = an.context.sampleRate / 2;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const f0 = 40 * Math.pow(16000 / 40, i / bars), f1 = 40 * Math.pow(16000 / 40, (i + 1) / bars);
        const a = Math.floor((f0 / nyq) * data.length), b = Math.max(a + 1, Math.floor((f1 / nyq) * data.length));
        let m = 0;
        for (let k = a; k < b; k++) m = Math.max(m, data[k]);
        const target = active ? m / 255 : 0;
        level[i] += (target - level[i]) * (target > level[i] ? 0.5 : 0.12);
        const bh = Math.max(1.5, level[i] * (h - 2));
        const x = i * bw + bw * 0.2;
        const grad = ctx.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, 'rgba(91,140,255,0.85)');
        grad.addColorStop(1, 'rgba(200,180,255,0.95)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, h - bh, bw * 0.6, bh, 1.5);
        ctx.fill();
      }
      raf = reduced && !active ? 0 : requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={ref} className="spectrum" aria-hidden />;
}

export function PlayerBar({ plan }: { plan: MixPlan }) {
  const ps = usePlayer(8);
  const covers = useStore((s) => s.covers);
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const fill = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrub = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const D = Math.max(plan.voices.length ? 1 : 0, ps.auditioning ? player().duration : plan.duration);

  useEffect(() => { player().setVolume(muted ? 0 : volume * volume); }, [volume, muted]);

  usePlayhead(useCallback((pos: number) => {
    const p = dragging ?? pos;
    const pct = `${D > 0 ? Math.min(100, (p / D) * 100) : 0}%`;
    if (fill.current) fill.current.style.width = pct;
    if (knob.current) knob.current.style.left = pct;
    if (timeRef.current) timeRef.current.textContent = fmtTime(p);
  }, [D, dragging]));

  const pos = ps.position;
  const current = plan.voices.filter((v) => pos >= v.start && pos < v.end);
  const now = current[current.length - 1];
  const inTransition = plan.transitions.find((t) => pos >= t.start && pos < t.end);

  const seekFrom = (clientX: number) => {
    const r = scrub.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, ((clientX - r.left) / r.width) * D));
  };
  const jump = (dir: 1 | -1) => {
    const ts = plan.transitions.map((t) => Math.max(0, t.start - 4));
    const target = dir > 0 ? ts.find((t) => t > pos + 0.5) : [...ts].reverse().find((t) => t < pos - 1.5);
    void player().seek(target ?? (dir > 0 ? pos : 0));
  };
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <footer className="player glass glass-thick" aria-label="Lecteur">
      <div className="player-now">
        {now ? (
          <>
            <Cover url={covers[now.trackId]} title={now.title} size={44} radius={10} />
            <div className="now-text">
              <span className="now-title">{now.title}</span>
              <span className="now-sub">
                {ps.auditioning ? <><Headphones size={11} /> Écoute d’une transition</> : inTransition ? <span className="tone-accent">Transition {inTransition.index + 1} en cours</span> : now.artist}
              </span>
            </div>
          </>
        ) : (
          <div className="now-text"><span className="now-title tone-dim">{plan.voices.length ? 'Prêt à lire' : 'Aucune mixtape'}</span><span className="now-sub">{plan.voices.length ? `${plan.voices.length} morceaux · ${fmtTime(plan.duration)}` : 'Ajoutez des morceaux à la playlist'}</span></div>
        )}
      </div>

      <div className="player-center">
        <div className="transport">
          <IconButton label="Transition précédente" onClick={() => jump(-1)} disabled={!plan.voices.length}><SkipBack size={16} /></IconButton>
          <button className={`play-btn ${ps.playing ? 'is-playing' : ''}`} onClick={() => player().toggle()} disabled={!plan.voices.length} aria-label={ps.playing ? 'Pause' : 'Lecture'} data-testid="play-button">
            {ps.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />}
          </button>
          <IconButton label="Transition suivante" onClick={() => jump(1)} disabled={!plan.voices.length}><SkipForward size={16} /></IconButton>
        </div>
        <div className="scrub-row">
          <span ref={timeRef} className="time num" data-testid="player-time">{fmtTime(pos)}</span>
          <div
            ref={scrub}
            className="scrub"
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setDragging(seekFrom(e.clientX)); }}
            onPointerMove={(e) => { if (dragging !== null) setDragging(seekFrom(e.clientX)); }}
            onPointerUp={(e) => { if (dragging !== null) { void player().seek(seekFrom(e.clientX)); setDragging(null); } }}
            role="slider"
            aria-label="Position dans la mixtape"
            aria-valuemin={0}
            aria-valuemax={D}
            aria-valuenow={pos}
          >
            <div className="scrub-track">
              {!ps.auditioning && plan.transitions.map((t) => (
                <span key={t.fromEntryId} className={`scrub-mark sev-${t.severity}`} style={{ left: `${(t.start / D) * 100}%`, width: `${Math.max(0.4, (t.duration / D) * 100)}%` }} />
              ))}
              <div ref={fill} className="scrub-fill" />
            </div>
            <div ref={knob} className="scrub-knob" />
          </div>
          <span className="time num tone-dim">{fmtTime(D)}</span>
        </div>
      </div>

      <div className="player-right">
        <Spectrum active={ps.playing} />
        <div className="volume">
          <IconButton label={muted ? 'Réactiver le son' : 'Couper le son'} size="sm" onClick={() => setMuted(!muted)}><VolIcon size={15} /></IconButton>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => { setMuted(false); setVolume(parseFloat(e.target.value)); }} aria-label="Volume" style={{ '--pct': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} />
        </div>
      </div>
      {ps.error && <div className="player-error">{ps.error}</div>}
    </footer>
  );
}
