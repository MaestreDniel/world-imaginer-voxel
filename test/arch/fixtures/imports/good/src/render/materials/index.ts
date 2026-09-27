import { PACK_LAYOUT } from '../../mesh/packing';
import { ShaderMaterial } from 'three';
export const make = () => new ShaderMaterial({ defines: { BITS: PACK_LAYOUT.layerBits } });
