// Liquid Glass component library. All visuals come from tokens.css / app.css.

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Variant = 'glass' | 'primary' | 'ghost' | 'danger' | 'plain';

export function Button({
  variant = 'glass', size = 'md', icon, children, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon && <span className="btn-icon">{icon}</span>}
      {children && <span className="btn-label">{children}</span>}
    </button>
  );
}

export function IconButton({
  label, children, active, size = 'md', className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Tooltip text={label}>
      <button aria-label={label} className={`icon-btn icon-btn-${size} ${active ? 'is-active' : ''} ${className}`} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}

export function Tooltip({ text, children, side = 'top' }: { text: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>(0);
  const show = () => {
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top : r.bottom });
    }, 450);
  };
  const hide = () => { clearTimeout(timer.current); setPos(null); };
  return (
    <span ref={ref} className="tooltip-anchor" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos && createPortal(<div className={`tooltip tooltip-${side}`} style={{ left: pos.x, top: pos.y }}>{text}</div>, document.body)}
    </span>
  );
}

export function Segmented<T extends string | number>({
  value, options, onChange, size = 'md', ariaLabel,
}: { value: T; options: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>; onChange: (v: T) => void; size?: 'sm' | 'md'; ariaLabel?: string }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={ariaLabel} style={{ '--n': options.length, '--i': idx } as CSSProperties}>
      <span className="segmented-thumb" aria-hidden />
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          disabled={o.disabled}
          className={`segmented-item ${o.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value, min, max, step = 0.01, onChange, onCommit, format, label, accent, disabled,
}: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; format?: (v: number) => string; label?: string; accent?: string; disabled?: boolean }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={`slider ${disabled ? 'is-disabled' : ''}`}>
      {label && (
        <span className="slider-head">
          <span className="slider-label">{label}</span>
          <span className="slider-value">{format ? format(value) : value}</span>
        </span>
      )}
      <span className="slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onPointerUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
          style={{ '--pct': `${pct}%`, '--slider-accent': accent ?? 'var(--accent)' } as CSSProperties}
        />
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <button role="switch" aria-checked={checked} className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="toggle-knob" />
      </button>
    </label>
  );
}

export function Chip({ children, tone = 'neutral', style, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'problem' | 'violet'; style?: CSSProperties; title?: string }) {
  return <span className={`chip chip-${tone}`} style={style} title={title}>{children}</span>;
}

export function ProgressRing({ value, size = 18, stroke = 2.25, indeterminate }: { value: number; size?: number; stroke?: number; indeterminate?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${indeterminate ? 'is-spinning' : ''}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="ring-value"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={indeterminate ? c * 0.72 : c * (1 - Math.max(0, Math.min(1, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Circular score gauge 0..1 with a centred label. */
export function ScoreGauge({ value, size = 44, label }: { value: number; size?: number; label?: string }) {
  const tone = value >= 0.72 ? 'var(--ok)' : value >= 0.5 ? 'var(--accent-strong)' : value >= 0.35 ? 'var(--warn)' : 'var(--problem)';
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-3)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset var(--dur-3) var(--ease-out)' }} />
      </svg>
      <span className="gauge-label">{label ?? Math.round(value * 100)}</span>
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 720, dismissable = true }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; dismissable?: boolean;
}) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => { if (dismissable && e.target === e.currentTarget) onClose(); }}>
      <div className="modal glass glass-thick" style={{ width }} role="dialog" aria-modal>
        <header className="modal-head">
          <div>
            <h2 className="modal-title">{title}</h2>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          {dismissable && <IconButton label="Fermer" onClick={onClose} size="sm"><X size={15} /></IconButton>}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', onClose); };
  }, [x, y, onClose]);
  return createPortal(
    <div ref={ref} className="menu glass glass-thick" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) =>
        it.separator ? <div key={i} className="menu-sep" /> : (
          <button key={i} role="menuitem" disabled={it.disabled} className={`menu-item ${it.danger ? 'is-danger' : ''}`} onClick={() => { it.onClick?.(); onClose(); }}>
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent, items: MenuItem[]) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items }); };
  const node = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, node };
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Stepper({ value, options, onChange, format }: { value: number; options: number[]; onChange: (v: number) => void; format?: (v: number) => string }) {
  const i = options.indexOf(value);
  const idx = i < 0 ? options.findIndex((o) => o >= value) : i;
  return (
    <div className="stepper">
      <button className="stepper-btn" disabled={idx <= 0} onClick={() => onChange(options[Math.max(0, idx - 1)])} aria-label="Diminuer">−</button>
      <span className="stepper-value">{format ? format(value) : value}</span>
      <button className="stepper-btn" disabled={idx >= options.length - 1} onClick={() => onChange(options[Math.min(options.length - 1, idx + 1)])} aria-label="Augmenter">+</button>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3 className="empty-title">{title}</h3>
      {children && <p className="empty-text">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
