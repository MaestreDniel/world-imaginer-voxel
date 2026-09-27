import type { ParamMeta } from './kit';
import { SCHEMA } from './schema';

/** Derived from the schema; never hand-written. */
export const PARAM_META: readonly ParamMeta[] = SCHEMA.leaves.map((l) => l.meta);
const BY_PATH = new Map(PARAM_META.map((m) => [m.path, m] as const));

export function metaOf(path: string): ParamMeta | undefined {
  return BY_PATH.get(path);
}
