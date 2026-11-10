/**
 * The site dataset, bundled at build time. Swapping in an L2 (sanctioned CAD) or
 * L3 (as-built) dataset means replacing these files; nothing else changes.
 */
import type { SiteDataset } from '@twin/twin-schema';
import site from '../../../data/sites/safeity-digital/site.json?raw';
import typologies from '../../../data/sites/safeity-digital/typologies.json?raw';
import buildings from '../../../data/sites/safeity-digital/buildings.json?raw';
import streets from '../../../data/sites/safeity-digital/streets.geojson?raw';
import amenities from '../../../data/sites/safeity-digital/amenities.json?raw';
import resources from '../../../data/sites/safeity-digital/resources.json?raw';
import occupancy from '../../../data/sites/safeity-digital/occupancy.json?raw';
import rules from '../../../data/sites/safeity-digital/rules/nbc-2016-part4.json?raw';

export function loadDataset(): SiteDataset {
  return {
    site: JSON.parse(site),
    typologies: JSON.parse(typologies),
    buildings: JSON.parse(buildings),
    streets: JSON.parse(streets),
    amenities: JSON.parse(amenities),
    resources: JSON.parse(resources),
    occupancy: JSON.parse(occupancy),
    rules: JSON.parse(rules),
  };
}
