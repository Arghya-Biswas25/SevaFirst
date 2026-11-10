import { useMemo, useState } from 'react';
import { Button, Chip, FloatingWindow, Icon, Section, Toggle } from '@twin/ui-kit';
import { defaultParams, type ParamField } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';
import type { PickResult } from '@twin/render';
import { ds, hazards, HAZARD_ICONS, OCCUPANCY, twin } from '../app/core';
import { fmtTime } from '../app/format';

export interface RunSettings {
  occupancy: string;
  seed: number;
  launchedOnly: boolean;
  disabled: string[];
  windSpeed: number;
  windFrom: number;
}

type Values = Record<string, number | string | boolean>;

function ParamForm({ fields, values, onChange }: { fields: ParamField[]; values: Values; onChange: (k: string, v: number | string | boolean) => void }) {
  if (!fields.length) return <p className="muted">No parameters.</p>;
  return (
    <div className="form">
      {fields.map((f) => (
        <label key={f.key} className={`field field-${f.type}`}>
          {f.type === 'boolean' ? (
            <Toggle checked={Boolean(values[f.key])} onChange={(v) => onChange(f.key, v)} label={f.label} hint={f.help} />
          ) : (
            <>
              <span className="field-label">{f.label}{f.unit && <em> ({f.unit})</em>}</span>
              {f.type === 'select' ? (
                <select value={String(values[f.key])} onChange={(e) => onChange(f.key, e.target.value)}>
                  {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <div className="num">
                  <input type="range" min={f.min} max={f.max} step={f.step} value={Number(values[f.key])} onChange={(e) => onChange(f.key, Number(e.target.value))} />
                  <input type="number" min={f.min} max={f.max} step={f.step} value={Number(values[f.key])} onChange={(e) => onChange(f.key, Number(e.target.value))} />
                </div>
              )}
              {f.help && <span className="field-help">{f.help}</span>}
            </>
          )}
        </label>
      ))}
    </div>
  );
}

interface Props {
  hazardId: string;
  origin: PickResult;
  x: number;
  y: number;
  running: boolean;
  simT: number;
  draft: HazardSpec[];
  settings: RunSettings;
  onHazard: (id: string) => void;
  onAdd: (spec: HazardSpec) => void;
  onRun: (spec: HazardSpec | null) => void;
  onInject: (spec: HazardSpec) => void;
  onRemoveDraft: (i: number) => void;
  onSettings: (s: RunSettings) => void;
  onClose: () => void;
}

/** The simulation window opened from the right-click menu. Forms are generated from plugin params. */
export function SimWindow(props: Props) {
  const { hazardId, origin, running, draft, settings } = props;
  const plugin = hazards.get(hazardId)!;
  const [values, setValues] = useState<Record<string, Values>>({});
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const v = values[hazardId] ?? defaultParams(plugin);
  const set = (k: string, val: number | string | boolean) => setValues({ ...values, [hazardId]: { ...v, [k]: val } });
  const options = hazards.list().filter((h) => h.enabled && h.targets.includes(origin.kind));
  const wing = origin.wing !== undefined ? twin.wings[origin.wing] : undefined;
  const spec = (t: number): HazardSpec => ({ type: hazardId, params: { ...v }, origin: { kind: origin.kind, E: origin.E, N: origin.N, up: origin.up, buildingId: origin.buildingId, storey: origin.storey, spaceId: origin.spaceId, label: origin.label }, t });
  const units = useMemo(() => ds.resources.resources, []);
  const persons = settings.launchedOnly ? twin.flats.filter((f) => twin.wings[f.wing].status === 'launched').length : twin.flats.length;

  return (
    <FloatingWindow
      title={<>New {plugin.label.toLowerCase()}</>}
      icon={HAZARD_ICONS[hazardId]}
      x={props.x}
      y={props.y}
      width={430}
      onClose={props.onClose}
      footer={running ? (
        <>
          <Button onClick={() => props.onAdd(spec(offset))} icon="plus">Save for next run</Button>
          <Button kind="primary" icon="play" onClick={() => props.onInject(spec(props.simT))}>Start it now</Button>
        </>
      ) : (
        <>
          <Button onClick={() => props.onAdd(spec(offset))} icon="plus">Add to setup</Button>
          <Button kind="primary" icon="play" onClick={() => props.onRun(spec(offset))}>Start{draft.length ? ` (${draft.length + 1} incidents)` : ''}</Button>
        </>
      )}
    >
      <div className="hz-tabs">
        {options.map((h) => (
          <button key={h.id} className={h.id === hazardId ? 'on' : ''} onClick={() => props.onHazard(h.id)}>
            <Icon name={HAZARD_ICONS[h.id] ?? 'hazard'} className={`hz-${h.id}`} />
            <span>{h.label.replace(' failure', '')}</span>
          </button>
        ))}
      </div>
      <p className="muted small">{plugin.description}</p>
      <div className="origin">
        <Icon name="target" />
        <div>
          <div className="origin-label">{origin.label}</div>
          <div className="muted small">
            {wing ? `${wing.typology.name}, ${wing.storeys === 8 ? 'ground + 7' : 'ground + 5'} floors` : 'Open ground'}
          </div>
          <div className="muted small">Right-click somewhere else to move it.</div>
        </div>
      </div>
      <ParamForm fields={plugin.params.slice(0, 3)} values={v} onChange={set} />
      {plugin.params.length > 3 && (
        <>
          <button className="link" onClick={() => setMore(!more)}>{more ? 'Fewer options' : `More options (${plugin.params.length - 3})`}</button>
          {more && <ParamForm fields={plugin.params.slice(3)} values={v} onChange={set} />}
        </>
      )}
      {!running && (
        <label className="field">
          <span className="field-label">Start after <em>(seconds)</em></span>
          <div className="num">
            <input type="range" min={0} max={1800} step={30} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
            <input type="number" min={0} max={7200} step={30} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
          </div>
        </label>
      )}
      {draft.length > 0 && (
        <Section title={`Already in your setup (${draft.length})`}>
          <ul className="draft">
            {draft.map((d, i) => (
              <li key={i}>
                <Icon name={HAZARD_ICONS[d.type] ?? 'hazard'} className={`hz-${d.type}`} />
                <span>{hazards.get(d.type)?.label} · {d.origin.label ?? `${d.origin.E.toFixed(0)}, ${d.origin.N.toFixed(0)}`}</span>
                {d.t > 0 && <Chip tone="muted">after {fmtTime(d.t)}</Chip>}
                <button className="uk-x" onClick={() => props.onRemoveDraft(i)} aria-label="Remove"><Icon name="close" size={12} /></button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Settings" defaultOpen={false} right={<span className="muted small">{OCCUPANCY.find((o) => o.id === settings.occupancy)?.label}</span>}>
        <div className="form">
          <label className="field">
            <span className="field-label">When it happens</span>
            <select value={settings.occupancy} onChange={(e) => props.onSettings({ ...settings, occupancy: e.target.value })}>
              {OCCUPANCY.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <Toggle checked={settings.launchedOnly} onChange={(b) => props.onSettings({ ...settings, launchedOnly: b })} label={`Only buildings that are built (${persons.toLocaleString('en-IN')} flats)`} hint="Planned buildings are taken from the master plan. Turn this on to include only the ones standing today." />
          <div className="field">
            <span className="field-label">Crews available</span>
            <div className="units">
              {units.map((u) => (
                <Toggle key={u.id} checked={!settings.disabled.includes(u.id)} label={<>{u.name.replace(/\s*\(.*\)\s*$/, '')} <em className="muted">{u.onSite ? 'on site' : `${Math.round(u.eta_s / 60)} min away`}</em></>}
                  onChange={(on) => props.onSettings({ ...settings, disabled: on ? settings.disabled.filter((x) => x !== u.id) : [...settings.disabled, u.id] })} />
              ))}
            </div>
          </div>
          <label className="field">
            <span className="field-label">Wind <em>(speed in m/s, blowing from °)</em></span>
            <div className="num two">
              <input type="number" min={0} max={60} step={1} value={settings.windSpeed} onChange={(e) => props.onSettings({ ...settings, windSpeed: Number(e.target.value) })} />
              <input type="number" min={0} max={359} step={5} value={settings.windFrom} onChange={(e) => props.onSettings({ ...settings, windFrom: Number(e.target.value) })} />
            </div>
          </label>
          <label className="field">
            <span className="field-label">Random seed <em>(same number, same run)</em></span>
            <input type="number" value={settings.seed} onChange={(e) => props.onSettings({ ...settings, seed: Number(e.target.value) })} />
          </label>
        </div>
      </Section>
    </FloatingWindow>
  );
}
