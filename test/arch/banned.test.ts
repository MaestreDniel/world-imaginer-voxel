import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkBanned, importClauseBindings, isNumericExpr, listAudioFiles } from './rules/banned';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/banned/${name}`, import.meta.url));
const brief = (root: string) => sortViolations(checkBanned(scanTree(root))).map((v) => `${v.file}:${v.line} ${v.rule}`);

test('bad fixture tree reports every banned use', () => {
  expect(brief(fixture('bad'))).toEqual([
    'src/core/encoder.ts:1 engine-dependent-api',
    'src/core/fround.ts:1 math-member',
    'src/core/localeSort.ts:1 engine-dependent-api',
    'src/core/noise/direct.ts:2 hot-import-reference',
    'src/core/normalize.ts:1 engine-dependent-api',
    'src/core/perfNow.ts:1 nondeterministic',
    'src/core/pow.ts:1 math-pow-operator',
    'src/core/random.ts:1 nondeterministic',
    'src/core/spawnWorker.ts:1 worker-api',
    'src/core/spline/ns.ts:1 hot-import-namespace',
    'src/core/worker.ts:1 worker-api',
    'src/gen/alias.ts:1 math-as-value',
    'src/gen/binaryExport.ts:1 numeric-export',
    'src/gen/computed.ts:1 math-computed',
    'src/gen/data.ts:1 numeric-data-export',
    'src/gen/defaultNumeric.ts:1 numeric-export',
    'src/gen/destructureMath.ts:1 math-as-value',
    'src/gen/intl.ts:1 engine-dependent-api',
    'src/gen/log.ts:1 nondeterministic',
    'src/gen/multiDecl.ts:2 numeric-export',
    'src/gen/pow.ts:1 math-pow-operator',
    'src/gen/powAssign.ts:1 math-pow-operator',
    'src/gen/trig.ts:1 math-member',
    'src/gen/tunable.ts:1 numeric-export',
    'src/gen/tunables2.ts:2 numeric-export',
    'src/gen/wrappedInit.ts:1 numeric-export',
    'src/light/dom.ts:1 dom-global',
    'src/metrics/direct.ts:2 hot-import-reference',
    'src/metrics/sp1Goldens.ts:1 nondeterministic',
    'src/metrics/sp1Goldens.ts:2 math-pow-operator',
    'src/render/materials/raw.glsl:1 raw-shader-file',
    'src/render/materials/rawImport.ts:1 raw-import',
    'src/render/threeAudio.ts:1 three-audio',
    'src/render/threeAudioNamespace.ts:2 three-audio',
    'src/render/threeAudioReexport.ts:1 three-audio',
    'src/ui/audio.ts:1 webaudio-outside-sound',
    'src/ui/shader.ts:1 glsl-outside-materials',
    'src/world/clock.ts:1 nondeterministic',
  ]);
});

test('good fixture tree passes', () => {
  expect(brief(fixture('good'))).toEqual([]);
});

test('the repository uses no banned API', () => {
  expect(sortViolations(checkBanned(scanTree(ROOT)))).toEqual([]);
});

describe('isNumericExpr', () => {
  test.each(['1', '-1', '+1', '1e-3', '0x10', '1_000', '1n', '(3)', '5 as const', '2 * 8', '1.5 satisfies number', '.5', '0b101', '0o17'])('%s is numeric', (s) => {
    expect(isNumericExpr(s)).toBe(true);
  });
  test.each(['x', '() => 1', "'a'", '{ k: 1 }', 'Math.PI', 'a * 2'])('%s is not numeric', (s) => {
    expect(isNumericExpr(s)).toBe(false);
  });
});

describe('audio files', () => {
  test('any audio extension, any case, outside node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'audio-'));
    try {
      mkdirSync(join(root, 'public'));
      mkdirSync(join(root, 'node_modules'));
      for (const f of ['public/x.ogg', 'Y.MP3', 'ok.txt', 'node_modules/z.wav', 'a.Flac']) writeFileSync(join(root, f), '');
      expect(listAudioFiles(root)).toEqual(['Y.MP3', 'a.Flac', 'public/x.ogg']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the repository contains no audio files', () => {
    expect(listAudioFiles(ROOT)).toEqual([]);
  });
});

describe('hot-module import rule', () => {
  test('importClauseBindings', () => {
    expect(importClauseBindings('{ a, b as c, type T }')).toEqual({ names: ['a', 'c'], namespace: false });
    expect(importClauseBindings('d, { e }')).toEqual({ names: ['e', 'd'], namespace: false });
    expect(importClauseBindings('* as ns')).toEqual({ names: [], namespace: true });
  });
});
