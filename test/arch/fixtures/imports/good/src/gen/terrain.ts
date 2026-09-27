import type { ColumnWriter } from '../world/store/api';
import { STONE } from '../world/blocks/registry';
export const fill = (w: ColumnWriter) => w.size + STONE;
