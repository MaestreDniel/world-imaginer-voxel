export const spawn = () => new Worker(new URL('../workers/task.worker.ts', import.meta.url), { type: 'module' });
