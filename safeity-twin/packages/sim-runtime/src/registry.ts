/**
 * The hazard registry. Adding a hazard = implement HazardPlugin in its own package
 * under packages/hazards/<id> and register it here (one line). The right-click menu
 * and the simulation window read this list; nothing else changes.
 */
import { HazardRegistry, plannedHazard } from '@twin/hazard-sdk';
import { firePlugin } from '@twin/hazard-fire';
import { collapsePlugin } from '@twin/hazard-collapse';
import { earthquakePlugin } from '@twin/hazard-earthquake';
import { powerPlugin } from '@twin/hazard-power';

export const hazards = new HazardRegistry();
hazards.register(firePlugin);
hazards.register(collapsePlugin);
hazards.register(earthquakePlugin);
hazards.register(powerPlugin);
// roadmap entries (PRD Section 8) — visible but disabled until their plugin ships
hazards.register(plannedHazard('flood', 'Flood and waterlogging', 'v1', 'Needs the site DEM and drain survey'));
hazards.register(plannedHazard('cyclone', 'Cyclone and high wind', 'v1', 'IMD category wind field, tree fall, glazing'));
hazards.register(plannedHazard('gas', 'Gas leak and explosion', 'v1', 'Dispersion and ignition; explosion uses the collapse plugin today'));
hazards.register(plannedHazard('medical', 'Medical and mass casualty', 'v1', 'START triage at The Blu and assembly points'));
hazards.register(plannedHazard('lightning', 'Lightning', 'v1.1', 'Strike probability and protection coverage'));
hazards.register(plannedHazard('heatwave', 'Heatwave', 'v1.1', 'Heat index and vulnerable occupants'));
hazards.register(plannedHazard('chemical', 'Pool chemical release', 'v1.1', 'Chlorine store at The Blu plant room'));
hazards.register(plannedHazard('drowning', 'Drowning and water rescue', 'v1.1', 'Lifeguard response at the lagoon'));
hazards.register(plannedHazard('crowd', 'Crowd crush', 'v1.1', 'Density levels of service at events'));
