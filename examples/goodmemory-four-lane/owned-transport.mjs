/** Research-only transport lifetime ownership; no ambient fetch or credential handling. */
const unavailable = () => { throw new Error('Configured research transport unavailable.'); };
const ensure = condition => { if (!condition) unavailable(); };

/**
 * Hold ownership through real fetch settlement and response-reader cancellation/release.
 * Timeout may stop the caller waiting, but waitUntilIdle does not infer abort completion.
 * A never-settling dependency keeps its slot forever; synchronous JavaScript is not preempted.
 */
export function createOwnedTransport(transport, maxBytes) {
  let pending = 0;
  const waiters = new Set();
  return Object.freeze({
    async fetch(url, init) {
      ensure(init && !init.signal?.aborted && pending === 0);
      pending++;
      let reader;
      try {
        const response = await transport(url, { ...init, redirect: 'error' });
        ensure(response instanceof Response);
        // Acquire an available reader before testing a late abort so its cleanup remains owned.
        if (response.body) reader = response.body.getReader();
        ensure(!init.signal?.aborted);
        if (!response.ok) return new Response(null, { status: response.status });
        ensure(reader);
        const chunks = []; let length = 0;
        while (true) {
          ensure(!init.signal?.aborted);
          const item = await reader.read();
          ensure(!init.signal?.aborted);
          if (item.done) break;
          length += item.value.byteLength;
          ensure(length <= maxBytes);
          chunks.push(item.value);
        }
        const body = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return new Response(body, { status: response.status, headers: response.headers });
      } catch { unavailable(); }
      finally {
        let cleanupFailed = false;
        try {
          if (reader) {
            try { await reader.cancel(); } catch { cleanupFailed = true; }
            finally { try { reader.releaseLock(); } catch { cleanupFailed = true; } }
          }
        } finally {
          pending--;
          if (pending === 0) { for (const resolve of waiters) resolve(); waiters.clear(); }
        }
        if (cleanupFailed) unavailable();
      }
    },
    async waitUntilIdle() {
      if (pending > 0) await new Promise(resolve => waiters.add(resolve));
    },
  });
}
