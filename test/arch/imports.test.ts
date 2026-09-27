import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkImports } from './rules/imports';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/imports/${name}`, import.meta.url));
const brief = (root: string) => sortViolations(checkImports(scanTree(root))).map((v) => `${v.file}:${v.line} ${v.rule}`);

test('good fixture tree has no violations', () => {
  expect(brief(fixture('good'))).toEqual([]);
});

test('bad fixture tree reports every violation', () => {
  expect(brief(fixture('bad'))).toEqual([
    'src/core/bad-dynamic.ts:1 dynamic-nonliteral',
    'src/core/bad-type-expr.ts:1 type-import-expr',
    'src/core/bad-world.ts:1 layer',
    'src/engine/bad-three.ts:1 three-outside-render',
    'src/gen/bad-value-api.ts:1 layer',
    'src/light/bad-slab.ts:1 layer',
    'src/main.ts:1 worker-import',
    'src/render/bad-gen-type.ts:1 layer',
    'src/strange/bad-layer.ts:1 unknown-layer',
    'src/ui/bad-materials.ts:1 materials-outside-render',
    'src/ui/bad-test-import.ts:1 test-import',
    'src/ui/bad-worker-edge.ts:1 worker-edge',
  ]);
});

test('the repository follows the layer table', () => {
  expect(sortViolations(checkImports(scanTree(ROOT)))).toEqual([]);
});
