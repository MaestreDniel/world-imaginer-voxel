/**
 * The store spike's worker logic (SP4a spec §1.2 item 6, ruling P18), pure like `taskHandler.ts`: no `self`, no
 * `postMessage` and no `node:` import, so `spikeStore.worker.ts` wires it in the browser and `buildNodeTaskWorker` in
 * Node. The attached store lives in the closure between `spikeWrite` and `spikeCrossRead`. `handle` never throws:
 * every failure is a string in the reply's `errors`.
 */
import { attachStore, type VoxelStore } from '../world/store/store';
import { parseSpikeStoreToWorker, spikeColumnProblem, spikeSectionFill, type SpikeStoreFromWorker } from './protocol';

const MIB = 1 << 20;
/** The epoch the spike's columns are claimed under. */
const SPIKE_EPOCH = 1;

const text = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function createTaskHandler(): { handle(raw: unknown): { msg: SpikeStoreFromWorker; transfer: Transferable[] } } {
  let store: VoxelStore | null = null;
  const blocks = new Uint16Array(4096);
  const fluid = new Uint8Array(4096);

  const write = (s: VoxelStore, index: number, columns: number): SpikeStoreFromWorker => {
    const errors: string[] = [];
    for (let cz = 0; cz < columns; cz++) {
      try {
        const w = s.claimColumn(index, cz, SPIKE_EPOCH);
        for (let sy = 0; sy < 24; sy++) {
          spikeSectionFill(index, cz, sy, blocks, fluid);
          w.setProto(sy, blocks, fluid);
        }
        w.commit(1);
      } catch (e) {
        errors.push(`worker ${index}: column (${index}, ${cz}): ${text(e)}`);
      }
    }
    return { type: 'spikeWritten', index, blockMiB: s.blockPool.buffer.byteLength / MIB, byteMiB: s.bytePool.buffer.byteLength / MIB, errors };
  };

  return {
    handle(message) {
      const m = parseSpikeStoreToWorker(message);
      if (m === null) return { msg: { type: 'spikeCrossChecked', ok: 0, total: 0, errors: ['bad message'] }, transfer: [] };
      if (m.type === 'spikeWrite') {
        try {
          store = attachStore(m.handles);
        } catch (e) {
          return { msg: { type: 'spikeWritten', index: m.index, blockMiB: 0, byteMiB: 0, errors: [`worker ${m.index}: attach: ${text(e)}`] }, transfer: [] };
        }
        return { msg: write(store, m.index, m.columnsPerWorker), transfer: [] };
      }
      const errors: string[] = [];
      let ok = 0;
      if (store === null) return { msg: { type: 'spikeCrossChecked', ok: 0, total: m.columnsPerWorker, errors: ['cross read before attach'] }, transfer: [] };
      for (let cz = 0; cz < m.columnsPerWorker; cz++) {
        try {
          const problem = spikeColumnProblem(store.proto(m.cx, cz), m.cx, cz);
          if (problem === null) ok++;
          else errors.push(problem);
        } catch (e) {
          errors.push(`column (${m.cx}, ${cz}): ${text(e)}`);
        }
      }
      return { msg: { type: 'spikeCrossChecked', ok, total: m.columnsPerWorker, errors }, transfer: [] };
    },
  };
}
