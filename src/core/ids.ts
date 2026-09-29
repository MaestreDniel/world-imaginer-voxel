/** Sub-project ids of master spec §10 (SP2 split into SP2a and SP2b on 2026-09-28). */
export type SubProjectId =
  | 'SP0' | 'SP1' | 'SP2a' | 'SP2b' | 'SP3' | 'SP4' | 'SP5' | 'SP6' | 'SP7'
  | 'SP8a' | 'SP8b' | 'SP8c' | 'SP9' | 'SP10' | 'SP11' | 'SP12';

/** Every sub-project in master §10 order. */
export const SUB_PROJECTS: readonly SubProjectId[] = [
  'SP0', 'SP1', 'SP2a', 'SP2b', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7', 'SP8a', 'SP8b', 'SP8c', 'SP9', 'SP10', 'SP11', 'SP12',
];

/** The sub-project this build belongs to; hides profiles whose readyFrom comes later (SP2a spec §4.4). */
export const CURRENT_SP: SubProjectId = 'SP2a';

/** Every metric id of master spec §6.4 (E1-E6 expanded). */
export type MetricId =
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6'
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8'
  | 'B1' | 'B2' | 'B3' | 'B4' | 'B5'
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
  | 'A1' | 'A2' | 'A3' | 'A4'
  | 'S1' | 'S2' | 'S3'
  | 'O1' | 'O2'
  | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6'
  | 'X1' | 'X2'
  | 'DT1' | 'DT2'
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7'
  | 'L1' | 'L2' | 'L3'
  | 'F1' | 'F2' | 'F3'
  | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7'
  | 'U1' | 'U2' | 'U3' | 'U4'
  | 'Z1' | 'Z2' | 'Z3' | 'Z4'
  | 'P1'
  | 'G1' | 'G2'
  | 'M1'
  | 'AU1' | 'AU2' | 'AU3' | 'AU4';

/** Invalidation scope of a parameter (master §5.1). */
export type RegenScope = 'live' | 'remesh' | 'decorate' | 'terrain' | 'climate';

/** Generation and derived stages (master §2.5, SP1 spec §5). */
export type StageId = 'climate' | 'shape' | 'surfaceEst' | 'biome2d' | 'terrain' | 'decorate' | 'light' | 'mesh' | 'lod' | 'map';
