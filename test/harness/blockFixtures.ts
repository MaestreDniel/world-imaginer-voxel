/**
 * The fixture block registry (SP3a spec §2.4): tests only, never locked. One type per property kind, a type with two
 * properties whose defaults are not the first kind values (`pillar`: axis default y, half default top), and a door
 * with the four properties of the §2.3 key example. Some table values are functions of the state's properties.
 */
import type { BlockDef, PropertyDef, StateTables } from '../../src/world/blocks/registry';
import type { PropertyKind } from '../../src/world/blocks/kinds';

const prop = (name: string, kind: PropertyKind, def: string): PropertyDef => ({ name, kind, default: def });

export const AIR_TABLES: StateTables = {
  opacity: 0, pass: 'none', shape: 'none', fullFaces: 0, emit: 0, carvable: false, replaceable: true,
  collide: 'none', fluidMode: 'displace', tint: 'none', sound: 'none', faceTex: 0,
};

export const SOLID_TABLES: StateTables = {
  opacity: 15, pass: 'opaque', shape: 'cube', fullFaces: 63, emit: 0, carvable: true, replaceable: false,
  collide: 'cube', fluidMode: 'block', tint: 'none', sound: 'stone', faceTex: 0,
};

export const FIXTURE_DEFS: readonly BlockDef[] = [
  { name: 'air', props: [], ...AIR_TABLES },
  { name: 'log', props: [prop('axis', 'axis', 'y')], ...SOLID_TABLES, sound: 'wood' },
  { name: 'chest', props: [prop('facing', 'facing4', 'north')], ...SOLID_TABLES, sound: 'wood' },
  {
    name: 'piston', props: [prop('facing', 'facing6', 'north')], ...SOLID_TABLES,
    // Face i shows texture 1 when it is the facing face, 2 otherwise.
    faceTex: (p) => ['north', 'east', 'south', 'west', 'up', 'down'].map((f) => (f === p['facing'] ? 1 : 2)),
  },
  { name: 'half_block', props: [prop('half', 'half', 'bottom')], ...SOLID_TABLES, shape: 'box' },
  {
    name: 'trapdoor', props: [prop('open', 'open', 'false')], ...SOLID_TABLES,
    opacity: (p) => (p['open'] === 'true' ? 0 : 1), pass: 'cutout', collide: (p) => (p['open'] === 'true' ? 'none' : 'boxes'),
  },
  { name: 'gate', props: [prop('hinge', 'hinge', 'left')], ...SOLID_TABLES, emit: (p) => (p['hinge'] === 'right' ? 7 : 0) },
  {
    name: 'slab', props: [prop('type', 'slabType', 'bottom')], ...SOLID_TABLES,
    fullFaces: (p) => (p['type'] === 'double' ? 63 : p['type'] === 'top' ? 16 : 32),
  },
  { name: 'pillar', props: [prop('axis', 'axis', 'y'), prop('half', 'half', 'top')], ...SOLID_TABLES, tint: 'foliage' },
  {
    name: 'door',
    props: [prop('facing', 'facing4', 'north'), prop('half', 'half', 'bottom'), prop('open', 'open', 'false'), prop('hinge', 'hinge', 'left')],
    ...SOLID_TABLES, opacity: 0, pass: 'cutout', fluidMode: 'hold', sound: 'wood', fullFaces: 0,
  },
];

/** First state id of each fixture type (ids follow the definition order). */
export const FIXTURE_BASE = {
  air: 0, log: 1, chest: 4, piston: 8, half_block: 14, trapdoor: 16, gate: 18, slab: 20, pillar: 23, door: 29,
} as const;
export const FIXTURE_STATE_COUNT = 61;
