import { deriveSeed, type Seed64 } from '../hash';
import { splitmix32 } from '../rng';
import { lattice3 } from './lattice3';
import type { NoiseDef } from './types';

const DERIVE = deriveSeed;
const SPLITMIX = splitmix32;
const LAT = lattice3;
const ORIGIN_SCALE = 9.5367431640625e-7; // 2^-20: origins are u32·2^-20 lattice units in [0, 4096)

/** Sum of octaves (SP1 spec §2.2). Octave seeds `${name}#${i}`; fractional per-octave origins. */
export class OctaveNoise {
  readonly sumA2: number;
  private readonly n: number;
  private readonly seed: Int32Array;
  private readonly freq: Float64Array;
  private readonly amp: Float64Array;
  private readonly ox: Float64Array;
  private readonly oy: Float64Array;
  private readonly oz: Float64Array;
  private readonly oy2: Float64Array;
  private readonly yScale: number;

  constructor(world: Seed64, name: string, def: NoiseDef) {
    const n = def.octaves;
    this.n = n;
    this.yScale = def.yScale;
    this.seed = new Int32Array(n);
    this.freq = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.ox = new Float64Array(n);
    this.oy = new Float64Array(n);
    this.oz = new Float64Array(n);
    this.oy2 = new Float64Array(n);
    let f = 1 / def.wavelength;
    let a = 1;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = DERIVE(world, `${name}#${i}`);
      this.seed[i] = s | 0;
      const sm = SPLITMIX(s);
      this.ox[i] = sm() * ORIGIN_SCALE;
      this.oy[i] = sm() * ORIGIN_SCALE;
      this.oz[i] = sm() * ORIGIN_SCALE;
      this.oy2[i] = Math.floor(this.oy[i]!) + 0.5;
      this.freq[i] = f;
      const ai = def.amplitudes === null ? a : def.amplitudes[i]!;
      this.amp[i] = ai;
      s2 += ai * ai;
      f *= def.lacunarity;
      a *= def.persistence;
    }
    this.sumA2 = s2;
  }

  /** 2D field: the fixed slice y = floor(oy_i) + ½ of each octave. */
  sample2(x: number, z: number): number {
    let v = 0;
    for (let i = 0; i < this.n; i++) {
      const a = this.amp[i]!;
      if (a === 0) continue;
      const f = this.freq[i]!;
      v += a * LAT(this.seed[i]!, x * f + this.ox[i]!, this.oy2[i]!, z * f + this.oz[i]!);
    }
    return v;
  }

  sample3(x: number, y: number, z: number): number {
    let v = 0;
    const ys = this.yScale;
    for (let i = 0; i < this.n; i++) {
      const a = this.amp[i]!;
      if (a === 0) continue;
      const f = this.freq[i]!;
      v += a * LAT(this.seed[i]!, x * f + this.ox[i]!, y * f * ys + this.oy[i]!, z * f + this.oz[i]!);
    }
    return v;
  }
}
