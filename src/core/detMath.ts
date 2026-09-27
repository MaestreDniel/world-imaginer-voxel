/**
 * Deterministic transcendentals (SP1 spec §1.5, Appendix A). Only IEEE + − × ÷, Math.abs/floor/trunc,
 * int32 & and |, and one exact 2^k table. The operation order is part of the contract: do not
 * reassociate, factor or "simplify" any expression. Coefficients are shortest round-trip literals
 * with their bit patterns in comments (checked by T-DM7).
 */
const INV_PIO2 = 0.6366197723675814; // 0x3FE45F306DC9C883
const PIO2_1 = 1.5707963267341256; // 0x3FF921FB54400000 (31 significant bits)
const PIO2_2 = 6.077100506303966e-11; // 0x3DD0B4611A600000 (32 significant bits)
const PIO2_3 = 2.0222662487959506e-21; // 0x3BA3198A2E037073
const S1 = -0.16666650669294172; // 0xBFC55553FDCAD915
const S2 = 0.00833197866315709; // 0x3F81105B3EF42E99
const S3 = -0.00019495636237669298; // 0xBF298DA666AF25D2
const C1 = -0.49999999725108224; // 0xBFDFFFFFFD0C621C
const C2 = 0.041666623324344655; // 0x3FA55553E1068F2D
const C3 = -0.001388676379438054; // 0xBF56C087E89A3DB8
const C4 = 0.00002439045070398889; // 0x3EF99343027DE200
function kSin(r: number): number { const z = r * r; return r * (1 + z * (S1 + z * (S2 + z * S3))); }
function kCos(r: number): number { const z = r * r; return 1 + z * (C1 + z * (C2 + z * (C3 + z * C4))); }
const TRIG_MAX = 2097152; // 2^21
export function detSin(x: number): number {
  if (!(Math.abs(x) <= TRIG_MAX)) return NaN;
  const t = x * INV_PIO2;
  const k = Math.trunc(t < 0 ? t - 0.5 : t + 0.5);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const q = k & 3;
  const v = (q & 1) === 0 ? kSin(r) : kCos(r);
  return (q & 2) === 0 ? v : -v;
}
export function detCos(x: number): number {
  if (!(Math.abs(x) <= TRIG_MAX)) return NaN;
  const t = x * INV_PIO2;
  const k = Math.trunc(t < 0 ? t - 0.5 : t + 0.5);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const q = (k + 1) & 3;
  const v = (q & 1) === 0 ? kSin(r) : kCos(r);
  return (q & 2) === 0 ? v : -v;
}
const LOG2E = 1.4426950408889634; // 0x3FF71547652B82FE
const LN2 = 0.6931471805599453; // 0x3FE62E42FEFA39EF
const LN2_HI = 0.6931471803691238; // 0x3FE62E42FEE00000 (fdlibm ln2_hi)
const LN2_LO = 1.9082149292705877e-10; // 0x3DEA39EF35793C76
const TWO_1023 = 8.98846567431158e+307; // 0x7FE0000000000000
const E1 = 1.0000000321650302; // 0x3FF0000008A25D32
const E2 = 0.4999999420905273; // 0x3FDFFFFFC1D1F721
const E3 = 0.1666643126270281; // 0x3FC5554196125B1D
const E4 = 0.04166800203473628; // 0x3FA55582240EC5EC
const E5 = 0.008374155305794656; // 0x3F812678195C2FBD
const E6 = 0.0013843653543488235; // 0x3F56AE72FB0C97F2
const POW2 = new Float64Array(2099); // POW2[k + 1075] = 2^k, k in [-1075, 1023]; entry 0 = +0
{ let v = 1; for (let k = 0; k <= 1023; k++) { POW2[k + 1075] = v; v = v * 2; } v = 0.5; for (let k = -1; k >= -1075; k--) { POW2[k + 1075] = v; v = v * 0.5; } }
function kExp(r: number): number { return 1 + r * (E1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * E6))))); }
function scale(p: number, k: number): number { return k > 1023 ? p * 2 * TWO_1023 : p * POW2[k + 1075]; }
export function detExp(x: number): number {
  if (!(x >= -745.1332191019412)) return x !== x ? x : 0;
  if (x > 709.782712893384) return Infinity;
  const k = Math.floor(x * LOG2E + 0.5) | 0;
  const r = (x - k * LN2_HI) - k * LN2_LO;
  return scale(kExp(r), k);
}
export function detExp2(x: number): number {
  if (!(x >= -1075)) return x !== x ? x : 0;
  if (x >= 1024) return Infinity;
  const k = Math.floor(x + 0.5) | 0;
  return scale(kExp((x - k) * LN2), k);
}
const A1 = 0.0705240212098103; // 0x3FB20DDCBCADB52A
const A2 = 0.042269704761099335; // 0x3FA5A45FEF1EF97B
const A3 = 0.009321899859670404; // 0x3F83175C38455E5B
const A4 = 0.00005736618267948212; // 0x3F0E138F072D7DE3
const A5 = 0.00036130633257334846; // 0x3F37ADB6E1DA7EEC
const A6 = 0.000007131023504472914; // 0x3EDDE8E0D0B60ED0
const A7 = 0.000005746614264949733; // 0x3ED81A614D191411
export function detErf(x: number): number {
  const a = Math.abs(x);
  const q = 1 + a * (A1 + a * (A2 + a * (A3 + a * (A4 + a * (A5 + a * (A6 + a * A7))))));
  const q2 = q * q; const q4 = q2 * q2; const q8 = q4 * q4; const q16 = q8 * q8;
  const r = 1 - 1 / q16;
  return x < 0 ? -r : r;
}
export function detSmoothstep(e0: number, e1: number, x: number): number { // precondition e0 < e1
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
