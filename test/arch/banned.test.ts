import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkBanned, isNumericExpr, listAudioFiles } from './rules/banned';
import { ROOT, scanTree, sortViolations } from './scan';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/banned/${name}`, import.meta.url));
const brief = (root: string) => sortViolations(checkBanned(scanTree(root))).map((v) => `${v.file}:${v.line} ${v.rule}`);

test('bad fixture tree reports every banned use', () => {
  expect(brief(fixture('bad'))).toEqual([
    'src/core/random.ts:1 nondeterministic',
    'src/core/worker.ts:1 worker-api',
    'src/gen/alias.ts:1 math-as-value',
    'src/gen/computed.ts:1 math-computed',
    'src/gen/data.ts:1 numeric-data-export',
    'src/gen/log.ts:1 nondeterministic',
    'src/gen/pow.ts:1 math-pow-operator',
    'src/gen/trig.ts:1 math-member',
    'src/gen/tunable.ts:1 numeric-export',
    'src/gen/tunables2.ts:2 numeric-export',
    'src/light/dom.ts:1 dom-global',
    'src/render/materials/raw.glsl:1 raw-shader-file',
    'src/render/materials/rawImport.ts:1 raw-import',
    'src/render/threeAudio.ts:1 three-audio',
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
  test.each(['1', '-1', '+1', '1e-3', '0x10', '1_000', '1n', '(3)', '5 as const', '2 * 8', '1.5 satisfies number', '.5'])('%s is numeric', (s) => {
    expect(isNumericExpr(s)).toBe(true);
  });
  test.each(['x', '() => 1', "'a'", '{ k: 1 }', 'Math.PI', 'a * 2'])('%s is not numeric', (s) => {
    expect(isNumericExpr(s)).toBe(false);
  });
});

describe('audio files', () => {
  test('any audio extension, any case, outside node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'audio-'));
    mkdirSync(join(root, 'public'));
    mkdirSync(join(root, 'node_modules'));
    for (const f of ['public/x.ogg', 'Y.MP3', 'ok.txt', 'node_modules/z.wav', 'a.Flac']) writeFileSync(join(root, f), '');
    expect(listAudioFiles(root)).toEqual(['Y.MP3', 'a.Flac', 'public/x.ogg']);
  });

  test('the repository contains no audio files', () => {
    expect(listAudioFiles(ROOT)).toEqual([]);
  });
});
