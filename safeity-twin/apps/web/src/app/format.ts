export const fmtTime = (s: number) => {
  const neg = s < 0;
  s = Math.abs(Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return (neg ? '-' : '') + body;
};
export const fmtEta = (s: number) => (s <= 0 ? 'now' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-IN');
export const title = (s: string) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
