/**
 * @twin/ui-kit — small, dependency-free React primitives shared by every panel.
 * Styling lives in the app stylesheet under the `uk-` prefix.
 */
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';

const PATHS: Record<string, string> = {
  fire: 'M12 2c1 3.5-1.6 5.2-1.6 8 0 1.4.9 2.4 2 2.4 1.7 0 2.4-1.6 2-3.6 2.4 1.6 3.6 4.1 3.6 6.4A6 6 0 0 1 6 15.2c0-3.4 2.3-5.5 3.5-7.4C10.8 5.9 11.6 4 12 2z',
  collapse: 'M3 21h18M5 21V9l4-3v15M9 21V12l5 2v7M14 21v-4l5-6v10M16 4l2 2M19 3l-1 3M13 5l2-1',
  earthquake: 'M2 12h3l2-5 3 10 3-14 3 12 2-5 2 2h2',
  power: 'M13 2 4 14h7l-1 8 9-12h-7z',
  flood: 'M3 15c2 0 2-1.5 4.5-1.5S10 15 12 15s2-1.5 4.5-1.5S19 15 21 15M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2-1.5 4.5-1.5S19 19 21 19M12 3s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7z',
  cyclone: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 9c2-4 7-6 12-4M20 15c-2 4-7 6-12 4M8 4C4 7 3 12 5 16M16 20c4-3 5-8 3-12',
  gas: 'M8 21h8M12 17v4M7 10a5 5 0 0 0 10 0c0-3-2-4-2-7-1.5 1-3 2.5-3 4-1-1-1.5-2-1.5-3C8.5 5.5 7 7.5 7 10z',
  medical: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
  hazard: 'M12 3 2 20h20L12 3zM12 9v5M12 17v.5',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h4v16H7zM14 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  orbit: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5S3 14.5 3 12z',
  fly: 'M2 16l20-8-8 12-2-5-5-1z',
  walk: 'M13 4a2 2 0 1 0 0-.01M10 22l2-7 3 3v4M9 12l2-4 4 1 2 4M11 8 8 9l-1 4',
  xray: 'M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M8 8h8v8H8z',
  layers: 'M12 3 2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
  building: 'M4 21V5l8-3v19M12 21V8l8 3v10M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M2 21h20',
  search: 'M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M16 16l5 5',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  target: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v4M12 18v4M2 12h4M18 12h4',
  truck: 'M2 7h11v9H2zM13 10h4l3 3v3h-7zM6 18.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M17 18.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  people: 'M9 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 21v-2a5 5 0 0 1 10 0v2M17 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M15 21v-2a4 4 0 0 1 6-3.4',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  log: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  info: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v6M12 7.5v.5',
  home: 'M3 11 12 3l9 8M5 9.5V21h14V9.5',
  plan: 'M4 4h16v16H4zM4 10h7v10M11 4v6M15 10h5M15 10v10',
  scissors: 'M6 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M6 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8.5 8.5 20 20M8.5 15.5 20 4',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  check: 'M5 12.5l4.5 4.5L19 7',
  route: 'M5 19h4a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h4M17 2l3 3-3 3M5 17a2 2 0 1 0 0 4 2 2 0 1 0 0-4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  clock: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2',
  stairs: 'M3 20h5v-4h4v-4h4V8h5',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  minus: 'M6 12h12',
  checklist: 'M9 6h11M9 12h11M9 18h11M4 5.5l1 1 2-2M4 11.5l1 1 2-2M4 17.5l1 1 2-2',
  ladder: 'M7 3v18M17 3v18M7 7.5h10M7 12h10M7 16.5h10',
  lift: 'M5 3h14v18H5zM12 3v18M7.5 10l1.5-2 1.5 2M13.5 14l1.5 2 1.5-2',
  swap: 'M7 7h12l-3-3M17 17H5l3 3',
  exit: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
};

export function Icon({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  const d = PATHS[name] ?? PATHS.hazard;
  const filled = name === 'fire' || name === 'power' || name === 'play' || name === 'pause' || name === 'stop' || name === 'fly' || name === 'medical';
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function Button(props: { children?: ReactNode; onClick?: () => void; kind?: 'primary' | 'danger' | 'ghost' | 'default'; icon?: string; disabled?: boolean; title?: string; active?: boolean; small?: boolean }) {
  const { kind = 'default', icon, children, small, active, ...rest } = props;
  return (
    <button type="button" className={`uk-btn uk-${kind}${small ? ' uk-small' : ''}${active ? ' uk-active' : ''}`} {...rest}>
      {icon && <Icon name={icon} size={small ? 13 : 15} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size }: { value: T; options: { value: T; label: string; icon?: string; title?: string }[]; onChange: (v: T) => void; size?: 'sm' }) {
  return (
    <div className={`uk-seg${size === 'sm' ? ' uk-seg-sm' : ''}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: string }) {
  return (
    <label className="uk-toggle" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="uk-switch" />
      <span className="uk-toggle-label">{label}</span>
    </label>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { id: T; label: string; icon?: string; badge?: number | string }[]; onChange: (v: T) => void }) {
  return (
    <div className="uk-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} size={14} />}
          <span>{t.label}</span>
          {t.badge !== undefined && t.badge !== 0 && <em className="uk-badge">{t.badge}</em>}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, right, defaultOpen = true }: { title: ReactNode; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`uk-section${open ? '' : ' closed'}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="uk-caret">{open ? '▾' : '▸'}</span>
        <h3>{title}</h3>
        {right && <div className="uk-section-right" onClick={(e) => e.stopPropagation()}>{right}</div>}
      </header>
      {open && <div className="uk-section-body">{children}</div>}
    </section>
  );
}

export function Kpi({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted'; sub?: ReactNode }) {
  return (
    <div className={`uk-kpi${tone ? ` uk-${tone}` : ''}`}>
      <div className="uk-kpi-v">{value}</div>
      <div className="uk-kpi-l">{label}</div>
      {sub && <div className="uk-kpi-s">{sub}</div>}
    </div>
  );
}

export function Bar({ value, max, tone, label }: { value: number; max: number; tone?: 'good' | 'warn' | 'bad' | 'info'; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const auto = tone ?? (pct > 95 ? 'bad' : pct > 75 ? 'warn' : 'good');
  return (
    <div className="uk-bar" title={`${value} / ${max}`}>
      <div className={`uk-bar-fill uk-${auto}`} style={{ width: `${pct}%` }} />
      {label && <span className="uk-bar-label">{label}</span>}
    </div>
  );
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`uk-chip${tone ? ` uk-${tone}` : ''}`}>{children}</span>;
}

/** A floating window that can be dragged by its title bar. */
export function FloatingWindow({ title, icon, x, y, width = 420, onClose, children, footer }: { title: ReactNode; icon?: string; x: number; y: number; width?: number; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const [pos, setPos] = useState({ x, y });
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setPos({ x, y }), [x, y]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      setPos({ x: Math.max(4, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx)), y: Math.max(4, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)) });
    };
    const up = () => (drag.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);
  // keep the window on screen
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(pos.x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(pos.y, window.innerHeight - r.height - 8));
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [pos.x, pos.y]);
  return (
    <div className="uk-window" ref={ref} style={{ left: pos.x, top: pos.y, width }} onContextMenu={(e) => e.preventDefault()}>
      <header onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      }}>
        {icon && <Icon name={icon} size={16} />}
        <h2>{title}</h2>
        <button type="button" className="uk-x" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
      </header>
      <div className="uk-window-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </div>
  );
}

export function Empty({ children, icon = 'info' }: { children: ReactNode; icon?: string }) {
  return (
    <div className="uk-empty">
      <Icon name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}
