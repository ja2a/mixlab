// Preview player: streams blocks rendered by the main-process mix engine (same code as export)
// and schedules them back-to-back on the Web Audio clock, sample-accurately.

import type { MixPlan } from '../../core/mix/plan';

const SR = 44100;
const CHUNK = 16384; // ~0.37 s
const AHEAD = 1.4; // seconds scheduled in advance

type Listener = () => void;

export class PreviewPlayer {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private gain: GainNode;
  private plan: MixPlan | null = null;
  private basePlan: MixPlan | null = null;
  /** Label of a temporary plan being auditioned (e.g. a transition proposal). */
  auditioning: string | null = null;
  private session = 0;
  private sessionId = 0;
  private startFrame = 0; // mix frame at ctxStart
  private ctxStart = 0;
  private nextFrame = 0; // next mix frame to request
  private endFrame = Infinity;
  private fetching = false;
  private sources: AudioBufferSourceNode[] = [];
  private timer: number | null = null;
  private listeners = new Set<Listener>();
  private pausedAt: number | null = null;
  private staleWhilePaused = false;
  playing = false;
  error: string | null = null;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit() { for (const l of this.listeners) l(); }

  get duration(): number { return this.plan?.duration ?? 0; }

  /** Current mix position in seconds. */
  get position(): number {
    if (this.pausedAt !== null) return this.pausedAt / SR;
    if (!this.playing) return this.startFrame / SR;
    const f = this.startFrame + Math.max(0, this.ctx.currentTime - this.ctxStart) * SR;
    return Math.min(f, this.endFrame, this.plan?.totalFrames ?? f) / SR;
  }

  setVolume(v: number) { this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /** Replace the plan. While playing, playback restarts seamlessly-ish at the current position. */
  setPlan(plan: MixPlan) {
    this.basePlan = plan;
    if (this.auditioning) return;
    const changed = this.plan !== plan;
    this.plan = plan;
    if (!changed) return;
    if (this.playing && this.pausedAt === null) void this.start(Math.round(this.position * SR), this.endFrame);
    else if (this.pausedAt !== null) this.staleWhilePaused = true;
    else this.startFrame = Math.min(this.startFrame, plan.totalFrames);
    this.emit();
  }

  /** Play a range of a temporary plan, then return to the main plan. */
  async audition(plan: MixPlan, label: string, fromSeconds: number, toSeconds: number) {
    this.auditioning = label;
    this.plan = plan;
    await this.start(Math.round(Math.max(0, fromSeconds) * SR), Math.round(toSeconds * SR));
  }

  private endAudition() {
    if (!this.auditioning) return;
    this.auditioning = null;
    this.plan = this.basePlan;
  }

  async play(fromSeconds?: number, toSeconds?: number) {
    if (this.auditioning && fromSeconds === undefined && this.pausedAt === null) this.endAudition();
    if (!this.plan || !this.plan.totalFrames) return;
    if (this.ctx.state === 'suspended' && this.pausedAt !== null && fromSeconds === undefined && !this.staleWhilePaused) {
      this.pausedAt = null;
      await this.ctx.resume();
      this.emit();
      return;
    }
    const from = fromSeconds ?? (this.pausedAt !== null ? this.pausedAt / SR : this.startFrame >= this.plan.totalFrames ? 0 : this.startFrame / SR);
    await this.start(Math.round(from * SR), toSeconds !== undefined ? Math.round(toSeconds * SR) : Infinity);
  }

  pause() {
    if (!this.playing || this.pausedAt !== null) return;
    this.pausedAt = Math.round(this.position * SR);
    void this.ctx.suspend();
    this.emit();
  }

  get paused() { return this.pausedAt !== null; }
  get isActive() { return this.playing && this.pausedAt === null; }

  toggle() {
    if (this.isActive) this.pause();
    else void this.play();
  }

  async seek(seconds: number) {
    const f = Math.max(0, Math.round(seconds * SR));
    if (this.isActive) await this.start(f, this.endFrame);
    else {
      this.stopSources();
      await this.closeSession();
      this.playing = false;
      this.pausedAt = null;
      this.startFrame = f;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.emit();
    }
  }

  async stop() {
    this.endAudition();
    this.stopSources();
    await this.closeSession();
    this.playing = false;
    this.pausedAt = null;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.emit();
  }

  private stopSources() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.sources = [];
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private async closeSession() {
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = 0;
      await window.mixlab.previewStop(id).catch(() => {});
    }
  }

  private async start(frame: number, end: number) {
    const plan = this.plan!;
    const mySession = ++this.session;
    this.stopSources();
    this.pausedAt = null;
    this.staleWhilePaused = false;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.error = null;
    try {
      const id = await window.mixlab.previewStart(plan, frame);
      if (mySession !== this.session) { void window.mixlab.previewStop(id); return; }
      this.sessionId = id;
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      this.playing = false;
      this.emit();
      return;
    }
    this.startFrame = frame;
    this.nextFrame = frame;
    this.endFrame = Math.min(end, plan.totalFrames);
    this.ctxStart = this.ctx.currentTime + 0.12;
    this.playing = true;
    this.fetching = false;
    this.emit();
    this.timer = window.setInterval(() => this.tick(mySession), 60);
    this.tick(mySession);
  }

  private async tick(mySession: number) {
    if (mySession !== this.session || this.fetching || !this.playing) return;
    const scheduledUntil = this.ctxStart + (this.nextFrame - this.startFrame) / SR;
    if (this.nextFrame >= this.endFrame) {
      if (this.ctx.currentTime >= scheduledUntil) {
        this.stopSources();
        await this.closeSession();
        this.playing = false;
        this.startFrame = this.endFrame >= (this.plan?.totalFrames ?? 0) ? 0 : this.endFrame;
        if (this.auditioning) { this.endAudition(); this.startFrame = 0; }
        this.emit();
      }
      return;
    }
    if (scheduledUntil - this.ctx.currentTime > AHEAD) return;
    this.fetching = true;
    const n = Math.min(CHUNK, this.endFrame - this.nextFrame);
    try {
      const data = await window.mixlab.previewChunk(this.sessionId, n);
      if (mySession !== this.session || !data) return;
      const buf = this.ctx.createBuffer(2, n, SR);
      buf.copyToChannel(new Float32Array(data.left), 0);
      buf.copyToChannel(new Float32Array(data.right), 1);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      let when = this.ctxStart + (this.nextFrame - this.startFrame) / SR;
      if (when < this.ctx.currentTime) {
        // Underrun: shift the timeline instead of dropping audio.
        const late = this.ctx.currentTime + 0.05 - when;
        this.ctxStart += late;
        when += late;
      }
      src.start(when);
      src.onended = () => { this.sources = this.sources.filter((s) => s !== src); };
      this.sources.push(src);
      this.nextFrame += n;
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      this.emit();
    } finally {
      this.fetching = false;
    }
  }
}

let instance: PreviewPlayer | null = null;
export function player(): PreviewPlayer {
  if (!instance) instance = new PreviewPlayer();
  return instance;
}
