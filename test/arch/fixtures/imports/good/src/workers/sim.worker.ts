import { open } from '../persist/idb';
import { tick } from '../sim/fluid';
import { paint } from '../textures/paint';
import { synth } from '../audio/synth';
export const all = [open, tick, paint, synth];
