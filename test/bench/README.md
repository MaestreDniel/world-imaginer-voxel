Benchmarks (`*.bench.ts`) live here and run with `npm run bench`. Vitest 5 benches use the test-context fixture: `test('<id>', async ({ bench }) => { await bench('<name>', fn).run() })`.
