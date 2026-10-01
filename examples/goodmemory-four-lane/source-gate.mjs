/** Research-only host support gate. Receipts are trusted callback observations, never model authority. */
import { createEnvelope, createFourLaneAdvisor, digest } from './advisor.mjs';

const ensure = condition => { if (!condition) throw new Error('Invalid current-support advisor contract.'); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, keys) => value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && 'value' in Object.getOwnPropertyDescriptor(value, key));

function detachEnvelope(input) {
  ensure(fields(input, ['schemaVersion', 'lane', 'scope', 'binding', 'facts', 'choices', 'digest']));
  ensure(input.schemaVersion === 1 && hash(input.digest));
  const envelope = createEnvelope({ lane: input.lane, scope: input.scope, binding: input.binding, facts: input.facts, choices: input.choices });
  ensure(envelope.digest === input.digest);
  return envelope;
}

function receiptFailure(receipt, descriptor, scopeDigest) {
  if (!fields(receipt, ['status', 'requestDigest', 'scopeDigest', 'binding']) ||
    !['current', 'unsupported', 'unavailable'].includes(receipt.status) ||
    !hash(receipt.requestDigest) || !hash(receipt.scopeDigest) || !hash(receipt.binding) ||
    receipt.requestDigest !== descriptor.requestDigest || receipt.scopeDigest !== scopeDigest) return 'invalid_support';
  if (receipt.binding !== descriptor.binding) return 'stale';
  if (receipt.status === 'unsupported') return 'source_unsupported';
  if (receipt.status === 'unavailable') return 'source_unavailable';
  return null;
}

/** No public GoodMemory eligibility oracle is implied. Host inspection must establish support itself. */
export function createSourceBoundAdvisor({ enabled = false, decision, inspectCurrent, timeoutMs = 1000 } = {}) {
  ensure(typeof enabled === 'boolean' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3000);
  let decide;
  let providerName;
  if (enabled) {
    ensure(typeof inspectCurrent === 'function' && decision && typeof decision.decide === 'function' &&
      typeof decision.name === 'string' && decision.name.length > 0 && decision.name.length <= 256);
    decide = decision.decide.bind(decision);
    providerName = decision.name;
  }
  let active = false;
  let pending = 0;
  const track = async callback => { pending++; try { return await callback(); } finally { pending--; } };
  const early = code => Object.freeze({ schemaVersion: 1, mode: 'research-shadow', lane: null, requestDigest: null,
    code, choice: 'abstain', authorized: false, memoryMutated: false, dispatched: 0, journalEntries: 0, supportChecks: 0, providerCalls: 0 });

  return Object.freeze({ async evaluate(input, { signal } = {}) {
    if (!enabled) return early('disabled');
    if (signal?.aborted) return early('cancelled');
    if (active || pending > 0) return early('busy');
    let envelope;
    try { envelope = detachEnvelope(input); } catch { return early('invalid_input'); }
    active = true;
    let supportChecks = 0;
    let providerCalls = 0;
    let blocked = null;
    const descriptor = Object.freeze({ lane: envelope.lane, scope: envelope.scope, requestDigest: envelope.digest, binding: envelope.binding });
    const scopeDigest = digest(envelope.scope);
    const advisor = createFourLaneAdvisor({ enabled: true, timeoutMs, decision: { name: providerName,
      async decide(...args) { providerCalls++; return track(() => decide(...args)); },
    } });
    try {
      const report = await advisor.evaluate(envelope, { signal, async readCurrentBinding(readSignal) {
        supportChecks++;
        try {
          const receipt = await track(() => inspectCurrent(descriptor, readSignal));
          if (readSignal.aborted) return null;
          blocked = receiptFailure(receipt, descriptor, scopeDigest);
        } catch {
          if (readSignal.aborted) return null;
          blocked = 'source_unavailable';
        }
        return blocked ? null : envelope.binding;
      } });
      return Object.freeze({ ...report, code: report.code === 'stale' && blocked ? blocked : report.code, supportChecks, providerCalls });
    } finally { active = false; }
  } });
}
