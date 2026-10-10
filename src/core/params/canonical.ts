/** 15 significant digits: a unique printed form by the letter of ECMA-262; idempotent; −0 → +0. */
export function q15(x: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(15));
}

export class CanonicalError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path === '' ? '<root>' : path}: ${message}`);
    this.path = path;
  }
}

/** canonicalJSON's nesting limit: a value deeper than this throws. */
const MAX_NESTING = 64;

interface CachedText {
  readonly text: string;
  /** The deepest nesting offset inside the value (its top is 0): the uncached walk throws iff depth + height > 64. */
  readonly height: number;
}
/** Canonical text of the deep-frozen values tier 1 registered (`checkJson`, SP3d spec §1.12), keyed by identity. */
const TEXT_CACHE = new WeakMap<object, CachedText>();
let cacheHits = 0;

/**
 * Records the canonical text of a deep-frozen value; only `checkJson` (`json.ts`) calls it, for the clones it
 * registers, so a cached text can never go stale.
 */
export function rememberCanonical(v: object, text: string, height: number): void {
  TEXT_CACHE.set(v, { text, height });
}

/** How many times canonicalJSON printed a value from the text cache (tests). */
export function canonicalCacheHits(): number {
  return cacheHits;
}

function isPlainObject(v: object): boolean {
  const p: unknown = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function enc(v: unknown, path: string, depth: number): string {
  if (depth > MAX_NESTING) throw new CanonicalError(path, `nesting deeper than ${MAX_NESTING}`);
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError(path, `non-finite number ${String(v)}`);
      if (Object.is(v, -0)) throw new CanonicalError(path, 'negative zero');
      return String(v);
    case 'object': {
      if (v === null) return 'null';
      // A cached value prints in O(1); one nested too deep takes the walk below, which throws at its exact path.
      const cached = TEXT_CACHE.get(v);
      if (cached !== undefined && depth + cached.height <= MAX_NESTING) {
        cacheHits++;
        return cached.text;
      }
      if (Array.isArray(v)) {
        let s = '[';
        for (let i = 0; i < v.length; i++) {
          const item: unknown = v[i];
          const p = `${path}[${i}]`;
          if (item === undefined) throw new CanonicalError(p, 'undefined array item');
          s += (i > 0 ? ',' : '') + enc(item, p, depth + 1);
        }
        return `${s}]`;
      }
      if (!isPlainObject(v)) throw new CanonicalError(path, 'not a plain object');
      const rec = v as Record<string, unknown>;
      let s = '{';
      let first = true;
      for (const k of Object.keys(rec).sort()) {
        const item = rec[k];
        if (item === undefined) continue;
        s += `${first ? '' : ','}${JSON.stringify(k)}:${enc(item, path === '' ? k : `${path}.${k}`, depth + 1)}`;
        first = false;
      }
      return `${s}}`;
    }
    default:
      throw new CanonicalError(path, `unsupported ${typeof v}`);
  }
}

/**
 * RFC 8785 (JCS), stricter: NaN, ±Infinity, −0, non-plain objects and undefined array items throw. The values tier 1
 * registered print from their cached text.
 */
export function canonicalJSON(v: unknown): string {
  return enc(v, '', 0);
}
