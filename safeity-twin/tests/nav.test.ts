import { describe, expect, it } from 'vitest';
import { buildTwin } from '@twin/twin-data';
import { astar, buildNavGraph } from '@twin/nav';
import { loadDataset } from './fixtures';

const twin = buildTwin(loadDataset());
const g = buildNavGraph(twin);
const walk = (e: { len: number; kind: string }) => (e.kind === 'lift' ? Infinity : e.len / (e.kind === 'stair' ? 0.65 : 1.2));
const isAssembly = (n: number) => g.nodes[n].kind === 'assembly';

describe('navigation graph', () => {
  it('connects every flat to an assembly point without lifts', () => {
    const unreachable: string[] = [];
    for (const f of twin.flats) {
      const start = g.flatNode[f.id];
      const p = astar(g, start, isAssembly, walk);
      if (!p) unreachable.push(f.key);
    }
    expect(unreachable.slice(0, 10)).toEqual([]);
  });

  it('routes a top-floor R13 flat down a stair and out within a plausible time', () => {
    const fid = twin.flatByKey.get('R13/504')!;
    const p = astar(g, g.flatNode[fid], isAssembly, walk)!;
    const kinds = p.edges.map((e) => g.edges[e].kind);
    expect(kinds.filter((k) => k === 'stair').length).toBe(5);
    expect(p.cost).toBeGreaterThan(60);
    expect(p.cost).toBeLessThan(900);
  });

  it('lets vehicles reach every wing exit area from the site entry', () => {
    const entry = g.gates.get('ENTRY-SW')!;
    const vehicle = (e: { vehicles: boolean; len: number; kind: string }) => (e.kind === 'road' || e.kind === 'link') && (e.vehicles || e.kind === 'link') ? e.len / 5.5 : Infinity;
    const p = astar(g, entry, (n) => g.nodes[n].kind === 'assembly' && g.nodes[n].ref === 'AP-E', vehicle);
    expect(p).not.toBeNull();
  });
});
