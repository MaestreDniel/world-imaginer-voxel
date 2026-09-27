import type { Seed64 } from '../hash';
import { PERLIN2_SD, PERLIN3_SD } from './lattice3';
import { OctaveNoise } from './octave';
import type { OctaveNoise as OctaveNoiseT } from './octave';
import type { NoiseDef } from './types';

const Octave = OctaveNoise;
const SD2 = PERLIN2_SD;
const SD3 = PERLIN3_SD;
const R337 = 337 / 331;

/** Double-stack, unit-sd, clamped noise (SP1 spec §2.3). z = clamp((A + B(p·R))·invSd, −c, c). */
export class NormalNoise {
  readonly def: NoiseDef;
  readonly clamp: number;
  private readonly a: OctaveNoiseT;
  private readonly b: OctaveNoiseT | null;
  private readonly inv2: number;
  private readonly inv3: number;

  constructor(world: Seed64, name: string, def: NoiseDef) {
    this.def = def;
    this.a = new Octave(world, name, def);
    this.b = def.double ? new Octave(world, `${name}'`, def) : null;
    const sum = this.b === null ? this.a.sumA2 : this.a.sumA2 + this.b.sumA2;
    const s = Math.sqrt(sum);
    this.inv2 = 1 / (SD2 * s);
    this.inv3 = 1 / (SD3 * s);
    this.clamp = def.clampSigma;
  }

  z2(x: number, z: number): number {
    const b = this.b;
    const v = (b === null ? this.a.sample2(x, z) : this.a.sample2(x, z) + b.sample2(x * R337, z * R337)) * this.inv2;
    const c = this.clamp;
    return v < -c ? -c : v > c ? c : v;
  }

  z3(x: number, y: number, z: number): number {
    const b = this.b;
    const v = (b === null ? this.a.sample3(x, y, z) : this.a.sample3(x, y, z) + b.sample3(x * R337, y * R337, z * R337)) * this.inv3;
    const c = this.clamp;
    return v < -c ? -c : v > c ? c : v;
  }
}
