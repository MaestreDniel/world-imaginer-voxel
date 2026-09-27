import { PAD } from '../world/store/padded';
import type { ColumnWriter } from '../world/store/api';
export const mesh = (w: ColumnWriter) => w.size + PAD;
