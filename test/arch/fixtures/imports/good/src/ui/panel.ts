import { start } from '../render/renderer';
import { spawn } from '../engine/workerPool';
export const boot = () => [start(), spawn()];
