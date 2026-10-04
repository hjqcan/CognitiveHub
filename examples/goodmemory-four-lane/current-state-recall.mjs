/** Research-only read facade. Host-owned revisions and source approval are explicit prerequisites. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createEnvelope, digest } from './advisor.mjs';

const fail = () => { const error = new Error('Current-state recall unavailable.'); error.code = 'current_state_unavailable'; throw error; };
const ensure = condition => { if (!condition) fail(); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// Supported snapshots are acyclic ordinary data graphs, not arbitrary structured-clone values.
// Inspect descriptors before reading values: cloning must neither run getters nor erase prototypes.
function copy(value) {
  const ancestors = new WeakSet(); let nodes = 0;
  const visit = (value, depth) => {
    ensure(depth <= 64 && ++nodes <= 100000);
    if (value === null || value === undefined || ['boolean', 'string'].includes(typeof value)) return value;
    if (typeof value === 'number') { ensure(Number.isFinite(value)); return value; }
    ensure(typeof value === 'object');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    ensure(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    ensure(!ancestors.has(value)); ancestors.add(value);
    const keys = Reflect.ownKeys(value); ensure(keys.every(key => typeof key === 'string'));
    let result;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length').value;
      ensure(length <= 100000 && keys.length === length + 1);
      result = new Array(length);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        ensure(descriptor?.enumerable === true && 'value' in descriptor);
        result[index] = visit(descriptor.value, depth + 1);
      }
    } else {
      result = Object.create(prototype);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        ensure(descriptor?.enumerable === true && 'value' in descriptor);
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1),
          enumerable: true, writable: true, configurable: true });
      }
    }
    ancestors.delete(value); return Object.freeze(result);
  };
  return visit(value, 0);
}
const dimensions = ['tenantId', 'userId', 'workspaceId', 'agentId', 'sessionId'];
function data(object, key) {
  try { const property = Object.getOwnPropertyDescriptor(object, key); ensure(!property || 'value' in property); return property?.value; }
  catch { fail(); }
}
function fullScope(scope) {
  ensure(scope && typeof scope === 'object' && Object.keys(scope).every(key => dimensions.includes(key)));
  const result = Object.fromEntries(dimensions.map(key => [key, scope[key] ?? null]));
  ensure(typeof result.userId === 'string' && dimensions.every(key => result[key] === null ||
    typeof result[key] === 'string' && result[key].trim() === result[key] && result[key].length > 0 && result[key].length <= 256));
  return freeze(result);
}
const permutation = (order, ids) => Array.isArray(order) && order.length === ids.length &&
  new Set(order).size === ids.length && order.every(id => ids.includes(id));
function bounded(callback, signal) {
  if (signal.aborted) return Promise.reject(new Error('Current-state read cancelled.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Current-state read cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => callback(signal)).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * No ambient config/key/transport. A missing/false enabled flag reads no other dependency.
 * readCurrent must cover EVERY writer affecting recall, source support, projections and session state.
 * Its revision must never be reused (including A -> B -> A), and stable must exclude in-flight writes.
 * Source approval remains the supplied advisor's independent inspectCurrent contract, not this token.
 */
export function createCurrentStateRecallHost(options) {
  if (options === undefined) return Object.freeze({ enabled: false });
  ensure(options && typeof options === 'object');
  let descriptor; try { descriptor = Object.getOwnPropertyDescriptor(options, 'enabled'); } catch { fail(); }
  ensure(!descriptor || 'value' in descriptor);
  if (!descriptor || descriptor.value === false || descriptor.value === undefined) return Object.freeze({ enabled: false });
  ensure(descriptor.value === true);
  const createMemory = data(options, 'createMemory'), readCurrent = data(options, 'readCurrent');
  const prepareRerank = data(options, 'prepareRerank'), alternativeOrder = data(options, 'alternativeOrder');
  const advisor = data(options, 'advisor'), timeoutMs = data(options, 'timeoutMs') ?? 3000;
  ensure([createMemory, readCurrent, prepareRerank, alternativeOrder].every(callback => typeof callback === 'function'));
  const evaluate = advisor && data(advisor, 'evaluate');
  ensure(typeof evaluate === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3000);
  const contexts = new AsyncLocalStorage();
  const issued = new WeakMap();

  const read = async (scope, signal) => {
    const state = await bounded(() => readCurrent(scope, signal), signal);
    ensure(state && Reflect.ownKeys(state).length === 4 && ['status', 'scopeDigest', 'revision', 'stable'].every(key =>
      Object.hasOwn(state, key) && 'value' in Object.getOwnPropertyDescriptor(state, key)));
    ensure(state.status === 'current' && state.stable === true && state.scopeDigest === digest(scope) &&
      typeof state.revision === 'string' && state.revision.length > 0 && state.revision.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(state.revision));
    return copy(state);
  };
  const unchanged = async context => (await read(context.scope, context.signal)).revision === context.state.revision;
  const reranker = Object.freeze({ async rerank(input) {
    try {
      const context = contexts.getStore(); ensure(context && await unchanged(context));
      const detached = copy(input);
      ensure(typeof detached.query === 'string' && detached.documents.length >= 2 && detached.documents.length <= 32);
      ensure(detached.documents.every(document => typeof document.id === 'string' && document.id.length > 0 && typeof document.text === 'string'));
      const identity = detached.documents.map(document => document.id);
      ensure(permutation(identity, identity));
      const alternative = copy(await bounded(() => alternativeOrder(detached, context.signal), context.signal));
      ensure(permutation(alternative, identity));
      const plans = freeze({ identity, alternative });
      const envelope = copy(await bounded(() => prepareRerank(freeze({ input: detached, plans,
        scope: context.scope, state: context.state }), context.signal), context.signal));
      ensure(envelope.lane === 'rerank' && digest(envelope.scope) === digest(context.scope));
      ensure(Object.keys(envelope.facts).length === 3 && ['query', 'documents', 'plans'].every(key => Object.hasOwn(envelope.facts, key)));
      ensure(envelope.choices.length === 3 && envelope.choices.join(',') === 'identity,alternative,abstain');
      ensure(typeof envelope.facts.query === 'string' && permutation(envelope.facts.documents.map(document => document.id), identity));
      ensure(envelope.facts.documents.every(document => typeof document.text === 'string') && digest(envelope.facts.plans) === digest(plans));
      ensure(envelope.schemaVersion === 1 && Object.keys(envelope).length === 7);
      const bound = createEnvelope({ lane: envelope.lane, scope: envelope.scope, binding: envelope.binding,
        facts: envelope.facts, choices: envelope.choices });
      ensure(envelope.digest === bound.digest);
      ensure(await unchanged(context));
      const report = copy(await bounded(() => evaluate.call(advisor, envelope, { signal: context.signal }), context.signal));
      const fields = ['schemaVersion', 'mode', 'lane', 'requestDigest', 'code', 'choice', 'authorized',
        'memoryMutated', 'dispatched', 'journalEntries', 'supportChecks', 'providerCalls'];
      ensure(report && Object.keys(report).length === fields.length && fields.every(key => Object.hasOwn(report, key)));
      ensure(report.schemaVersion === 1 && report.mode === 'research-shadow' && report.lane === 'rerank' &&
        report.requestDigest === bound.digest && report.supportChecks === 2 && report.providerCalls === 1);
      ensure(report.code === 'advised' && ['identity', 'alternative'].includes(report.choice) &&
        report.authorized === false && report.memoryMutated === false && report.dispatched === 0 && report.journalEntries === 0);
      ensure(await unchanged(context));
      return plans[report.choice].map((id, index) => ({ id, score: identity.length - index }));
    } catch { fail(); }
  } });
  let base; try {
    base = createMemory(reranker);
    ensure(base && ['recall', 'buildContext', 'diagnoseRecall'].every(key => typeof base[key] === 'function'));
  } catch { fail(); }
  const run = async (callback, callerSignal) => {
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
      return await bounded(() => callback(signal), signal);
    } catch { fail(); } finally { clearTimeout(timer); }
  };
  const capture = (result, input, method, state, scope) => {
    const detached = copy(result);
    issued.set(detached, { input, method, state, scope });
    return detached;
  };
  const recallWithin = async (input, method, signal, baselineOnly = false) => {
    input = copy(input); const scope = fullScope(input.scope);
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await read(scope, signal);
      const context = { scope, state, signal };
      const request = baselineOnly || attempt > 0 ? { ...input, rerank: false } : input;
      const result = await contexts.run(context, () => bounded(() => base[method](request), signal));
      if (await unchanged(context)) return capture(result, input, method, state, scope);
    }
    fail();
  };
  const contextWithin = async (input, signal) => {
    const provenance = issued.get(input.recall); ensure(provenance);
    let recalled = input.recall;
    for (let attempt = 0; attempt < 2; attempt++) {
      let proof = issued.get(recalled);
      if (attempt > 0 || (await read(proof.scope, signal)).revision !== proof.state.revision) {
        recalled = await recallWithin(provenance.input, provenance.method, signal, true);
        proof = issued.get(recalled);
      }
      const built = await bounded(() => base.buildContext({ ...input, recall: recalled }), signal);
      if ((await read(proof.scope, signal)).revision === proof.state.revision) return freeze({ recall: recalled, context: copy(built) });
    }
    fail();
  };
  const methods = {
    recall: (input, { signal } = {}) => run(signal => recallWithin(input, 'recall', signal), signal),
    diagnoseRecall: (input, { signal } = {}) => run(signal => recallWithin(input, 'diagnoseRecall', signal, true), signal),
    buildContext: (input, { signal } = {}) => run(async signal => (await contextWithin(input, signal)).context, signal),
    // New explicit host entry for callers that need records and rendered context from the same fenced read.
    recallAndBuildContext: (input, contextOptions = {}, { signal } = {}) => run(async signal =>
      contextWithin({ ...contextOptions, recall: await recallWithin(input, 'recall', signal) }, signal), signal),
  };
  const delegates = new Map();
  const memory = new Proxy(base, { get(target, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!delegates.has(key)) delegates.set(key, value.bind(target));
    return delegates.get(key);
  } });
  return Object.freeze({ enabled: true, memory });
}
