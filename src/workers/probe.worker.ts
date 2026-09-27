/** Capability probe: proves this worker is cross-origin isolated and shares memory with the page. */
interface ProbeRequest {
  sab: SharedArrayBuffer | null;
}

self.onmessage = (event: MessageEvent<ProbeRequest>) => {
  const { sab } = event.data;
  if (sab !== null) Atomics.store(new Int32Array(sab), 0, 42);
  postMessage({ isolated: self.crossOriginIsolated });
};

export {};
