import { applyPatch } from '../../src/core/params/kit';
import { DEFAULTS } from '../../src/core/params/defaults';
import { SCHEMA, type Params, type ParamsPatch } from '../../src/core/params/schema';
import { seedFromInput } from '../../src/core/seed';
import { createGenContext, type GenContext } from '../../src/gen/context';

/** DEFAULTS ⊕ patch (throws on an invalid patch). */
export function paramsWith(patch: ParamsPatch = {}): Params {
  const r = applyPatch(SCHEMA, DEFAULTS, patch);
  if (!r.ok) throw new Error(`bad test patch: ${JSON.stringify(r.issues)}`);
  return r.value;
}

/** A GenContext for seed text `seed` over DEFAULTS ⊕ patch. */
export function ctxFor(seed = '42', patch: ParamsPatch = {}): GenContext {
  return createGenContext(seedFromInput(seed), paramsWith(patch));
}
