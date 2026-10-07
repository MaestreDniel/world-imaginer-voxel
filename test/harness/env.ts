/**
 * Integer environment knobs of the harness (`SLAB_FUZZ_SEED`, `DT1_SHUFFLE_SEED`), validated (SP3a §10's minor,
 * SP3b spec §7): `Number()` would silently turn `abc` or an empty value into a seed.
 */

/** `env[name]` as a safe integer (decimal, optional '-'), or `fallback` when unset; anything else throws. */
export function integerEnv(name: string, fallback: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(v)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return v;
}
