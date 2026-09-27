/** Capability probe: proves this worker is cross-origin isolated and shares memory with the page. */
interface ProbeRequest {
  sab: SharedArrayBuffer | null;
}

self.onmessage = (event: MessageEvent<ProbeRequest>) => {
  const { sab } = event.data;
  if (sab !== null) Atomics.store(new Int32Array(sab), 0, 42);
  postMessage({ isolated: self.crossOriginIsolated });
};

// When the page is isolated but this worker script is served without COEP, the browser
// cannot deserialize the SharedArrayBuffer onto the worker global: `onmessage` never runs
// and a `messageerror` fires instead. Reply anyway so the page's probe doesn't hang until
// its timeout; the page's own Atomics check then correctly yields sabShared=false.
self.onmessageerror = () => postMessage({ isolated: self.crossOriginIsolated });

export {};
