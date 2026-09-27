import { defineConfig } from 'vite';

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const extraHosts = (process.env.VITE_ALLOWED_HOSTS ?? '').split(',').filter((h) => h.length > 0);

export default defineConfig({
  server: {
    port: 5183,
    strictPort: true,
    headers: ISOLATION_HEADERS,
    allowedHosts: ['world-imaginer-voxel', ...extraHosts],
  },
  preview: { port: 5183, strictPort: true, headers: ISOLATION_HEADERS },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1024 },
});
