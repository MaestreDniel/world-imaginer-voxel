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

function isPlainObject(v: object): boolean {
  const p: unknown = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function enc(v: unknown, path: string, depth: number): string {
  if (depth > 64) throw new CanonicalError(path, 'nesting deeper than 64');
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

/** RFC 8785 (JCS), stricter: NaN, ±Infinity, −0, non-plain objects and undefined array items throw. */
export function canonicalJSON(v: unknown): string {
  return enc(v, '', 0);
}
