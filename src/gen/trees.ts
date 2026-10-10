/**
 * Tier 2 of a params document's two trees (SP3d spec §1.8, D2, D3): `validateParamTrees(params)` runs
 * `validateDensitySource` on `params.density.defs` and `validateRulesSource` on `params.surface.rules` and returns their
 * issues, density first, each with its leaf path prefixed: the leaf path, a dot and the node path
 * (`density.defs.root.a.x`, `surface.rules.root.rules[1].then.if.min`); an issue at the value itself (empty node path)
 * carries the leaf path alone (`surface.rules`). Both validators are memoised by tree identity, so a document whose trees
 * are the registered (frozen) values it had before costs two WeakMap lookups. Never throws; `[]` means both trees are
 * valid. The session (constructor option), the worker's configure, the editors and the invariant tests call it; the
 * resolvers run the same validators themselves. Follows the gen determinism rules.
 */
import type { Issue } from '../core/params/kit';
import type { Params } from '../core/params/schema';
import { validateDensitySource } from './density/source';
import { validateRulesSource } from './surface/source';

const DENSITY = validateDensitySource;
const RULES = validateRulesSource;

/** The leaf paths of the two trees. */
const DENSITY_LEAF = 'density.defs';
const RULES_LEAF = 'surface.rules';

/** `<leaf>.<node path>`; the leaf path alone for an issue at the value itself, `<leaf>[i]` for an array item. */
function prefixed(leaf: string, path: string): string {
  if (path === '') return leaf;
  return path.startsWith('[') ? `${leaf}${path}` : `${leaf}.${path}`;
}

/** Tier 2 of both trees of `params`, issues prefixed by their leaf path (density first); `[]` when both are valid. */
export function validateParamTrees(params: Params): Issue[] {
  const out: Issue[] = [];
  for (const i of DENSITY(params.density.defs)) out.push({ path: prefixed(DENSITY_LEAF, i.path), code: i.code, message: i.message });
  for (const i of RULES(params.surface.rules)) out.push({ path: prefixed(RULES_LEAF, i.path), code: i.code, message: i.message });
  return out;
}
