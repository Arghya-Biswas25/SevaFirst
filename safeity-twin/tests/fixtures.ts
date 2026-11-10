import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteDataset } from '@twin/twin-schema';

const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../data/sites/safeity-digital');
const j = (f: string) => JSON.parse(readFileSync(resolve(dir, f), 'utf8'));

export function loadDataset(): SiteDataset {
  return {
    site: j('site.json'),
    typologies: j('typologies.json'),
    buildings: j('buildings.json'),
    streets: j('streets.geojson'),
    amenities: j('amenities.json'),
    resources: j('resources.json'),
    occupancy: j('occupancy.json'),
    rules: j('rules/nbc-2016-part4.json'),
  };
}
