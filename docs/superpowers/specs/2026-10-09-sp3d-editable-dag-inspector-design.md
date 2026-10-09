# SP3d — Editable density and surface rules, inspector and slice viewer (Design)

Date: 2026-10-09
Status: Draft for the user's review (the design was approved by the user section by section on 2026-10-09, `.superpowers/sp3d/design-brief.md`; this text adds the decisions the code survey required, listed in "Decisions taken by this spec")
Parent: master spec `2026-09-26-architecture-design.md`. The sections involved are:
- §10 SP3d, which this spec narrows to the tooling, and a new SP3e (the three draft presets) inserted after it (§14);
- §2.5 (key types: `SubProjectId`, `ParamMeta.kind`, `Expr`), §2.7 (presets and the world URL), §3.6 (density DAG), §3.11 (surface rules), §3.15 (extreme presets), §3.17 (determinism);
- §5.1 (parameters and stage hashes), §5.5 (inspector, taps, mutes, probe, slice view);
- the testing sections §6.1-6.4 (U2, U4, DT1, DT2) and §7 (performance budget: the inspector slice).
Previous SPs: `2026-10-07-sp3b-density-terrain-design.md` (its §13 hands SP3d the validation of untrusted `density.defs`) and `2026-10-07-sp3c-surface-rules-palette-design.md` (its §11 hands SP3d `surface.rules` as an editable leaf, the non-solid states and the fast-path contract).

References written "master §x" point to the master spec, "SP3b §x", "SP3c §x" (and SP1, SP2a, SP2b, SP3a) to those specs, and a bare "§x" to this document. Code is cited as it is at `main` 9fababa (`GENERATOR_VERSION` 5); the maps behind the citations are in `.superpowers/sp3d/map-*.md`.

## Goal

Make the terrain editable as data. The default density expression and the default surface-rule tree become two schema leaves of a new `json` kind, whose defaults are today's trees written as data and whose numbers reference the existing parameters, so every slider keeps working on an edited tree. An edited tree is validated as untrusted JSON before it reaches the generator, travels through the session (undo, URL, presets, live preview) like any other parameter, and is inspected in a new **Density** drawer tab of `?map`: a node tree, a node form, a JSON editor and a slice viewer that shows the final density, any selected node or the blocks on a vertical or horizontal plane, re-rendered on every edit. With the defaults the world is bit-identical: no voxel, tile, metric or golden changes. SP3e then designs the three draft presets on this tooling.

## Non-goals

- The draft presets `floating_islands`, `amplified` and `archipelago` (their terms, splines, params, the islands surface-rule branch, island-edge springs, Z1-Z3, per-preset goldens and B1's ocean-cap gating for archipelago): the new SP3e (Decision 1, §14).
- A visual (node-graph) editor: out of scope in the master (§5.5).
- Caves, cave terms, the level fields' −∞ interval rule and `caveBiome`: SP6. The default trees gain no term here.
- Pinned slices (up to 3 side by side): the cut line (§11), received by SP10 if cut.
- The slice view of every 3D field, the 256² refinement, the full probe and the JSON editors of features and structures: SP10 (master §10 SP10).
- `stoneDepth.secondaryDepthRange` (SP3c §3.1): no default rule needs it, so it stays an unknown field.
- Any change of the world: the default trees resolve to exactly the trees the code builds today (§2), and `GENERATOR_VERSION` stays 5 (§8).

## Decisions confirmed by the user (2026-10-09)

All five answers took the recommended option; each design section was then approved in turn.
1. **Scope split.** Master SP3d is cut in two: SP3d (this spec) is the tooling (editable density DAG and surface rules, untrusted-JSON validation, the inspector and the slice viewer); a new SP3e holds the three draft presets, built on the editable DAG. The master is amended (§14).
2. **Purpose.** Experimenting with the terrain: editing nodes and terms (for example adding an islands term or changing the slide), muting a tap to see what it contributes, and seeing the result in a slice at once. It is what SP3e needs to design the presets.
3. **Location.** A new drawer tab "Density" in `?map`, next to "Spline" and "Cross-section", sharing the map's `WorldSession` (undo/redo, URL, presets, live preview).
4. **Approach A (data model).** The JSON tree references parameters; sliders keep working when the tree is edited.
5. **`surface.rules` is editable too**, with the same approach.
6. **Design sections approved:** the data model (brief §1), the inspector (§2), the slice viewer (§3), and the tests, governance and exit (§4).

## Decisions taken by this spec (for the user's review)

The brief left these open or the code survey forced them. Each states its alternative; the recommendation is the text of the section cited.
- **D1 Leaf kind `json` with a format.** One new kind `json` (as the brief says) whose leaf carries `format: 'density' | 'surfaceRules'`; the master's reserved kinds `'expr'` and `'ruleTree'` (`kit.ts:12-13`, master §2.5) are removed, since nothing uses them. The schema-shape lock records `json:<format>` so a format switch is a shape change (§1.1). Alternative: reuse the two reserved kinds (no discriminator needed, but two kinds for one mechanism).
- **D2 Two-tier validation without a layer change** (§1.7, §1.8). Core cannot import gen or world (`test/arch/rules/imports.ts:16`) and the engine imports gen as types only (`imports.ts:28`), while the validators need gen's and world's vocabularies. Tier 1 (core, inside `checkLeaf`) guarantees a canonical-safe, bounded JSON value; tier 2 (gen) is the full semantic validation, run by the worker at configure and injected into `WorldSession` through a constructor option that the UI wires. Alternatives: move the validators and their vocabularies (sample fields, biome names, block states and solidity) into core, or let the engine value-import gen.
- **D3 Leaf shapes and paths** (§1.2). `density.defs` holds the whole `{root, defs}` expression; `surface.rules` holds the root rule. An issue path is the leaf path, a dot, then the format's node path (`density.defs.root.a.x`, `surface.rules.root.rules[1].then.if.min`).
- **D4 Parameter refs** (§1.3). Targets: the `number` and `int` leaves under `density.` and `surface.`, and the `clampSigma` field of their noise leaves. Every check that involves a ref holds for the target's whole static range, so a slider move can never invalidate a stored tree. In density a ref is a `param` node that stands where a `const` would; scalar fields stay literals. In rules a numeric field may be `{param}` or `{param, neg: true}` (`0 − v`); an int field takes only `int` leaves.
- **D5 Source-only ops.** `param`, `recip` and tap `mute` exist only in the source tree and are resolved before compilation (§1.6), so `EXPR_OPS`, the compiler, the bounds, the reference evaluator, both op-coverage tests and the `sp3b.density.*` goldens are untouched. `recip` takes a constant operand (a `const`, or a `param` whose range excludes 0).
- **D6 Constant folding at resolution** (§1.6), so that the resolved default is the very tree the code builds (same `exprHash`), as the brief requires.
- **D7 Mute value.** The inspector's toggle writes the neutral value of the tap's parent (§1.5); the value stays editable in the form.
- **D8 NaN-free and sound** (§1.9). Both a static magnitude analysis of the source (literals ≤ 1e9, values ≤ 1e100) and interval "poison" propagation in the bounds; the brief offered one of the two.
- **D9 Bounds** (§1.7): the numbers of every size, depth and cost limit.
- **D10 Freeze point** (§1.6): the resolved tree is cloned and deep-frozen by the resolution step that the contexts call, not inside `compileDensity` (which would break the identity-keyed APIs, `compile.ts:106-107`).
- **D11 Fast-path contract** (§1.10): `scanColumn` clamps the depth noise and `surfaceScanSettings` refuses `depthMul < 0`.
- **D12 `SCHEMA_VERSION` 2** with an identity migration and the two U4 fixtures (§1.11); the bump is not forced by the lock (`test/harness/schemaShape.ts:37-44`) but makes older builds report `NEWER_SCHEMA_VERSION`.
- **D13 URL and history size accepted** (§1.12): atomic leaves, a 128 KiB cap per tree, no finer diff.
- **D14 Goldens** (§8): `sp1.params` hashes a frozen fixture schema, so the new leaves cannot move it; `GENERATOR_VERSION` stays 5 and `test/goldens.json` stays byte-identical. The brief's conditional is stated both ways.
- **D15 U2 and DT2** (§7): the exact perturbations of the two leaves, and two new DT2 parts for edited trees.
- **D16 Slice geometry, fields and costs** (§4, §5): the sample formulas; every density field evaluated by the reference; rule-node masks; horizontal slices from exact four-corner point samples instead of full ColumnSamples (the brief's "one column sample per point" at 16× less cost, measured in `map-workers.md` §7); a deterministic work bound; same-epoch cancellation of queued parts only; requests triggered by the pool being configured at the session epoch.
- **D17 Hover value job** (§5.3): a new `fieldProbe` worker job (no density probe job exists, `map-workers.md` §2).
- **D18 Inspector UI rules** (§3): tab order and grid, the JSON editor's own printer and parser with its dirty-buffer rule, the node-form operations' exact semantics, the cut-line behaviour while Density is shown, wrapped readouts.
- **D19 Hand-overs**: the land-top y mod 16 residue goes to SP6 (§13).

## Module layout after SP3d

```
src/core/params/json.ts           the `json` leaf kind's tier-1 validator (canonical safety, bounds, clone) and the tree issue codes
src/core/params/defaultTrees.ts   DEFAULT_DENSITY_TREE and DEFAULT_SURFACE_RULES as data (§2)
src/core/params/kit.ts            + kind 'json' (format, checkLeaf case, renderReference row); 'expr' and 'ruleTree' removed
src/core/params/schema.ts         + `density.defs` and `surface.rules` (last in their groups)
src/core/params/migrate.ts        SCHEMA_VERSION 2, MIGRATIONS = [identity]
src/core/ids.ts                   + 'SP3e'; CURRENT_SP 'SP3d'
src/core/params/profiles.ts       archipelago, amplified, floating_islands readyFrom 'SP3e'
src/gen/density/source.ts         the source model (param, recip, mute), validateDensitySource, resolveDensity, the static analysis,
                                  node lookup by path and the selected node's placement (§1, §3.4)
src/gen/density/nodes.ts, bounds.ts   interval poison propagation (§1.9)
src/gen/density/expr.ts           the root ref bucket fix (§1.7)
src/gen/density/context.ts        the default expression is resolveDensity(params.density.defs, params)
src/gen/density/defaults.ts       removed (the builder moves to test/harness/legacyTrees.ts)
src/gen/surface/source.ts         rule param refs, validateRulesSource, resolveRules (§1)
src/gen/surface/rules.ts          + NOT_SOLID; FIELDS and the per-kind defaults exported (§3.3)
src/gen/surface/reference.ts      + node lookup by id and a standalone condition test (§4.1)
src/gen/surface/scan.ts           the depth-noise clamp and the depthMul check (§1.10)
src/gen/surface/context.ts        the default rules are resolveRules(params.surface.rules, params)
src/gen/surface/defaults.ts       removed (the builder moves to test/harness/legacyTrees.ts)
src/gen/trees.ts                  validateParamTrees(params): tier 2 for both leaves of a params document (§1.8)
src/gen/column/columnStage.ts     + buildCornerSample (the four quart corners a voxel reads, §4.4)
src/metrics/crossSection.ts       segmentPointAt(s, i, n = 512)
src/workers/protocol.ts           + FieldSlice / FieldProbe messages, guards, the sample geometry and the work-bound constants (§5)
src/workers/fieldSliceJob.ts      the fieldSlice and fieldProbe evaluation (§5)
src/workers/taskHandler.ts        + the two jobs, tier-2 validation at configure, an exhaustive switch
src/engine/workerPool.ts          + fieldSlice (split, merge, cancel handle) and fieldProbe
src/engine/session.ts             + the `validateParams` constructor option (§1.8)
src/ui/inspector/                 the Density tab: model.ts (selection, rows), form.ts (node operations), jsonText.ts (printer and
                                  parser), jsonEditor.ts, sliceModel.ts (geometry, colormap, contour, histogram, requests),
                                  sliceView.ts, densityTab.ts, inspector.css
src/ui/map/layout.ts, mapPage.ts, mapView.ts, previewDriver.ts, perfHook.ts
                                  + the 'density' drawer tab, the horizontal square overlay, DriverStatus.sessionEpoch,
                                  the pool's new methods forwarded
src/ui/paramPanel/controls.ts, model.ts   + the json control (a link to the Density tab)
src/ui/crossSection/section.ts, section.css   + a line-change event; the readout wraps (§3.6)
test/harness/legacyTrees.ts       the old defaultDensityExpr and defaultSurfaceRules builders, kept as fixtures
test/harness/treeMutator.ts       the untrusted-JSON mutator for the fuzz and DT2's edited trees
test/fixtures/preset-v1.json, expected-v1.json   U4's migration fixtures
test/schema-shape.lock.json       schemaVersion 2, + density.defs json:density, surface.rules json:surfaceRules
```

## 1. Data model

### 1.1 The `json` leaf kind (`kit.ts`, `json.ts`)

- `ParamKind` gains `'json'` and loses the reserved, unused `'expr'` and `'ruleTree'` (`kit.ts:12-13`; master §2.5). `featureList` and `structureSets` stay reserved for SP8b/SP9, which will decide whether they become `json` formats.
- A `json` leaf is built by `jsonLeaf(def, format, meta)` with `merge: 'atomic'` (required: `applyPatch` replaces atomic leaves whole, `kit.ts:445`; `diffParams` compares them whole, `kit.ts:472`; the session's `mergeInto` returns the delta, `session.ts:72`). `Leaf` and `ParamMeta` gain `format?: JsonFormat`, present exactly on `json` leaves.
- `checkLeaf` gains `case 'json': return checkJson(v, path, out, leaf.format)` (tier 1, §1.7). It never throws; `undefined` (from `session.set(path, undefined)`, `session.ts:93-99`) is the issue `NOT_JSON`.
- `renderReference` (`kit.ts:506-518`) writes a json leaf's default cell as `<format> tree, <n> nodes` (as `boxTable` writes `N rows`), never the tree itself; its range cell is empty.
- The shape lock records `json:density` and `json:surfaceRules` as the kinds of the two leaves (`currentShape`, `test/harness/schemaShape.ts:17-21`, reads `meta.kind` plus `:format` for json leaves), so a format change is a re-kind and needs a `SCHEMA_VERSION` bump.
- `IssueCode` (`kit.ts:46-51`) gains `JsonIssueCode` (tier 1) and `TreeIssueCode` (tier 2), both string-literal unions declared in `core/params/json.ts`; a type test asserts that gen's `ExprErrorCode` (`expr.ts:96-98`), `RuleErrorCode` (`rules.ts:113-120`) and the new source codes are assignable to `TreeIssueCode`.
- The parameter panel (`panelTree` adds a control for every leaf, `ui/paramPanel/model.ts:79-94`; `createControl` throws for other kinds, `controls.ts:465-475`) gains a `treeControl`: the leaf's label, the modified dot and reset, and a link "Edit in Density" that opens the drawer's Density tab on that root (the precedent is `splineControl`, `controls.ts:433-447`). `PANEL_KINDS` gains `'json'`.
- `randomValue` (`test/harness/params.ts:91-123`) returns a json leaf's default and makes **no draw**, so every other leaf's random stream is unchanged; random trees come from the dedicated fuzz (§10).

### 1.2 The two leaves

| leaf | format | value | placement |
|---|---|---|---|
| `density.defs` | `density` | the whole density expression `{root, defs}` (SP3b §1.1's `DensityExpr` top level), in source form (§1.3-§1.5) | TERRAIN (`schema.ts:10`), last in the `density` group |
| `surface.rules` | `surfaceRules` | the root rule (SP3c §3.1's JSON encoding), in source form | TERRAIN, last in the `surface` group |

- Both sit under the `terrain` stage's hashed prefixes `['density', 'surface']` (`core/stage/registry.ts:20`), so editing a tree dirties `terrain` and everything after it, and nothing before it (the map tiles' stages keep their hashes).
- **Paths.** An issue's path is the leaf path, a dot, and the format's node path:
  - density: the JSON path inside the value, which is also `validateExpr`'s path syntax (`expr.ts:101-102`): `root`, `root.a.b.x`, `root.knots[2]`, `defs.terrain`, `defs.terrain.x`; so `density.defs.root.a.x` is also a `getPath` path;
  - rules: SP3c's rule ids with their condition and field suffixes (`rules.ts:74-82`, `119`): `root`, `root.rules[1].then`, `root.rules[1].then.if.if`, `.min`, `.biomes[2]`. `root` names the value itself and is not a JSON key, so `surface.rules.root.rules[1]` is not a `getPath` path; the inspector maps an issue to a node by removing the `<leaf>.` prefix (as `ui/paramPanel/model.ts:229-230` does).
- The group docs "its structure is code until SP3d" (`schema.ts:109`, `118`) become "its structure is the `defs` / `rules` tree".
- Like every leaf, the URL, presets, undo and the session carry only the diff from the profile; an untouched tree is not in the patch. An edited tree counts as one modified parameter (`modifiedCount`, `session.ts:265-273`).

### 1.3 Parameter references

**Targets.** A ref names a path in `ALLOWED_REF_TARGETS`: every leaf of kind `number` or `int` under `density.` or `surface.` (today `density.detailAmpLo`, `density.detailAmpHi`, `surface.depthMul`, `snowline`, `lapse`, `lapseBase`, `cliffSteep`, `cliffMinY`, `patchThreshold`), and the `clampSigma` field of every noise leaf under `density.noises.` and `surface.noises.` (`density.noises.jag.clampSigma`, …; a noise field is not a schema leaf, `kit.ts:143-151`, so the list is built from the schema's noise leaves, never from `getPath`, which would read anything, `kit.ts:486-494`). A target's **static range** is its leaf's `[min, max]`, or `NOISE_FIELD_RANGES.clampSigma` = [1, 8] (`kit.ts:167-174`); every listed target has a finite range. Every target is hashed by the `terrain` stage, so cache invalidation stays sound; a ref to a later stage's leaf would not dirty `terrain`, which is why upstream and later groups are excluded (SP3e may widen the set to the upstream groups, which `terrain` already chains).

**Value-independence.** Validation never reads a target's current value: every check that involves a ref must hold for every value in the ref's static range (a negated ref's range is `[0 − max, 0 − min]`; two refs are treated as independent). A tree that validates stays valid under any slider move, so validity is a pure function of the tree (which `session.restore` needs: it throws when a history snapshot stops validating, `session.ts:319-327`). Two refs to the same leaf on both sides of an order check are therefore judged as independent (for example `noiseThreshold{min: {param t}, max: {param t}}` is rejected); this is conservative and stated in the error message.

**Density.** A new source op `{op: 'param', path}` is a leaf node whose value is the target's value. It may stand in any child slot (it is COLUMN-class once resolved to a `const`). Scalar fields (`const.v`, `clamp.lo/hi`, `rangeChoice.lo/hi`, `slide.knots`, `tap.mute`) stay literal numbers, so `CLAMP_ORDER`, `RANGE_ORDER`, `KNOTS_ORDER` and the slope check stay static. The inspector offers a ref on a `const` node, which it replaces by a `param` node (§3.3).

**Rules.** Each of the nine numeric fields (`stoneDepth.offset`, `water.offset`, `yAbove.minY`, `verticalGradient.trueAtAndBelow` and `.falseAtAndAbove`, `steep.min`, `noiseThreshold.min` and `.max`, `temperatureBelow.t`; `map-surface.md` §3) may hold, instead of a number, `{"param": "<path>"}` or `{"param": "<path>", "neg": true}`. The resolved value is the target's value v, or `0 − v` when `neg` is true (`0 − 0` is +0, never −0, as `gen/surface/defaults.ts:11` writes it today; `−v` or `−1·v` would give −0). `neg` is either absent or `true` (`neg: false` is `BAD_FIELD`, so each ref has one spelling). Int fields (`offset`, `minY`, the gradient bounds) accept only `int` targets (`surface.lapseBase`, `surface.cliffMinY`, both [−64, 319], within the rules' [−384, 384]); number fields accept any target. The `verticalGradient` dither seed is derived from the resolved bounds at compile time (`conditions.ts:51-53`), so it moves with the parameter, as it would with a literal.

### 1.4 `recip` and the exact encodings

The default density reads two values that the code computes today (`gen/density/defaults.ts:32`, `41`):
- **`1 / clampSigma`** is written `{op: 'recip', x: {op: 'param', path: 'density.noises.jag.clampSigma'}}`. `recip` is a source op whose operand must be a `const` or a `param` (`RECIP_OPERAND` otherwise); a `const` operand must be non-zero with a finite reciprocal, and a `param` operand's static range must exclude 0 (`RECIP_ZERO` otherwise; clampSigma's [1, 8] passes, `detailAmpLo`'s [0, 8] fails). Resolution (§1.6) replaces it by `const(1 / c)`, computed by the same JS `1 / v` on the same double that `C(1 / p.noises.jag.clampSigma)` computes today, so the constant is bit-identical. The noise is still multiplied by the reciprocal, as SP3b §1.1 pins it (`z · (1/cs)` is not `z / cs` in general; master §3.17).
- **`ampHi − ampLo`** is written `{op: 'add', a: {op: 'param', path: 'density.detailAmpHi'}, b: {op: 'neg', x: {op: 'param', path: 'density.detailAmpLo'}}}`. ECMA-262 defines `Number::subtract(x, y)` as `Number::add(x, Number::unaryMinus(y))`, so `hi + (−lo)` equals `hi − lo` for every pair of doubles, ±0 included (also measured on 10^6 random pairs over 40 decades with 0 mismatches, `map-density.md` §6). After folding (§1.6) the node is `const(hi + (−lo))`, the same double the code folds into one constant today.
- `detailAmpLo` itself becomes `{op: 'param', path: 'density.detailAmpLo'}`.

### 1.5 Mutes

- A `tap` accepts `mute?: number` (master §2.5 already types `mute?` on tap). When present, the tap yields `mute` instead of its child. Resolution replaces `{op: 'tap', name, x, mute: m}` by `{op: 'tap', name, x: {op: 'const', v: m}}`: the tap stays (it is still addressable by `tapFn` and `probe`), and the subtree below it leaves the resolved tree (taps inside it become unreachable, so `tapFn` and `probe` refuse them, `compile.ts:414`). `exprHash` needs no change, since resolved trees carry no `mute`.
- `mute` is a literal: finite, not −0 (tier 1; `trilerp` of eight −0 gives +0, `map-density.md` §3), |m| ≤ 1e9 (§1.7).
- A mute is an ordinary tree edit: undoable, in the URL and presets, and it affects everything (map relief through T, the Voxels mode, slices).
- **The toggle's value** (D7) is the neutral value of the tap's parent in the source: 0 under `add`, 1 under `mul`, −1e6 under `max`, 1e6 under `min` (the `islands` convention, master §3.6), and 0 elsewhere (a one-child op, `rangeChoice`, a def's top or the root). Muting `terrain` (under `add`) therefore writes 0; muting `islands` (under `max`) writes −1e6, its default value. The form shows the value and lets the user change it.
- Validation runs on the source tree, so errors inside a muted subtree are still reported, with their paths.

### 1.6 Resolution and freezing (`gen/density/source.ts`, `gen/surface/source.ts`)

`resolveDensity(source, params) → DensityExpr` and `resolveRules(source, params) → Rule` run only on a tree that passed both tiers. Density, in order:
1. every `param` becomes `const(value)` (the q15-normalised leaf value, `kit.ts:193`, or the noise field);
2. every muted tap gets `x: const(mute)` (§1.5);
3. every `recip` becomes `const(1 / c)`;
4. **constant folding**, bottom-up: a node of op `add`, `mul`, `min`, `max`, `neg`, `abs`, `square` or `clamp` whose children are all `const` becomes `const(v)`, with v computed by `nodes.ts`'s own value functions (`nodes.ts:15-24`), so the folded value is the double the evaluators would compute. `tap`, `interpolated`, `slide`, `rangeChoice` and `ref` are never folded (taps stay addressable, `islands` is `tap(const)`; `interpolated` stays a placement boundary; refs stay refs and a def is folded inside itself).

Rules: every `{param, neg?}` field becomes its number (§1.3); nothing else changes.

- **Why fold.** It makes the resolved default the very tree the code builds (§2): the default's only all-constant subtrees are the ones the refs introduce. On edited trees folding changes no value; it can remove a position slot (a const never takes one, `compile.ts:19`), which narrows an early-out interval but never changes solidity.
- **Freeze (D10).** The resolver builds a fresh tree and deep-freezes it. `createDensityContext(ctx, expr = resolveDensity(ctx.params.density.defs, ctx.params))` and `createSurfaceContext(ctx, rules = resolveRules(ctx.params.surface.rules, ctx.params))` pass that frozen tree to the compiler and to the reference, so `dc.expr`, `sc.rules`, `compiled.rules` and `reference.rules` are one frozen object per context. This closes SP3c's parked aliasing minor (compiled closures bind fields at compile time, `compile.ts:245-318`, while the reference reads them at evaluation time, `reference.ts:131-138`; mutating `sc.rules` in place made hover and voxels disagree, measured 1,769 of 16,062 voxels, `map-surface.md` §5). Cloning inside `compileDensity` is rejected because `interpolatedSlot(e)` and the tests key on source identity (`compile.ts:106-107`, `436-437`; `densityCompile.test.ts:55`, `265-267`, `325`; `region.metric.ts:152-154`). The contexts assert that the tree they receive is frozen.
- New params mean a new `GenContext` (one per configured epoch, `taskHandler.ts:118-146`), so the `surfaceContextOf` WeakMap memo and the probe's one-column cache (`probe.ts:221-234`) start fresh after every edit; nothing else needs invalidating.

### 1.7 Validation

**Tier 1 — `checkJson` (core, `json.ts`), for both formats.** An iterative walk (explicit stack: it never overflows, whatever the input) that returns a fresh clone with object keys in sorted order (canonical order, so a tree loaded from a URL and one edited in memory iterate alike, `map-params.md` §7), or issues. Rules, each with its code at the offending path (written in the format's path syntax: the density value's JSON path; the rules' path with `root` for the value):

| rule | code |
|---|---|
| values are plain objects (prototype `Object.prototype` or null), arrays without holes, strings, finite numbers or booleans; no `null`, `undefined`, function or other object | `NOT_JSON` |
| numbers finite (`JSON.parse('1e999')` is Infinity) | `NOT_FINITE` |
| no −0 anywhere (`canonicalJSON` throws on it, `canonical.ts:27-28`; it is never normalised, so a typed −0 is reported) | `NEGATIVE_ZERO` |
| every object key matches `^[A-Za-z][A-Za-z0-9_]{0,31}$` (closes empty, dotted and `__proto__` def names, SP3b §13, `map-density.md` §1) | `BAD_KEY` |
| container depth ≤ 48, the value's top container being 1 | `TOO_DEEP` |
| ≤ 16,384 containers; arrays ≤ 1,024 items; strings ≤ 256 UTF-16 units | `TOO_LARGE`, `ARRAY_TOO_LONG`, `STRING_TOO_LONG` |
| `canonicalJSON(value)` ≤ 128 KiB (checked last, on the clone) | `TOO_LARGE` |

The depth bound keeps every `canonicalJSON` caller safe: the deepest caller puts the tree's top object at depth 3 (`draftKeyOf` and `encodeMapState`: top, `patch`, group, leaf), and a primitive at container depth 48 then sits at depth 51 ≤ 64 (`canonical.ts:20`; `map-params.md` §5), 13 levels of margin. Tier 1 runs inside `checkLeaf`, so `applyPatch`, `checkParams`, `buildSchema` (on the defaults), `importPreset`, `decodeMapState` and the session all get it; nothing downstream can make `canonicalJSON` throw on a json leaf.

**Tier 2 — `validateDensitySource` (gen).** On the tier-1 clone, collecting every issue, never throwing:
1. per-node structure, recursive within one tree (depth ≤ 48 by tier 1): `validateExpr`'s checks (`expr.ts:133-286`: ops, keys, fields, noises, names, `CLAMP_ORDER`, `RANGE_ORDER`, `KNOTS_*`, `DUPLICATE_TAP`, …) extended by a `source` mode that accepts `param`, `recip` and `tap.mute`; plus `UNKNOWN_PARAM` (a path not in the targets), `RECIP_OPERAND`, `RECIP_ZERO`; tap names match the key pattern (`BAD_NAME`); literals (`const.v`, `clamp`/`rangeChoice` bounds, knot values, `mute`) have |v| ≤ 1e9 (`LITERAL_RANGE`; the master's cave formulas use ±1e9 and ±1e6, master §3.6); every `slide` segment's `v1 − vk` and `(v1 − vk) / (y1 − yk)`, computed exactly as `slideAt` does (`nodes.ts:30-41`), are finite (`SLIDE_SLOPE`; SP3b §13; measured NaN for knots `[[0, −1e308], [1, 1e308]]`, `map-density.md` §2);
2. counts: ≤ 4,096 nodes (`TOO_MANY_NODES`, at `root`) and ≤ 64 defs (`TOO_MANY_DEFS`, at `defs`);
3. the def graph, by an iterative walk: `UNKNOWN_REF`, `REF_CYCLE`. The root's refs get their own bucket (the empty-name bug, `expr.ts:146-147`, `224-226`, is fixed in `validateExpr` itself; the key pattern also forbids empty names);
4. in topological order of the def graph (no recursion through refs): the **expanded depth** (depth counting through refs) ≤ 128 (`TOO_DEEP`, at the deepest node's path) and the **expanded cost** ≤ 65,536 (`TOO_COSTLY`, at `root`, message with the cost). Cost: 1 per node, plus its children's costs; a `ref` costs its def; `interpolated` costs 1 + 8 × its child (eight corners per voxel); additions saturate at 2^31. These bound what recurses through refs (the compiler, the reference, `exprHash`, the bounds, all measured to overflow beyond about 1,800-4,200 nested nodes on Node, `map-density.md` §1) and the reference's cost, which grows with the expanded tree (`reference.ts:84`, `107`; measured exponential with shared defs, `map-workers.md` §6);
5. only then the checks that walk through refs (`NESTED_INTERPOLATED`) and the **static magnitude analysis** (§1.9): `VALUE_RANGE` at the first node, in source DFS order, whose static interval leaves ±1e100.

**Tier 2 — `validateRulesSource` (gen).** `validateRules` (`rules.ts:175-319`; depth ≤ 32, ≤ 4,096 nodes, unchanged) extended by the ref form (`UNKNOWN_PARAM`, `PARAM_KIND` for a non-`int` target in an int field, `BAD_FIELD` for a malformed ref) with every value check over the ref's static range (`OUT_OF_RANGE` for an int field, `RANGE_ORDER`, `GRADIENT_ORDER`, as §1.3), literals |v| ≤ 1e9 (`LITERAL_RANGE`), `biome.biomes` ≤ 64 entries (a 200,000-entry list validates today, `map-surface.md` §1), and **`NOT_SOLID`**: a `block` whose state does not collide (`COLLIDE[state] === COLLIDE_NONE`, `world/blocks/kinds.ts:55-58`; today only `air`). The T stage derives `oceanFloorWG` from solidity on the assumption that every surface state collides (`terrainStage.ts:138-143`; SP3a §3.4's `OCEAN_FLOOR_WG = COLLIDE ≠ none`, `WORLD_SURFACE_WG = state ≠ air or fluid`), so a non-colliding rule result would break both heightmaps and the probe's own solidity check (`probe.ts:248`). `bandlands` yields terracottas only, which collide. The predicate is in `rules.ts` because it reads the registry; future non-cube colliding states (`boxes`) pass it. `validateRules` gains `NOT_SOLID` for every caller; the fuzz's random blocks already exclude air (`test/harness/surfaceFuzz.ts:201-203`) and the `sp3c.surface.ops` fixture tree names solid states only (asserted by a test).

`−0` stays valid in code-built density trees (`validateExpr` accepts it, pinned by `densityExpr.test.ts:89`); only json leaves (tier 1) reject it. Tree literals are not q15-quantised (`canonicalJSON` prints `String(v)`, a lossless round trip); only the parameter values that refs read are.

### 1.8 Where validation runs, and rejection (D2)

`validateParamTrees(params): Issue[]` (`gen/trees.ts`) runs both tier-2 validators on a params document and prefixes each issue with its leaf path. It runs:
- **in the session:** `WorldSession`'s constructor init (`session.ts:119`) gains `validateParams?: (params: Params) => readonly Issue[]`. `commitPatch`, `load` and `restore` call it after `applyPatch` succeeds; issues make the change fail exactly like an out-of-range value: `{ok: false, issues}` and nothing changes (`session.ts:275-280`), so the world keeps the last valid tree and the editor shows the error. Every page that creates a `WorldSession` passes `validateParamTrees` (an arch test greps `new WorldSession(` under `src/ui/`); `ui/` may value-import gen (`imports.ts:32`);
- **in the worker:** configure runs `checkParams` and then `validateParamTrees`, and replies `BAD_PARAMS` with the first 5 issues (`taskHandler.ts:134-135`), so an invalid tree can never become an `INTERNAL` error inside a job's lazy compile (`map-workers.md` §2). The session never sends one, so this is a guard against bugs;
- **in the editors**, as you type (§3.5), with the same function;
- URL and preset loads reach the session through `session.load` (`mapState.ts:96-104`, the presets tab's import), so a semantically invalid tree in a link or a file is refused with its paths, like any invalid value (the map notice prints `path code`, `mapState.ts:56`, `103`).

### 1.9 NaN-free values and sound bounds (D8)

Two measures, each closing a different gap.
- **Static (S): no NaN or ±∞ on a valid tree.** The master requires NaN-free generator outputs (master §3.17, line 862). Tier 2's magnitude analysis evaluates, once per node with a per-def memo, an interval of the node's possible values with the interval functions of `nodes.ts`, from: `y` ∈ [−64, 320] (corners reach `cornerY(48)` = 320, `nodes.ts:98`); `noise` and `noise2` ∈ [−8, 8] (clampSigma's static maximum); `const` exact; `param` its static range; `recip` as §1.4; a muted tap its mute; and every `col` field ∈ [−1e9, 1e9] (`COL_FIELD_BOUND`). A tree is rejected (`VALUE_RANGE`) when any node's interval leaves ±1e100; with literals ≤ 1e9 that leaves astronomical headroom under the largest double for `lerp`'s `b − a` and the interval widening, so every value of an accepted tree is finite as long as the ColumnSample fields stay within ±1e9. **That assumption is verified, not hoped for:** the plan's first density task bounds each of the 19 `SAMPLE_FIELDS` (`columnStage.ts:32-35`) from its formula in `gen/column/` for every schema-valid params document and records the argument beside `COL_FIELD_BOUND`; a field it cannot bound below 1e9 (for example `riverDist = |Rz| / max(gradLen, 1e-4)`, `rivers.ts:48`, if |Rz| is unbounded) is refused in edited trees (`VALUE_RANGE` at its `col` node) until the SP that bounds it. A unit test records the sampled maxima of every field over the DT2 columns.
- **Dynamic (D): sound early-outs whatever happens.** The interval ops pick endpoints with `<` and `>`, so a NaN endpoint is dropped (`ivMul`, `ivMin`, `ivMax`, `ivHull`, `ivAbs`, `ivSlideFactor`, the slot hulls; `nodes.ts:139-232`, `bounds.ts:148-207`), and infinities without NaN already break soundness (a tree that validates today makes `fillDensityColumn` mark a cell solid while the probe says air, `map-density.md` §2). Every interval op of `nodes.ts` and every hull of `bounds.ts` returns **UNKNOWN** = [−∞, +∞] when an input endpoint is non-finite or a result endpoint is NaN, explicitly (a test, not a comparison), and an op with an UNKNOWN input is UNKNOWN; `clamp` and `rangeChoice` never turn UNKNOWN into a known interval. `fillDensityColumn` already treats a root interval it cannot decide as undecided and evaluates the voxels (`bounds.ts:267`, `271`), so an UNKNOWN root is evaluated. With finite intervals (every default world) D changes nothing: the masks, values and goldens are unchanged. This is SP3b §13's "make the interval ops propagate NaN, or widen a NaN endpoint to [−∞, ∞]", applied to infinities too.

### 1.10 The fast-path depth contract (D11)

SP3c's fast path is correct only if every position's surfaceDepth ≤ SD_MAX (`compile.ts:334`, `391-399`). Two cheap guards close the cases the code allows (`map-surface.md` §6, measured 25,175 and 2,012 wrong voxels):
- `scanColumn` clamps Ns to ±the depth noise's clampSigma before using it (`scan.ts:196`). `NormalNoise.z2` already clamps to ±clampSigma (`core/noise/normal.ts:32-37`), so this is bit-identical for schema noises and only protects injected test noises;
- `surfaceScanSettings` (`scan.ts:116-124`) throws a RangeError for a `depthMul` that is negative or non-finite (the schema's [0, 2], `schema.ts:124`, never produces one).
A test compares fast and full `fillColumn` for both cases and asserts surfaceDepth ≤ SD_MAX on sampled columns.

### 1.11 `SCHEMA_VERSION` 2, migration and lock (D12)

- `SCHEMA_VERSION` 1 → 2 and `MIGRATIONS = [identity]` (`migrate.ts:10-12`): a version-1 document has neither leaf, and missing leaves take the profile's value. The bump is not required by the lock (added leaves are accepted at the same version, `schemaShape.ts:37-44`); it makes an older build reject a version-2 preset with `NEWER_SCHEMA_VERSION` instead of `params.density.defs: UNKNOWN_KEY`, and the shape lock's new `json:<format>` kinds are recorded at the new version.
- U4 requires the fixtures `test/fixtures/preset-v1.json` (a version-1 preset with a few leaves changed) and `test/fixtures/expected-v1.json` (its params after migration); neither exists today (`test/metrics/params.metric.ts:24-30`).
- `npm run test:accept-schema` records `schemaVersion: 2` and the two leaves; `npm run docs:params` refreshes the README block.
- URLs carry no schema version (`mapState.ts:23-29`, `v: 1`; `labState.ts:28`), so they cannot be migrated: an old `?map#` link loads because missing leaves are the profile's. Its `v` stays 1.
- Tests pinning the version move: `profiles.test.ts:47` (`MIGRATIONS.length` 1), `:105` (the "newer" version becomes 3), `presetFile.test.ts:85`, `:89` (export text `"schemaVersion": 2`), `:146` ("schemaVersion 3 is newer than this build (2)"); version-1 documents stay importable (`profiles.test.ts:74`, `presetFile.test.ts:27`, `:55`, `:124`). A new test loads `preset-v1.json` through `importPreset` and the session.

### 1.12 URL, preset and history size (D13)

Atomic diffs put a whole edited tree in the patch: one threshold change puts the 6.8 KB rule tree in the URL, the preset, the patch box and the history snapshot (measured: map URL 2,123 characters with the density tree edited, 11,221 with both, `map-params.md` §5; no URL length check exists). This is accepted: browsers take hashes far longer, the tier-1 cap (128 KiB canonical per tree) bounds the worst case, and the history holds at most 101 snapshots (`session.ts:46`) that share unchanged trees by reference (`kit.ts:472`). A finer diff inside json leaves would change `merge` semantics and is not built. uiSmoke records the URL length after its edits (§6).

## 2. The default trees as data (`core/params/defaultTrees.ts`)

Both defaults live in core as plain data (the schema needs them as leaf defaults and core cannot import gen, master §1). They are typed as core's `JsonValue`; gen narrows them after validation. The builders `defaultDensityExpr` (`gen/density/defaults.ts:31-45`) and `defaultSurfaceRules` (`gen/surface/defaults.ts:38-94`) move unchanged to `test/harness/legacyTrees.ts` as fixtures.

### 2.1 `DEFAULT_DENSITY_TREE`

Printed with `op` first for reading; the stored value has sorted keys (key order is not semantic). `SLIDE`, the floor and ceiling terms and `islands` are now data (master §3.6's "code, not data, until SP3d").

```
{ "root": { "op": "max",
    "a": { "op": "add",
      "a": { "op": "tap", "name": "terrain", "x": { "op": "interpolated", "x":
        { "op": "add",
          "a": { "op": "add",
            "a": { "op": "add",
              "a": { "op": "add",
                "a": { "op": "add",
                  "a": { "op": "col", "field": "offset" },
                  "b": { "op": "mul", "a": { "op": "col", "field": "jag" }, "b":
                    { "op": "square", "x": { "op": "add", "a": { "op": "const", "v": 1 }, "b":
                      { "op": "neg", "x": { "op": "abs", "x": { "op": "mul",
                        "a": { "op": "noise2", "id": "jag" },
                        "b": { "op": "recip", "x": { "op": "param", "path": "density.noises.jag.clampSigma" } } } } } } } } },
                "b": { "op": "neg", "x": { "op": "y" } } },
              "b": { "op": "mul", "a": { "op": "col", "field": "sigma" },
                     "b": { "op": "slide", "x": { "op": "noise", "id": "overhang" }, "knots": [[-64, 0], [-40, 1], [240, 1], [320, 0]] } } },
            "b": { "op": "mul", "a": { "op": "const", "v": 2 }, "b": { "op": "max", "a": { "op": "const", "v": 0 },
                   "b": { "op": "add", "a": { "op": "const", "v": -56 }, "b": { "op": "neg", "x": { "op": "y" } } } } } },
          "b": { "op": "neg", "x": { "op": "mul", "a": { "op": "const", "v": 2 }, "b": { "op": "max", "a": { "op": "const", "v": 0 },
                 "b": { "op": "add", "a": { "op": "y" }, "b": { "op": "const", "v": -296 } } } } } } } },
      "b": { "op": "mul", "a": { "op": "noise", "id": "detail" }, "b":
        { "op": "add",
          "a": { "op": "param", "path": "density.detailAmpLo" },
          "b": { "op": "mul",
            "a": { "op": "add", "a": { "op": "param", "path": "density.detailAmpHi" },
                   "b": { "op": "neg", "x": { "op": "param", "path": "density.detailAmpLo" } } },
            "b": { "op": "clamp", "x": { "op": "mul", "a": { "op": "add", "a": { "op": "col", "field": "E" }, "b": { "op": "const", "v": 1 } },
                   "b": { "op": "const", "v": 0.5 } }, "lo": 0, "hi": 1 } } } } },
    "b": { "op": "tap", "name": "islands", "x": { "op": "const", "v": -1000000 } } },
  "defs": {} }
```

This is `defaultDensityExpr` with exactly three substitutions: `C(1 / p.noises.jag.clampSigma)` → `recip(param density.noises.jag.clampSigma)`; `C(p.detailAmpLo)` → `param density.detailAmpLo`; `C(p.detailAmpHi − p.detailAmpLo)` → `add(param density.detailAmpHi, neg(param density.detailAmpLo))`. The sums stay left-nested in the written order (`defaults.ts:13-14`).

**Bit-identity.** For every schema-valid `params`, `resolveDensity(DEFAULT_DENSITY_TREE, params)` equals `legacyDefaultDensityExpr(params.density)` node for node and number for number (`Object.is`): §1.6 step 1 gives the same parameter doubles; step 3 computes `1 / cs` exactly as the builder; step 4 folds `neg(const lo)` to `const(−lo)` and then `add(const hi, const(−lo))` to `const(hi + (−lo))`, which is the builder's `hi − lo` (§1.4); no other subtree of the default is all-constant (every other `add`, `mul`, `max`, `neg`, `clamp` reads `y`, `col` or a noise, and `tap` is never folded). Equal trees compile to the same closures (51 nodes, 2 position slots, 2 column slots), the same bounds program and the same reference, so every value, early-out mask and voxel is unchanged. The test (§10) asserts, at `DEFAULTS` and at 64 random schema-valid density groups (`randomValue` per numeric leaf): equal `exprHash` (`expr.ts:302-332`), equal `canonicalJSON`, and equal compiled corner and voxel values (`Object.is`) at every cell of columns (0, 0), (5, −7) and (−68, 100) of seed '42'. `sp3b.density.default` (`sp3bGoldens.ts:122-134`) reads `createDensityContext(ctx42())`, so it now reads the resolved leaf and is unchanged.

### 2.2 `DEFAULT_SURFACE_RULES`

Exact derivation rule: the tree `defaultSurfaceRules(p)` builds (SP3c §4; at the defaults, `test/fixtures/sp3c-default-rules.json`), with the four parameter reads replaced by refs at the five places the builder writes them (`gen/surface/defaults.ts:42-43`, `84-85`):

| builder value | occurrences in the tree | becomes |
|---|---|---|
| `P.min = p.patchThreshold` | 10 (`noiseThreshold`, max 8) | `{"param": "surface.patchThreshold"}` |
| `Pn.max = 0 − p.patchThreshold` | 2 (`noiseThreshold`, min −8) | `{"param": "surface.patchThreshold", "neg": true}` |
| `steep.min = p.cliffSteep` | 1 | `{"param": "surface.cliffSteep"}` |
| `yAbove.minY = p.cliffMinY` | 1 | `{"param": "surface.cliffMinY"}` |
| `temperatureBelow.t = p.snowline` | 1 | `{"param": "surface.snowline"}` |

Every other number stays the literal of the fixture (the gradient bounds −64, −59, 0, 8; `Pn.min` −8 and `P.max` 8, `PATCH_LIMIT`; the `stoneDepth` and `water` offsets). The builder shares node objects (`P`, `Pn`, `TOP`, `SKIN`, `BAND4`, `LAKE`); the data has none, and compile and reference are insensitive to sharing (closures per path, identity-keyed prep maps, `map-surface.md` §6). Static ranges pass: `P` min ∈ [0, 3] ≤ 8; `Pn` max ∈ [−3, 0] ≥ −8; `cliffMinY` is an `int` leaf in [−64, 319].

**Identity test.** `canonicalJSON(resolveRules(DEFAULT_SURFACE_RULES, DEFAULTS))` equals the fixture file, and `resolveRules(DEFAULT_SURFACE_RULES, params)` equals `canonicalJSON(legacyDefaultSurfaceRules(params.surface))` for the variants of `surfaceDefaults.test.ts:83-120` (patchThreshold 0, which gives +0 in `Pn.max`, and every leaf at its range ends) and 64 random surface groups. Compiled states at every voxel of the three columns above are equal to the legacy tree's.

## 3. The inspector (the Density tab)

### 3.1 Placement and layout

- `DrawerTabId` gains `'density'`, appended last in `DRAWER_TAB_IDS` with the label "Density" (`layout.ts:15-17`), so the tab keys keep their order and the uiSmoke tabs step (Cross-section ← → Spline) stays valid (`uiSmoke.ts:831-837`). DOM ids follow `map-drawer-tab-density` / `map-drawer-tabpanel-density`.
- The tab body is a grid `220px | 280px | minmax(0, 1fr) | minmax(0, 1.2fr)`: **tree | node form | JSON editor | slice viewer**. Below 1,200 px of drawer width the last two columns become one with two sub-tabs, "Slice" (shown first) and "JSON". The drawer's height is the shared one (300 px by default, up to 60 % of the viewport, `layout.ts:23-35`).
- **State across tab switches.** Hidden drawer tabs keep their DOM (`hidden` attribute, `layout.ts:309`), so selection, expansion and the JSON buffer survive a switch. The scroll offsets of the tree, the form and the textarea are saved when the tab is hidden and restored when it is shown (whether the browser keeps `scrollTop` across `display: none` is not relied on, `map-ui.md` §2). Nothing is persisted across reloads (the layout stores no drawer tab, `layout.ts:160`).
- The same preset export/import, share URL, undo/redo and reset carry the edited trees: they are ordinary leaves of the session.

### 3.2 Tree

- Two roots: **Density** (`root`, then each def `defs.<name>` in key order) and **Surface rules** (`root`). A row shows the node's path tail, its op or kind and a short summary: `const 0.5`, `param density.detailAmpLo = 0.6`, `recip`, `noise overhang`, `col offset`, `slide 4 knots`, `tap terrain`, `ref base`; `sequence 3`, `if biome(desert, beach, …) → sand`, `if stoneDepth floor 0+sd`, `block grass_block`, `bandlands`. Conditions are rows of their rule (`.if`, `.if.if`).
- A tap row carries its mute toggle; a muted tap shows its value and its subtree dimmed.
- Rows are expandable; the initial expansion is three levels. The pure model (`ui/inspector/model.ts`) builds the rows from the session's current values; the DOM re-renders only when a key string changes (the spline drawer's precedent, `splineEditor/tree.ts:16-42`).
- **Selection** is (root, node path). After undo, redo, reset, load or a form edit that renumbers siblings, the selection follows the longest prefix of its path that still names a node (`followNode`, `splineEditor/model.ts:368-382`).
- Selecting a row highlights the node's text range in the JSON editor and scrolls to it; moving the caret in the editor selects the innermost node whose range contains it.

### 3.3 Node form

One field per scalar of the selected node: `const.v`, `clamp`/`rangeChoice` `lo`/`hi`, `slide` knots (a two-column table with add and remove), noise ids (a select of the schema's noises of the right dims), `col.field` (a select of `SAMPLE_FIELDS`), tap name and mute, def and ref names; for rules every field of `FIELDS` (`rules.ts:134-139`, exported): biome list, block state (a select of the colliding registry states), `side`, booleans and the numeric fields. Fields commit on `change` (Enter or blur; Escape restores; a refusal keeps the text red with the issue lines under it), as `valueField` does (`controls.ts:102-149`).

Every edit is a pure operation on the tree (`ui/inspector/form.ts`) that yields a candidate tree, then one `session.set('<leaf>', candidate)` through the page's `edit` wrapper (`mapPage.ts:83-89`): one undo step, the URL, the live preview. The session's refusal is shown as the issue lines and the selection is restored (the spline drawer's commit pattern, `drawer.ts:287-320`). Node-level paths are never session paths (`session.set` accepts schema paths only, `session.ts:60-64`).

Operations:
- **Param ref** (D4). A numeric field that can take a ref has a select "literal / <compatible targets>", each target listed with its current value. In density the select sits on `const.v`: choosing a target replaces the `const` node by `{op: 'param', path}`, and "literal" replaces a `param` node by `const(<its current value>)`. In rules it sits on each of the nine fields, with a "negate" checkbox. While a field is a ref the form shows the target's slider (the parameter panel's row, `controls.ts:168-219`); moving it sets the **target leaf** (`session.set(targetPath, v)`), exactly as the Parameters tab does.
- **Replace op / kind.** A select of the ops (density: every source op; rules: every rule kind for a rule node, every condition kind for a condition). Children are kept **by position**: the new op's child slots, in `EXPR_CHILD_KEYS` order (`expr.ts:56-61`), take the old node's children in their evaluation order; missing slots get `const 0`; extra children are dropped. Missing scalars take the op's defaults: `const` 0; `clamp` 0 … 1; `rangeChoice` 0 … 1; `slide` knots `[[-64, 0], [320, 1]]`; `noise`/`noise2` the first schema noise of its dims; `col` `offset`; `tap` a fresh name `tap<k>` (the smallest unused k ≥ 1); `ref` the first def; `param` the first target. Rules: `sequence` ↔ `condition` keeps the child (`rules: [then]` / `then: rules[0]` or an empty sequence) with `if: skyOpen`; `block` defaults to `stone`; condition defaults are `biome{[plains]}`, `stoneDepth{floor, 0, false}`, `water{0, false}`, `yAbove{63, false}`, `verticalGradient{0, 8}`, `steep{1}`, `noiseThreshold{surface.noises.patch, 0, 8}`, `temperatureBelow{0}`, and `not{<the old condition>}`. The per-kind defaults are exported from `rules.ts` beside `FIELDS`.
- **Wrap.** Density: wrap in a `tap` with a fresh name. Rules: wrap a rule in a one-child `sequence` (same result).
- **Delete.** Density: a node with one child slot (`neg`, `abs`, `square`, `clamp`, `slide`, `interpolated`, `tap`, `recip`) is unwrapped (replaced by its child); any other node is replaced by `const 0`; a def is removed (refused with `UNKNOWN_REF` if referenced). Rules: a child of a `sequence` is removed (later siblings renumber; the selection follows, §3.2); the root or a `then` becomes an empty `sequence` (yields nothing); a `not` is unwrapped; other conditions can only be replaced.
- **Add.** "Add def" (`def<k>` = `const 0`); "Add rule" appends `block stone` to a selected `sequence`.
- **Mute** (density taps): the toggle of §1.5.
- **Reset node** is not offered; "Reset" on the JSON editor resets the whole leaf (§3.5).

The form also shows the selected node's **value at the hovered voxel** (§3.6) and, for the tree as a whole, two lints (warnings, never refusals): "no fast path: every solid voxel is evaluated" when the resolved rules have none (SP3c §3.4; up to 4,096 nodes per voxel in the worst case, `map-surface.md` §4), and "density cost ≈ N × the default" when the expanded cost exceeds 4 × the default's.

### 3.4 Selected-node semantics

The value of a density node at a voxel is the reference evaluator's value of the node's **resolved subtree** (§1.6 applied to that subtree with the document's params; mutes inside it apply, a mute on an ancestor does not, since the node is evaluated itself), with the tree's resolved defs. Placement:
- a node with an `interpolated` ancestor in its tree is evaluated as `{op: 'interpolated', x: node}` at voxel placement, as the reference does for an inside tap (`reference.ts:122-126`); evaluated bare it would give the corner placement's number (`reference.ts:6-11`);
- a def, and a node inside it, takes the placement of the def's first reference in source DFS order (root first, then defs in key order), the rule `findTap` uses (`reference.ts:153-161`); an unreachable def is evaluated at voxel placement;
- the root is the final density, the tree's `voxel` value.
A rule node's "value" is a mask (§4.1).

### 3.5 JSON editor

- A textarea with the whole tree of the selected root (density or rules), printed by `printTree` (`ui/inspector/jsonText.ts`): two-space indentation; in each object `op` (or `kind`) first, then the scalar fields in their table order, then the children in evaluation order; `defs` keys sorted; a node without child nodes, and a number array (knots), on one line. `canonicalJSON`'s sorted keys (`op` last, `map-ui.md` §9) are not used for display.
- `parseTree` is an iterative JSON parser that returns the value, the text range of every node path, and syntax errors with their line and column (`JSON.parse` gives no offsets). The printer records the same ranges, so highlighting works on both printed and typed text.
- **Validate as you type** (150 ms debounce), without applying: parse, then tier 1 and tier 2 (the same `checkJson` and `validateParamTrees` functions the session uses), then the issues, one per line as `<node path>: CODE — message` (the leaf prefix removed). Clicking an issue selects its node and scrolls the text to it.
- **Apply** (and Ctrl+Enter) sends the parsed tree with one `session.set('<leaf>', value)`; an invalid tree is never sent, and if the session still refuses (it validates again) its issues are shown. **Reset** is `session.reset('<leaf>')`: the profile's tree (`session.ts:236-240`; the default for every profile ready in SP3d). **Escape** reverts the buffer to the current tree (the editor handles it and calls `preventDefault`, so the drawer stays open; `keys.ts:25-35`, `67`). Ctrl+Z inside the textarea is the browser's text undo, as for every text entry.
- **Dirty-buffer rule.** The buffer is replaced by the current tree only when that leaf's value changes and the buffer is clean (equal to the last printed text). If it is dirty when the leaf changes (an undo, a form edit, a preset load), the buffer is kept and a notice offers "Revert to the current tree". Changes to other leaves never touch it (unlike the presets patch box, which overwrites typed text on any patch change, `presetsTab.ts:165-211`).

### 3.6 Hover readouts

- **Map hover** while the Density tab is shown: the voxel (x, y, z) with x, z the hovered block and y the slice viewer's y control (63 by default, §4.2), whatever the plane.
- **Slice hover**: the sample under the pointer (§4.2); the readout shows its coordinate and the shown field's value (from the slice buffer: the same function computed it).
- The node form's "value at the hover" asks the worker for the selected node at that voxel with a `fieldProbe` job (§5.3), following the hover pattern of `createRuleReadout` (`voxels.ts:212-278`): one probe in flight, the latest voxel wins, replies are dropped when the session epoch or the voxel changed, `JobCancelled` at the same epoch asks again, other errors are shown as `failed: <message>`. A selected rule node shows the voxel's rule path from `surfaceProbe` and whether it passes through the node.
- Readouts wrap instead of being cut with an ellipsis: `.cs-readout` and the new readouts use `white-space: normal; overflow-wrap: anywhere` and carry the full text in `title` (closes the parked "hover id ellipsis" minor, `section.css:61`).

### 3.7 Map interaction while Density is shown

- The vertical plane is the cross-section's line (`section.line`, `section.ts:472-477`). `section` gains `onLineChange(listener)`, fired by `setLine`, so the Density view follows the line.
- A finished cut line sets the line and opens the Cross-section tab today (`mapPage.ts:211-213`); while Density is shown it sets the line and keeps Density shown. A click near the line opens Cross-section (`mapPage.ts:105`) unless Density is shown.
- With the horizontal plane selected, a map click (not near the line, cut tool not armed) sets the plane's centre instead of the pin (`mapPage.ts:106`). `mapView` gains `setSquare(square | null)`, which draws the horizontal plane's square as an overlay (`mapView.ts:138-193` draws the others).

## 4. Slice viewer

### 4.1 Fields

| field | planes | value per sample |
|---|---|---|
| `density` | vertical, horizontal | the final density: the resolved tree's root, by the reference evaluator |
| `node` (a density node selected) | vertical, horizontal | the selected node's value (§3.4), by the reference evaluator |
| `blocks` | vertical | the stored state and fluid of the voxel after the T stage (as the Voxels mode) |
| `rule` (a rule node selected) | vertical | 1 when the voxel's rule path (the reference walk, as `surfaceProbe`) passes through the selected rule; for a selected condition (`<ruleId>.if…`), 1 when that condition holds at the voxel; else 0 |

- All density fields use the reference evaluator, the root included, so a slice shows exactly what the hover probe gives at the same voxel (DT2 proves the compiled closures equal it, `region.metric.ts:216-234`); the reference is about 2.7 × slower than the closures (`map-workers.md` §7), within the budget (§9).
- The reference gains `nodeAt(id)` and `conditionHolds(id, scan, x, y, z)` (`reference.ts` already has the per-condition `holds`, `reference.ts:131-138`, and identity-keyed prep maps over its own frozen tree). Rule fields need the column's scan (density fill, water v0, biome buffer), which only vertical planes can afford; blocks need whole T columns. A horizontal plane offers `density` and `node` only (a horizontal block slice would need thousands of full columns).

### 4.2 Planes and samples (`workers/protocol.ts`)

- **Vertical:** along the cross-section's line A → B (any orientation; master §5.5's XY@z and ZY@x are its axis-aligned cases), y −64 … 319, with the sea-level line at 63. Sample (i, r), i, r ∈ 0 … n−1: the voxel (⌊xᵢ⌋, y_r, ⌊zᵢ⌋), with (xᵢ, zᵢ) = `segmentPointAt(segment, i, n)` (`metrics/crossSection.ts:70-75`, generalised to t = i/(n−1), its default n = 512 keeping every existing caller) and `y_r = 319 − ⌊(2r + 1) · 384 / (2n)⌋` (row centres: 318 … −63 at n = 128, 313 … −59 at n = 32). The segment rules are `segmentProblem`'s (`crossSection.ts:51-57`).
- **Horizontal:** XZ at y (integer, −64 … 319; 63 by default), centred on (cx, cz) (integers, set by a map click), extent E ∈ {256, 512, 1024, 2048, 4096, 8192} blocks (a select; 2048 by default). Sample (i, j): `x_i = cx − E/2 + ⌊(2i + 1) · E / (2n)⌋`, `z_j` alike (integers for every allowed E and n). The square must lie inside the world window: `cx − E/2 ≥ −2^19` and `cx + E/2 ≤ 2^19` (and for z); the UI clamps the centre, the worker refuses otherwise.
- **Resolution:** n = 128 (16,384 samples); on a change, first a draft at n = 32 (§4.5).
- The UI's hover, the worker and the pool use these functions from `protocol.ts`, so a pixel always names the voxel that was evaluated.

### 4.3 Drawing (`ui/inspector/sliceModel.ts`, `sliceView.ts`)

- **Colormap:** diverging, centred on 0: blue below 0, white at 0, red above, linear in `v / s` clamped to [−1, 1]. The scale s is `max(|p1|, |p99|)` of the shown values (auto), or a positive number the user fixes in a field next to an "Auto" checkbox. A non-finite value (never expected, §1.9) is drawn grey and counted.
- **Contour:** the 0 level (the density's surface: a voxel is solid when v > 0) drawn as line segments between samples where the sign of `v > 0` changes (marching squares on the sample grid), in an SVG overlay. The sea-level line (y 63) on vertical planes.
- **Histogram** beside the image: 64 bins over [p1, p99] (values outside fall in the end bins), and p1, p50, p99, sd and % < 0 printed. Percentiles are nearest-rank (`sorted[⌈q·N⌉ − 1]`), sd the population standard deviation, % < 0 the share of values below 0.
- `blocks` uses the Voxels palette and legend (`VOXEL_COLORS`, `section.ts:149-167`); `rule` two colours and the share of 1s.
- The canvas holds n × n pixels scaled by CSS with `image-rendering: pixelated` (as the Voxels image, `section.ts:134-139`); a slice of an older session epoch is dimmed with a "stale" label (`sectionView`, `crossSection/model.ts:201-218`).

### 4.4 Point samples for horizontal planes (D16)

At voxel (x, y, z) the reference reads ColumnSample fields only at the four quart corners of the voxel's cell: `interpolated` reads `s.f[field][latticeIndex(i, j)]` for i ∈ {ci, ci+1}, j ∈ {cj, cj+1}, ci = lx >> 2 (`reference.ts:81`), and an outside `col` reads the same four corners bilinearly (`readField`, `columnStage.ts:116-132`, whose clamp to 3 gives the same cell for lx 12 … 15). A horizontal sample therefore needs only those four lattice points, not a whole ColumnSample (49 points, 49 steep stencils, rivers, lakes and the biome pick, `columnStage.ts:64-106`). `buildCornerSample(ctx, x, z, withSteep)` fills them with `columnPoint` (`samplePoint`, `columnPoint.ts:60-77`), whose values equal the lattice's bit for bit (`columnStage.ts:1-5`, DT2's batch == point), and leaves the other lattice entries NaN; `withSteep` is true only when the evaluated subtree reads `col steep`. Measured (`map-workers.md` §7), a 128² horizontal slice at extent 8192 costs 7.0-7.2 s of whole ColumnSamples on one thread but 0.43 s with four-corner samples (1.44 s with steep). A test asserts, at 4,096 random voxels and for every `SAMPLE_FIELDS` field and both `withSteep` values, that the reference value from a corner sample is `Object.is`-equal to the one from the full ColumnSample; a field for which it is not is read from the full ColumnSample instead (a rule in `fieldSliceJob.ts`, pinned by the same test). Corner samples never enter the DensityContext's ColumnCache (`columnCache.ts:282-306`). Vertical planes use the ColumnCache's full samples (one per chunk column along the line).

### 4.5 Requests, draft and cancellation

- **What triggers a slice.** Every session edit (trees, sliders, mutes, seed, profile), a change of field, plane, line, centre, y, extent or selected node, and showing the tab. A slice for session epoch e can run only once the pool is configured with e's draft, so `DriverStatus` gains `sessionEpoch` (the session epoch of the draft the pool's last resolved configure holds; today `Cycle.sessionEpoch` is private, `previewDriver.ts:55-65`), and the view requests when that equals the session's epoch, not on `settled` as the cross-section does (`crossSection/model.ts:151-153`). During a gesture (a slider drag) only drafts are requested, since every draft configures the pool and aborts the previous epoch's jobs (`workerPool.ts:260-266`); the full slice follows the gesture's end.
- **Draft then full.** Each request runs a 32² draft first (priority 0; preview tiles take their distance in tiles, `viewMath.ts:31-38`, so the draft precedes all but the nearest ones), shown at once, then the 128² slice (priority 500, as stats and slices, `workerPool.ts:292`, `315`).
- **Cancellation.** Every new request supersedes the previous one: its queued parts are dropped (`JobCancelled`) through the handle `pool.fieldSlice` returns (`cancel()`; today only `cancelTiles` exists, `workerPool.ts:357-362`), and the results of parts already running are discarded by a request token. Running parts are not interrupted at the same epoch: the work bound (§5.2) keeps each part short, and a second abort cell would break the 4-byte abort protocol (`protocol.ts:114`, `protocol.test.ts:56`). A configure (new epoch) still aborts running parts through the existing cell, which `fieldSliceJob` polls once per sample column.
- The request stream is a pure model (`createFieldSliceRequests` in `sliceModel.ts`) with the cross-section streams' rules (`createLineRequests`, `crossSection/model.ts:115-172`): one result per (session epoch, request key), a token per request, `JobCancelled` keeps the last image silently, other errors show `failed`.

## 5. Worker jobs and probe changes

### 5.1 `fieldSlice` (`protocol.ts`, `fieldSliceJob.ts`, `taskHandler.ts`, `workerPool.ts`)

- `FieldSliceMsg {type: 'fieldSlice', jobId, epoch, plane: 'vertical' | 'horizontal', ax, az, bx, bz | cx, cz, y, extent, n, field: 'density' | 'node' | 'blocks' | 'rule', path, from, to}`. `path` is the node path inside its leaf ('' for `density` and `blocks`). `[from, to)` is a range of sample columns: point indices along A → B (vertical) or rows j (horizontal).
- `FieldSliceResultMsg {type: 'fieldSliceResult', jobId, epoch, from, to, values: ArrayBuffer, fluid: ArrayBuffer | null}`: Float64 values for `density` and `node` (8·n·(to − from) bytes), u16 states plus u8 fluid for `blocks` (2·n·(to − from) and n·(to − from)), u8 for `rule` (n·(to − from)), each sample column's n samples in row order.
- **Guards.** `parseToWorker` checks the shape (types, the plane's keys present and the other plane's absent, `path` a string ≤ 512 characters). The handler answers `BAD_ARGS` for: n ∉ {32, 128}; the segment (`segmentProblem`) or the square (§4.2) invalid, or non-integer coordinates; y not an integer in −64 … 319; extent not in the set; `blocks` or `rule` on a horizontal plane; a `path` that does not name a node of the right kind in the configured tree (`node`: a density node; `rule`: a rule or condition id); `0 ≤ from < to ≤ n` false; the work bound exceeded (§5.2, message `too heavy: …`). `parseFromWorker` checks the exact byte lengths for the request's field, as `sliceResult` does (`protocol.ts:212-221`).
- **Evaluation.** Per sample column: poll `stop()` (ABORTED on a new epoch), get the samples (vertical: the ColumnCache's ColumnSample of each chunk column; horizontal: corner samples, §4.4), evaluate. `node` and `density` use the GenContext's memoised DensityReference (§5.3); `blocks` uses the slice job's store and LRU (`sliceJob.ts:40-43`, `114-120`) with the §4.2 points; `rule` rebuilds the column's scan through `surfaceProbeColumn`'s one-column cache (consecutive points along the line share columns).
- **The pool.** `pool.fieldSlice(req, {priority, costPerSample}) → {promise, cancel}` splits [0, n) into contiguous parts (§5.2), enqueues them as one group (a failing part drops the others, `workerPool.ts:236-242`), merges them by index into one n × n buffer, and checks each part's range. `instrumentPool` forwards the new methods (`ui/map/perfHook.ts:203-231`). The handler gets an explicit branch per message type and an exhaustive `switch` (the last line today answers `pointResult` for anything that reaches it, `taskHandler.ts:191`).

### 5.2 The work bound (deterministic)

- **Cost per sample** = the evaluated subtree's expanded cost (§1.7) for `node` and `density`; the rule tree's node count for `rule`; 1 for `blocks` (whose cost is the T columns, bounded by n per part). The UI computes it (it holds the tree) and passes `costPerSample`; the worker recomputes it from its configured tree and refuses a part above the bound, so the client is not trusted.
- `PART_BUDGET = 2^22` cost units per part (one unit is one reference node evaluation, about 30 ns: the default's root costs about 260 units at 7.8 µs, `map-workers.md` §7; so ≤ about 125 ms per part) and `REQUEST_BUDGET = 2^27` per request (about 4 s of CPU over all workers), both in `protocol.ts`.
- **Split:** a part holds `k = max(1, ⌊PART_BUDGET / (n · cost)⌋)` sample columns; the number of parts is `max(poolSize, ⌈n / k⌉)` with equal contiguous ranges, never larger than k. A request is refused before any job when `n · cost > PART_BUDGET` (one sample column must fit a part) or `n² · cost > REQUEST_BUDGET`. Since tier 2 caps the cost at 65,536, a 32² draft always fits; a 128² slice is refused above cost 8,192 (32 × the default) and the view keeps the draft with the notice "node too heavy for a 128² slice (cost c)".
- So a heavy node never holds a worker longer than one part, and the map's preview tiles (priorities below 500, `viewMath.ts:31-38`) pass first in the queue.
- Determinism: the split depends only on (n, cost, pool size), and the merged buffer is independent of the split (a test, §10). A time budget would only be expressible in the worker layer and would cut work nondeterministically (`map-workers.md` §8); it is not used.

### 5.3 `fieldProbe` and the other probe changes (D17)

- `FieldProbeMsg {type: 'fieldProbe', jobId, epoch, field: 'density' | 'node' | 'rule', path, x, y, z}` → `FieldProbeResultMsg {type: 'fieldProbeResult', jobId, epoch, value: number}` (for `rule`, 0 or 1). BAD_ARGS for non-integer coordinates, a position outside the window, y outside −64 … 319 or a bad path; the reply guard requires a finite value. Like `surfaceProbe` it runs to the end and ignores the abort cell (one sample, ≤ 65,536 units plus one ColumnSample); `pool.fieldProbe(req, priority = −1)` is a single job. It evaluates exactly the function `fieldSlice` evaluates for one sample, so hover and slice agree.
- The worker memoises one `DensityReference` per GenContext (`densityReferenceOf(ctx)`, a WeakMap, built on `surfaceContextOf(ctx).density.expr`, the stage's own resolved tree); nothing memoises one today (`map-workers.md` §6).
- Configure validates the trees (§1.8). `surfaceProbe`, the compiled `probe` (`gen/density/probe.ts`, used by `surfaceEst3`) and the existing jobs are unchanged.

## 6. UI tests and the browser smoke

Pure modules, tested in vitest's node environment without a DOM (`vitest.config.ts:11`), in the SP2b style:
- `inspectorModel.test.ts`: rows and summaries of both default trees, expansion, selection following after undo and renumbering, the caret → node mapping;
- `inspectorForm.test.ts`: every operation of §3.3 on hand-built trees (positional replacement, defaults, unwrap, delete in a sequence and its renumbering, wrap, add def, refusal of a referenced def's deletion), the mute toggle's neutral values per parent, ref ↔ literal switches and `neg`;
- `jsonText.test.ts`: `printTree` ∘ `parseTree` is the identity on both defaults and on 200 fuzz trees; node ranges cover their text; syntax errors carry line and column; a 100,000-deep array is parsed without a stack overflow (and refused by tier 1);
- `jsonEditor.test.ts`: validate-as-you-type issues with paths, Apply / Reset / Escape, the dirty-buffer rule;
- `sliceModel.test.ts`: the §4.2 geometry (ends, integrality, window), colormap, contour segments, histogram statistics against hand-computed values, the request stream with a fake pool of deferred promises (draft then full, supersession cancels queued parts, stale and failed states, gestures draft-only), the work-bound split;
- `layout.test.ts` (the third drawer tab and its key order), `paramPanelModel.test.ts` (`PANEL_KINDS`, a control for every leaf), `previewDriver.test.ts` (`sessionEpoch`).

`test/tools/uiSmoke.ts` (headless Chrome, not in CI) gains, after the `rule` step and before `console`, so the existing history and "4 modified" checks stay: open the Density tab; select the `islands` const (`root.b.x`), edit it from −1e6 to −10 and wait for the density slice to change (its air values are now floored at −10; solidity is unchanged); mute `terrain` and wait for the slice to change; paste a broken JSON (an unknown op at the `islands` tap's child) and see the issue `root.b.x: UNKNOWN_OP` (`expr.ts:152` reports it at the node's path), while the map stays drawn; undo twice and see the default tree; record the URL length; a `--shots` screenshot of the Density tab with a vertical slice and a hover value.

## 7. Metrics

- **The world does not change.** DT1, T1-T5, S1-S3, B4, B2 and every 2D metric read the default worlds, whose trees resolve to today's (§2); their values are unchanged on every tier. The region caches go cold once, because genKey changes (§8).
- **U2** (D15). `u2Leaves` takes every terrain-stage leaf, so both new leaves are included (`liveness.ts:727-729`), and `perturbations` (`liveness.ts:202-233`) gains a `json` case:
  - `density.defs`: one variant, the default with the `terrain` tap muted (value 0, its toggle's value under `add`). Muting `islands` would not do: its toggle writes −1e6, its own value, and any other mute ≤ 0 leaves solidity unchanged (`max(x, m)` > 0 exactly when x > 0);
  - `surface.rules`: one variant, the default with the deepslate gradient's `falseAtAndAbove` 8 → 12 (`root.rules[2].if`), which dithers deepslate into the solid voxels at y 8 … 11 below the skin; the variant keeps a fast path (the gradient stays Y-only), as `maxSurfaceDepthOf` requires (`liveness.ts:557-561`).
  Both are decided on the land class column (their `intendedClass`, `liveness.ts:143-149`); `surface.rules` joins the land-served `surface.*` leaves of the slot test (`liveness.test.ts:263-270`). The leaves that the default trees now read through refs (`density.detailAmp*`, `surface.snowline`, `cliffSteep`, `cliffMinY`, `patchThreshold`) are still decided, since resolution substitutes their values. U2 stays 1 over 68 leaves. Master §6.4's U2 row is amended.
- **DT2** gains two exactness parts (activeFrom SP3d, max 0, each with a lock accept and a Threshold-log line), in the existing `metricTest('DT2', …)` call, drawn from their own stream `Xoshiro128(fnv1a32('DT2.edited'))` so the existing parts draw exactly as before (the precedent is `DT2.surface`, `region.metric.ts:236-243`):
  - `editedDensityReference`: per (profile, seed), edited density trees produced by `treeMutator` from the default (kept only when both tiers accept them; at most 64 draws per tree, else the part fails with "no valid edited tree"), and at each of the first DT2 columns the 16 DT2 voxels and the cell corners: compiled (a DensityContext on the resolved tree) ≠ reference, counted with `Object.is`; also counted: any non-finite value;
  - `editedSurfaceReference`: the same with edited rule trees, at the DT2 voxels plus 8 per column within maxSurfaceDepth of a sky-open top, compiled ≠ reference on the stage's scan (`terrainSurfaceDebug`, as `surfaceReference`).
  Trees and columns per (profile, seed): fast 2 trees × 8 columns, quick 8 × 32, full 16 × 64.
- **U4** passes with the version-1 fixtures and the export → import round trip (§1.11).

## 8. Goldens and `GENERATOR_VERSION` (D14)

- **`sp1.params` does not hash the live schema.** `paramsDigest()` hashes `stageHashes(FIXTURE_DEFAULTS, FIXTURE_STAGES)`, `genKey(SEED('42'), …)` and `paramsHash(FIXTURE_DEFAULTS)` (`src/metrics/sp1Goldens.ts:140-143`), where `FIXTURE_DEFAULTS` is the frozen 5-leaf fixture schema `PARAMS_FIXTURE` (`src/metrics/sp1Fixtures.ts:95-113`); `genKey` embeds `GENERATOR_VERSION` (`src/core/stage/hash.ts:30-34`). Adding `density.defs` and `surface.rules` to the live schema therefore cannot move it. The history agrees: `sp1.params` changed exactly at the four version bumps and stayed put across schema-only commits (`map-params.md` §0).
- **The rule, both ways.** SP3d changes no generation, so `GENERATOR_VERSION` stays 5 and `test/goldens.json` stays **byte-identical**: all 54 keys, `sp1.params` included. Conversely, `sp1.params` can only move with a `GENERATOR_VERSION` bump; if SP3d ever needed one (it does not), `sp1.params` would have to be the only changed key, which is how the brief's §4 phrased it. Any changed key in SP3d is a bug, and bumping the version to get past the merge's refusal (`test/harness/goldens.ts:72-90`) is forbidden (SP3c §7).
- **What does change, and is not pinned.** The live `terrain` stage hash slices the `density` and `surface` prefixes (`registry.ts:20`), so for the same seed `H.terrain`, `H.decorate`, `H.light`, `H.mesh` and genKey change; `H.climate`, `shape`, `surfaceEst`, `biome2d`, `lod` and `map` do not. No golden reads them (the region goldens hash voxels; tests compute hashes dynamically, `stage.test.ts:46-71`, `profiles.test.ts:34-40`); the harness region caches keyed by genKey miss once.
- `sp3b.density.default` follows the context's default, now the resolved leaf, identical (§2.1). `sp3b.density.ops` and `sp3c.surface.ops` are explicit fixture trees compiled by unchanged code (the root-bucket fix and `NOT_SOLID` do not touch them). `?selftest=1` in Chrome and Firefox and Bun check all 54 keys.

## 9. Bench

- **New rows**, appended to `BENCH_ROWS` after `surface.column` (`test/bench/gates.ts:16-21`):
  - `slice.vertical128`: one `fieldSlice` of field `density` at n = 128 on the uiSmoke mountain line A (−1664, 8) → B (−640, 8), all 128 sample columns as one part, run in-process on one thread by `fieldSliceJob`'s function, with a fresh GenContext per evaluation (cold caches: the case right after an edit). Its **absolute gate** is p50 ≤ 300 ms (`SLICE_V128_P50_MAX_MS`, master §7's inspector target; a new field of `AbsoluteLatencies` and `absoluteGateFailures`, `gates.ts:81-98`). Measured estimate 187-202 ms on one thread (`map-workers.md` §7); the pool split only makes the browser faster;
  - `slice.horizontal128`: the same for a horizontal plane centred on (0, 0), y 63, extent 8192, with corner samples (§4.4). Recorded and reported, ratio-gated like every row, with no absolute gate; estimated 0.56 s on one thread, about 0.1 s on 6 workers and 0.3 s on 2 (the brief's aim is < 1 s with all workers).
- **Pre-record run** (SP3a §7's procedure, against SP3c's baseline): `BENCH_EXEMPT=stageHashes.genKey,worker.configure npm run bench`. Both rows grow by design: `stageHashes.genKey` canonicalises the terrain slice, which grows from about 0.9 KB to about 9 KB with the two trees, and `worker.configure` now validates both trees (`map-tests.md` §G). Every other row must pass its +30 % gate, **`terrain.real` included** (the resolved tree is the same; the interval poison checks add one finiteness test per op per cell), and the absolute gates hold. Then `npm run bench:record`, and the exit run is a plain `npm run bench` against the new baseline. `benchGates.test.ts` pins the new rows and the new gate.

## 10. Tests (summary)

- **Unit, data model:** tier 1 (every rule of §1.7 with its code and path; the clone's key order; iterative on a 100,000-deep value; `undefined`); tier 2 for density (every code, the `param` targets and `UNKNOWN_PARAM`, `recip` operand and zero range, mutes, literal and value ranges, slide slope with the measured NaN knots, node, def, expanded depth and cost bounds, the three measured false `REF_CYCLE` trees of `map-density.md` §1 now valid) and rules (refs, `neg`, int fields, ranges over static ranges, `NOT_SOLID`, the `biomes` bound); resolution (substitution, `recip`, mutes, folding, never folding taps or `interpolated`, the frozen output); §2's identity tests; the interval poison (the measured unsound tree `max(add(Z, neg(Z)), 1)` with `Z = mul(mul(noise, 1e308), 1e308)`, built in code, now evaluates its voxels and agrees with the probe; finite trees give the old intervals); the fast-path guards (§1.10); the session refusing an invalid tree through the hook and keeping the last valid one, and `restore` staying valid; the worker's `BAD_PARAMS` at configure; `SCHEMA_VERSION` 2 and the fixtures; the README row; the panel control; the `sp3c.surface.ops` fixture's states all collide.
- **Fuzz of untrusted JSON** (`test/harness/treeMutator.ts`): mutations of both defaults and of the valid-by-construction fuzz trees (`densityFuzz.ts`, `surfaceFuzz.ts`): delete or add keys, swap ops and kinds, numbers set to −0, NaN, ±1e308, 1e9 + 1 and huge exponents, very deep and very wide nesting, arrays and strings in node slots, def names empty, dotted, `__proto__`, ref cycles, refs and param paths to missing or non-numeric targets, knots with overflowing slopes, air blocks. Each value is either rejected (never a throw; every issue's path starts with the leaf path and names a node or field of the value) or accepted, and then `canonicalJSON` succeeds, resolution succeeds, compiled == reference (`Object.is`) at sampled voxels and corners of two real columns, every value is finite, and for rules the fast path equals full evaluation. 2,000 mutated values per format on the unit tier.
- **Workers:** the protocol guards of the four new messages (`protocol.test.ts` pattern); `fieldSlice` split == single worker, bit-identical, for every field and plane at pool sizes 1, 2, 3 and 6 (`workerPool.test.ts:479` pattern) and in real worker threads (`test/integration/twoWorkers.test.ts` pattern); an in-flight part stops within 50 ms on configure (`test/integration/abort.test.ts` pattern); `fieldProbe` equals the slice's sample; corner samples equal full samples (§4.4); the work-bound refusal.
- **UI:** §6.
- **Metrics:** DT1, DT2 (with `editedDensityReference` and `editedSurfaceReference`), U2 with the two leaves, U4, and every SP3c and earlier row unchanged, on every tier.
- **Replaced** (pins SP3d changes): `densityDefaults.test.ts:32-75` (the builder's constants: now compared through `legacyTrees.ts`), `:322-342` (random density groups now include the default tree); `goldens.sp3b.test.ts:104-105` (its reference from the resolved default); `surfaceDefaults.test.ts:21-134` and `surfaceProbe.test.ts:36`, `99`, `106` (`defaultSurfaceRules` from `legacyTrees.ts` or the resolved leaf); `schemaSp3b.test.ts:12-18` and `schemaSp3c.test.ts` (the leaf lists gain the trees); `liveness.test.ts:120-123` (the density leaves' range loop skips the json leaf), `:263-270`, `:366` (surface 11 leaves), `:372` (density 6); `paramPanelModel.test.ts:41`, `:300-303`; `layout.test.ts` (three drawer tabs); `profiles.test.ts:19`, `:26-28`, `:47`, `:105`; `presetFile.test.ts:85`, `:89`, `:146`, `:147`, `:253` ("arrives in SP3e"); `test/arch/sp.test.ts:18-21`, `:23-30` (`currentSpOf([...upTo3b, 'SP4', 'SP3c', 'SP3d'])` is now 'SP3d'; the 'SP4' case needs SP3e too), `:32-43` (20 sub-projects, SP3e's deps), `:65-71` (SP3e may start alongside SP4); `benchGates.test.ts:15-23`, `:72-81`; `uiSmoke.test.ts` (new step names); `protocol.test.ts`. Unchanged: `densityFuzz.test.ts:52`'s `EXPR_OPS` coverage and `goldens.sp3b.test.ts:57` (source ops are not `EXPR_OPS`), `densityExpr.test.ts:89` (−0 in a code-built tree).
- **Arch:** `masterSpec.test.ts` gains the SP3d checks (the SP3d entry names this spec and has Deliverable, Exit and Cut line, and no "set by the SP3d spec"; an `SP3d:` list in §1's `test/` entry; §1's `gen/surface` entry names `source.ts`); the `WorldSession` hook grep (§1.8); headers on new files.

## 11. Exit criteria

| criterion | checked by |
|---|---|
| build, tests and full metrics with DT1, DT2 (`probeBulk`, `compiledReference`, `surfaceProbeBulk`, `surfaceReference`, `editedDensityReference`, `editedSurfaceReference`), U2 deciding both new leaves and every earlier leaf, U4, and every SP3c and earlier metric unchanged | `npm run build && npm test && npm run test:metrics:full` |
| CI green | GitHub Actions |
| the world unchanged: `GENERATOR_VERSION` 5, `test/goldens.json` byte-identical (54 keys, `sp1.params` included); `?selftest=1` all keys in Chrome and Firefox; Bun all keys | `git diff main -- test/goldens.json` empty, browsers, `npx --yes bun@1 test/tools/goldensJsc.ts` |
| the data defaults resolve to the code-built trees (same `exprHash` and canonical JSON, same values on real columns) | §2's tests |
| `SCHEMA_VERSION` 2: the lock accepted with `json:<format>`, the migration and both fixtures, an old preset and an old URL load | lock test, U4, unit tests |
| bench: every pre-SP3d row within +30 % except the two exempt rows, `terrain.real` included and ≤ 4 ms p50; `slice.vertical128` p50 ≤ 300 ms; `slice.horizontal128` recorded and reported; the exit run against the new baseline | `BENCH_EXEMPT=stageHashes.genKey,worker.configure npm run bench`, `npm run bench:record`, `npm run bench` |
| browser smoke: the Density steps of §6 | `node test/tools/uiSmoke.ts` |
| the user's visual review in production: edit a node, mute a tap, see the horizontal and the vertical slice, a broken JSON gives an error with its path without breaking the world | screenshots and the user's check |

The exit evidence goes under `## Exit evidence`, before the Threshold log, as SP3c.

**Cut line.** Pinned slices (up to 3 side by side, master §5.5) are built only if time allows, as the last task; a pin keeps its own plane, field and node and re-renders on every edit like the live slice. If the task is not started the pins go to SP10, which the master already names as their receiver; the decision is made when that task would start.

## 12. Governance

- **First commit** (the ordering hazard of `map-tests.md` §A.3: the three draft profiles would become selectable when `CURRENT_SP` reaches SP3d unless they move first): `'SP3e'` joins `SubProjectId` and `SUB_PROJECTS` after `'SP3d'` (`src/core/ids.ts:5-13`) and `SP_DEPS` as `SP3e: ['SP3d']` between SP3d and SP4 (`test/harness/sp.ts:4-24`; key order is `SP_ORDER`); the three profiles move to `readyFrom: 'SP3e'` (`profiles.ts:20-22`); `STARTED_SPS` gains `'SP3d'` and `CURRENT_SP` becomes `'SP3d'` (`currentSpOf` then gives SP3d, `sp.ts:43-50`); the pins of §10's "Replaced" list for these move; the ids comments (`ids.ts:1-3`, `16-19`) and `sp.ts:41` name the SP3e split; the master amendments of §14 that the arch tests check (§2.5's `SubProjectId`, the §10 headers) land in the same commit; `npm run test:accept-thresholds` (the lock's `startedSps` changes) and a Threshold-log line.
- **Locks.** The thresholds lock changes twice: `startedSps` (first commit) and the two DT2 parts (with their code); each commit that changes it adds one Threshold-log line naming everything it adds, and touches this spec in the same push (`test/harness/governance.ts:54-56`). The schema-shape lock is accepted at version 2 (§1.11). The state-id lock does not change.
- Bench gates live outside the thresholds lock; the new absolute gate is set by this spec and master §7 (`gates.ts:1`).
- `CLAUDE.md:9` and `README.md:9` ("SP3d (draft presets, inspector and slice viewer) … next") are updated in the first commit: SP3d is the editable trees and the inspector, SP3e the draft presets.

## 13. Notes handed to later SPs

- **SP3e (draft presets):** the three presets as overlays that may set `density.defs` and `surface.rules` (a profile overlay can hold a whole tree, so `session.reset` returns to the preset's tree); the islands term in `density.defs` (the `islands` tap is the hook: master §3.15's floating_islands term and its `islandMask` ColumnSample field); amplified's offset multiplier and the 320 range and archipelago's B1 ocean-cap gating (received from SP3a, moved from SP3d); the islands surface-rule branch and island-edge springs; Z1-Z3 measured on the drafts; per-preset goldens; widening the ref targets to the upstream groups if a preset needs them (§1.3); a `defs`-based restructuring of the default density if presets share terms.
- **SP6 (caves):** cave terms as taps of the editable tree (each muteable and sliceable here at once); the level fields' −∞ interval rule meets §1.9's UNKNOWN propagation (a level field must enter `COL_FIELD_BOUND`'s argument or stay unreadable in edited trees); cave floor and ceiling rules inserted before the deepslate rule (SP3c §11); the land-top y mod 16 residue of the density's 8-voxel cell layers (SP3c §11, its "SP3d / SP6" note), since SP3d does not change the density.
- **SP10:** the pins if cut (§11); the slice view of every 3D field and the 256² refinement (master §5.5, §7); the JSON editors of features and structures (master §5.5's list); a time-budgeted slice if a deterministic work bound proves too coarse in use. Inspector mutes are delivered by SP3d (§14).

## 14. Master-spec amendments made with this spec

Applied to the master when the user approves this spec; the arch-checked ones land in the first commit (§12).
- **§10 SP3d** becomes: `**SP3d — Editable density and surface rules, inspector and slice viewer** (M; SP3c). Spec: 2026-10-09-sp3d-editable-dag-inspector-design.md.`
  - `density.defs` and `surface.rules` as editable `json` leaves whose defaults are today's trees as data with parameter refs (SP3b's `SLIDE`, floor and ceiling terms and `islands` included), tap mutes, untrusted-JSON validation (canonical-safe bounds, refs over static ranges, NaN-free magnitude analysis, interval poison, no non-colliding rule states), `SCHEMA_VERSION` 2;
  - the Density tab of `?map`: tree, node form, JSON editor, hover value; the slice viewer (final density, any node, blocks and rule masks on vertical slices along the cut line, horizontal XZ slices of 256-8192 blocks; diverging colormap, 0-contour, histogram; a 32² draft then 128²) on the new `fieldSlice` and `fieldProbe` jobs;
  - **Deliverable:** editable terrain trees with live slices and the node inspector;
  - Received from SP3b (its spec §13): the validation of untrusted `density.defs` (delivered: §1.7, §1.9); from SP3c (its §11): `surface.rules` editable, non-colliding states rejected, the fast-path contract;
  - **Exit:** as the SP3d spec §11;
  - **Cut line:** inspector pins (→ SP10).
- **§10 SP3e** (new, after SP3d): `**SP3e — Draft presets** (M; SP3d)`: draft `floating_islands`, `amplified` and `archipelago` presets on the editable DAG (terms, splines and params; the islands surface-rule branch and island-edge springs), so per-preset goldens and SP11's LOD island scan have a target; their profiles become selectable (`readyFrom: 'SP3e'`); Z1-Z3 measured on the drafts (SP12 stays their final gate); **Deliverable:** the three selectable draft presets; Received from SP3a (its spec §10, moved from SP3d): archipelago (≈ 60 % ocean) against B1's 45 % ocean-family cap (decide per-preset gating), amplified's offset multiplier and the 320 range; **Exit:** set by the SP3e spec; **Cut line:** set by the SP3e spec.
- **§10 split note** (after the SP3b one): "SP3d was split on 2026-10-09 into SP3d (editable density and surface rules, inspector and slice viewer) and a new SP3e (the draft presets), at the user's request (the SP3d spec's Decision 1). SP3e depends on SP3d; SP3c, SP3d and SP3e can run alongside SP4."
- **§10 cut-line receivers:** "SP3b worker-split slice → SP3d" becomes "SP3b worker-split slice → SP3d (delivered in SP3b, so nothing moved)"; SP3b's entry cut line likewise; "SP3d inspector pins → SP10" stays.
- **§10 SP10:** "inspector mutes and pins" becomes "inspector pins (mutes delivered by SP3d)". **§10 SP12:** the continental profile "may move to SP3b or SP3d" becomes "may move to SP3e".
- **§10 parallelism:** "SP3c and SP3d alongside SP4" becomes "SP3c, SP3d and SP3e alongside SP4". The critical path is unchanged.
- **§2.5:** `SubProjectId` gains `'SP3e'` after `'SP3d'` (arch-checked); `ParamMeta.kind` replaces `'expr'|'ruleTree'` by `'json'` and `ParamMeta` gains `format?: 'density'|'surfaceRules'` (json leaves only); after the SP3b op note: "SP3d adds the source-only ops `param` (a numeric `density.*`/`surface.*` leaf or a noise `clampSigma`) and `recip` (of a constant) and tap `mute`, resolved to the ops above before compilation (amended by SP3d)."
- **§2.7:** presets carry `schemaVersion` 2 (identity migration from 1); an edited tree travels whole in the URL and presets (atomic leaf, ≤ 128 KiB).
- **§3.6:** "`islands` is −1e6 except in the floating_islands preset" gains "(SP3e)"; "Code, not data, until SP3d: …" becomes "**As built by SP3d:** the expression is the `density.defs` leaf, with `SLIDE`, the floor and ceiling terms and `islands` = −1e6 as data and `1/clampSigma`, `detailAmpLo` and `detailAmpHi − detailAmpLo` as refs; the SP3d spec §1-§2 hold the exact rules."
- **§3.11:** "the tree's structure is code until SP3d makes `surface.rules` an editable leaf" becomes "the tree is the `surface.rules` leaf, its four tunables read through refs, and its block states must collide (amended by SP3d)".
- **§3.15:** the amplified, archipelago and floating_islands rows are drafted in SP3e and finalised in SP12.
- **§5.5:** the inspector is the `?map` Density tab (tree of `density.defs` and `surface.rules`, node form with param refs, JSON editors for both with validation); slice planes are vertical along the cut line (XY@z and ZY@x being its axis-aligned cases) and XZ@y with extent 256-8192; a 32² draft then 128²; the histogram as listed; a mute toggle per tap (SP3d); up to 3 pinned slices (SP3d's cut line, else SP10); the slice view's SP3d fields are the final density, any density node, blocks and rule masks (vertical), the other fields arriving with their SPs; the hover value comes from the `fieldProbe` worker job.
- **§6.4:** U2's row gains "SP3d: a `json` leaf's perturbation is pinned per leaf (`density.defs`: the `terrain` tap muted to 0; `surface.rules`: the deepslate gradient's upper bound 8 → 12), decided on the land column (amended by SP3d)"; DT2's row gains "SP3d: `editedDensityReference` and `editedSurfaceReference` count compiled ≠ reference on edited trees (amended by SP3d)"; Z1-Z3 are first measured on SP3e's drafts.
- **§7:** "Inspector slice: 128² first in ≤ 300 ms, refined to 256²" becomes "Inspector slice: a 32² draft, then 128² with the vertical slice ≤ 300 ms p50 on one thread (bench row `slice.vertical128`); the horizontal 128² at extent 8192 is reported (`slice.horizontal128`); the 256² refinement is SP10's."
- **§1 (module layout):** `core/params/` adds `json.ts` and `defaultTrees.ts`; `gen/density/` replaces `defaults.ts` by `source.ts`; `gen/surface/` replaces `defaults.ts` by `source.ts` (arch-checked); `gen/trees.ts` is added; `workers/` adds `fieldSliceJob.ts`; `ui/inspector/*` (already reserved) is the Density tab; the `test/` entry adds "SP3d: harness/legacyTrees.ts, harness/treeMutator.ts, fixtures/preset-v1.json, fixtures/expected-v1.json".

## Threshold log

(One line per commit that changes `test/thresholds.lock.json`.)
