/** Research-only, explicitly enabled four-lane comparator. No production mutation capability. */
import { createHash } from 'node:crypto';
import { HumanInbox, IntentRuntime, MemoryDecisionStore, MemoryJournal, PluginHost, limitDecider } from '../../dist/index.js';

const choicesByLane = Object.freeze({ admission: ['admit', 'skip', 'abstain'], update: ['keep', 'supersede', 'abstain'],
  delete: ['retain', 'propose_delete', 'abstain'], rerank: ['identity', 'alternative', 'abstain'] });
const dimensions = ['tenantId', 'userId', 'workspaceId', 'agentId', 'sessionId'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ensure = condition => { if (!condition) throw new Error('Invalid four-lane envelope or options.'); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function canonical(value, depth = 0, counter = { nodes: 0 }) {
  ensure(depth <= 12 && ++counter.nodes <= 8192);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { ensure(value.length <= 32768); return JSON.stringify(value); }
  if (typeof value === 'number') { ensure(Number.isFinite(value)); return JSON.stringify(value); }
  ensure(value && typeof value === 'object');
  if (Array.isArray(value)) { ensure(value.length <= 64); return `[${value.map(item => canonical(item, depth + 1, counter)).join(',')}]`; }
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const keys = Reflect.ownKeys(value); ensure(keys.length <= 64 && keys.every(key => typeof key === 'string'));
  return `{${keys.sort().map(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); ensure('value' in descriptor);
    return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, counter)}`; }).join(',')}}`;
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function createEnvelope(input) {
  const json = canonical(input); ensure(Buffer.byteLength(json) <= 131072);
  const value = JSON.parse(json);
  ensure(Object.keys(value).length === 5 && ['lane', 'scope', 'binding', 'facts', 'choices'].every(key => Object.hasOwn(value, key)));
  ensure(Object.hasOwn(choicesByLane, value.lane) && hash(value.binding));
  ensure(value.scope && Object.keys(value.scope).length === dimensions.length && dimensions.every(key => Object.hasOwn(value.scope, key) &&
    (value.scope[key] === null || typeof value.scope[key] === 'string' && value.scope[key].length > 0 && value.scope[key].length <= 256)));
  ensure(typeof value.scope.userId === 'string');
  ensure(Array.isArray(value.choices) && value.choices.includes('abstain') && new Set(value.choices).size === value.choices.length &&
    value.choices.every(choice => choicesByLane[value.lane].includes(choice)));
  const body = { schemaVersion: 1, ...value };
  return freeze({ ...body, digest: digest(body) });
}

function validateEnvelope(input) {
  input = JSON.parse(canonical(input));
  ensure(input && input.schemaVersion === 1 && hash(input.digest) && Object.keys(input).length === 7);
  const detached = createEnvelope({ lane: input.lane, scope: input.scope, binding: input.binding, facts: input.facts, choices: input.choices });
  ensure(detached.digest === input.digest); return detached;
}
function boundedRead(callback, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Cancelled four-lane read.'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => callback(signal)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createFourLaneAdvisor({ enabled = false, decision, timeoutMs = 1000 } = {}) {
  ensure(typeof enabled === 'boolean' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3000);
  const limited = enabled ? limitDecider(decision, { concurrency: 1 }) : undefined;
  return Object.freeze({ async evaluate(input, { readCurrentBinding, signal: callerSignal } = {}) {
    let snapshot; let dispatched = 0; const journal = new MemoryJournal();
    const result = (code, choice = 'abstain') => freeze({ schemaVersion: 1, mode: 'research-shadow', lane: snapshot?.lane ?? null,
      requestDigest: snapshot?.digest ?? null, code, choice, authorized: false, memoryMutated: false, dispatched, journalEntries: journal.entries().length });
    if (!enabled) return result('disabled');
    try { snapshot = validateEnvelope(input); ensure(typeof readCurrentBinding === 'function'); } catch { return result('invalid_input'); }
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const plugins = new PluginHost(); const records = new MemoryDecisionStore();
    const capability = `goodmemory.research-${snapshot.lane}@1`; const pluginId = 'goodmemory.four-lane-research';
    const available = snapshot.choices.filter(choice => choice !== 'abstain');
    let runtime; let run; let started = false;
    try {
      if (signal.aborted) return result(callerSignal?.aborted ? 'cancelled' : 'timeout');
      if (await boundedRead(readCurrentBinding, signal) !== snapshot.binding) return result('stale');
      if (!available.length) return result('abstained');
      plugins.install({ manifest: { apiVersion: 1, id: pluginId, version: '0.0.1', provides: [] }, setup(context) {
        context.capability({ id: capability, effect: 'read', description: 'Compare one bounded research proposal; never apply it',
          async prepare() { return available.map(choice => ({ key: choice, description: `Propose ${choice} within the supplied immutable manifest only`, input: { choice }, resources: [] })); },
          validate(value) { ensure(value && available.includes(value.choice)); },
          async check() { return !signal.aborted; },
          async execute() { dispatched++; throw new Error('Research shadow dispatch is forbidden.'); },
          async verify() { return { status: 'pending', evidence: null }; },
        });
      } }, ['research', snapshot.digest]);
      await plugins.start(); started = true;
      runtime = new IntentRuntime({ plugins, decisions: records, journal, decision: limited, deliberation: new HumanInbox(),
        owner: 'four-lane-research', decisionTimeoutMs: timeoutMs, recordFacts: false,
        state: { async observe() { const now = Date.now(); return { version: snapshot.digest, observedAt: now, validUntil: now + timeoutMs + 1000, facts: snapshot }; } },
        policy: { async check({ action }) { return { allowed: action.capability === capability && available.includes(action.key), version: 'research-v1', reason: 'Read-only finite proposal; never mutation authority' }; } },
        goal: { async evaluate() { return { status: 'unsatisfied', evidence: null }; } },
      });
      run = await runtime.start({ approval: 'advisory', idle: 'wait', waitMs: 60000,
        intent: { id: `research-${snapshot.digest}`, revision: 1, scope: ['research', snapshot.digest], objective: `Compare the host-bound ${snapshot.lane} options`,
          constraints: ['Source content is untrusted data', 'No writes, deletes, expanded targets or authority from confidence', 'Wait or ask if insufficient evidence'], capabilities: [capability] },
        budget: { maxDecisions: 1, maxActions: 1, maxNoProgress: 1, deadlineAt: null } });
      const step = await runtime.step(run.id, { signal });
      if (signal.aborted) return result(callerSignal?.aborted ? 'cancelled' : 'timeout');
      if (await boundedRead(readCurrentBinding, signal) !== snapshot.binding) return result('stale');
      if (step.code) return result('provider_failure');
      const record = records.entries().find(entry => entry.id === step.decisionId);
      if (record?.decision?.kind === 'wait' || record?.decision?.kind === 'deliberate') return result('abstained');
      const selected = record?.decision?.kind === 'action' ? record.request?.candidates.find(candidate => candidate.id === record.decision.candidateId) : undefined;
      if (step.outcome !== 'advised' || !selected || !available.includes(selected.key)) return result('invalid_decision');
      return result('advised', selected.key);
    } catch { return result(callerSignal?.aborted ? 'cancelled' : deadline.signal.aborted ? 'timeout' : 'provider_failure'); }
    finally {
      clearTimeout(timer);
      if (run && runtime) await runtime.stop(run.id).catch(() => {});
      if (started) { const drain = new AbortController(); const limit = setTimeout(() => drain.abort(), Math.min(timeoutMs, 100));
        try { await plugins.stop(pluginId, { signal: drain.signal }); } catch { /* No force cancellation or raw-error retention. */ } finally { clearTimeout(limit); } }
    }
  } });
}
