/** Research-only configuration seam. Explicit host source inspector and transport are mandatory. */
import { JevDecisionProvider } from '../../dist/jev.js';
import { createSourceBoundAdvisor } from './source-gate.mjs';
import { createOwnedTransport } from './owned-transport.mjs';

const fail = code => { const error = new Error('Configured research advisor unavailable.'); error.code = code; throw error; };
const ensure = (condition, code = 'invalid_config') => { if (!condition) fail(code); };
function plain(value, code) {
  try { ensure(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code); }
  catch { fail(code); }
}
function data(value, key, code) {
  try { const property = Object.getOwnPropertyDescriptor(value, key); ensure(!property || 'value' in property, code); return property?.value; }
  catch { fail(code); }
}
function keys(value, allowed, code) {
  try { ensure(Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)), code); }
  catch { fail(code); }
}

/**
 * A config object, not an ambient file loader. Enabled advice transmits only host-prepared facts.
 * Creating an advisor never calls inspectCurrent or fetch. The caller must own/approve both.
 * Returns the existing source-gated research evaluator, never any storage/execute capability.
 */
export function createConfiguredSourceBoundAdvisor(config, dependencies) {
  if (config === undefined) return Object.freeze({ enabled: false });
  plain(config, 'invalid_config');
  const enabled = data(config, 'enabled', 'invalid_config');
  if (enabled === undefined || enabled === false) return Object.freeze({ enabled: false });
  ensure(enabled === true);
  keys(config, ['enabled', 'apiKeyEnv', 'model', 'endpoint', 'timeoutMs', 'maxPayloadBytes'], 'invalid_config');
  const apiKeyEnv = data(config, 'apiKeyEnv', 'invalid_config');
  const model = data(config, 'model', 'invalid_config');
  const endpoint = data(config, 'endpoint', 'invalid_config');
  const configuredTimeout = data(config, 'timeoutMs', 'invalid_config');
  const configuredBytes = data(config, 'maxPayloadBytes', 'invalid_config');
  const timeoutMs = configuredTimeout === undefined ? 1000 : configuredTimeout;
  const maxPayloadBytes = configuredBytes === undefined ? 262144 : configuredBytes;
  ensure(typeof apiKeyEnv === 'string' && apiKeyEnv.length <= 256 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv));
  ensure(typeof model === 'string' && model.trim().length > 0 && model.length <= 256 && !/[\x00-\x1f\x7f]/.test(model));
  ensure(typeof endpoint === 'string' && endpoint.length > 0 && endpoint.length <= 2048);
  let url;
  try { url = new URL(endpoint); } catch { fail('invalid_config'); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  ensure(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3000);
  ensure(Number.isInteger(maxPayloadBytes) && maxPayloadBytes > 0 && maxPayloadBytes <= 1048576);
  plain(dependencies, 'invalid_dependencies');
  keys(dependencies, ['readEnv', 'fetch', 'inspectCurrent'], 'invalid_dependencies');
  const readEnv = data(dependencies, 'readEnv', 'invalid_dependencies');
  const fetch = data(dependencies, 'fetch', 'invalid_dependencies');
  const inspectCurrent = data(dependencies, 'inspectCurrent', 'invalid_dependencies');
  ensure(typeof readEnv === 'function' && typeof fetch === 'function' && typeof inspectCurrent === 'function', 'invalid_dependencies');
  let apiKey;
  try { apiKey = readEnv(apiKeyEnv); } catch { fail('key_resolver_error'); }
  ensure(typeof apiKey === 'string' && apiKey.trim().length > 0 && apiKey.length <= 512 && !/[\x00-\x1f\x7f]/.test(apiKey), 'key_unavailable');
  try {
    const owned = createOwnedTransport(fetch, maxPayloadBytes);
    const provider = new JevDecisionProvider({ apiKey, model, endpoint: url.href, timeoutMs, maxPayloadBytes, fetch: owned.fetch });
    const decision = { name: provider.name, async decide(...args) {
      try { return await provider.decide(...args); }
      finally { await owned.waitUntilIdle(); }
    } };
    return Object.freeze({ enabled: true, advisor: createSourceBoundAdvisor({ enabled: true, decision, inspectCurrent, timeoutMs }) });
  } catch { fail('construction_failed'); }
}
