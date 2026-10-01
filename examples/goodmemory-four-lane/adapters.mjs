/** Experimental adapters for isolated synthetic comparators, never installed by default. */
import { createEnvelope, digest } from './advisor.mjs';

const invariant = condition => { if (!condition) throw new Error('Invalid four-lane adapter contract.'); };
const immutable = value => { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };
const clone = value => immutable(structuredClone(value));
const observe = (callback, report) => {
  try { void Promise.resolve(callback?.(report)).catch(() => {}); } catch { /* Diagnostics never control the memory pipeline. */ }
};

function policyOptions(options) {
  invariant(options.mode === undefined || options.mode === 'shadow' || options.mode === 'synthetic-veto');
  invariant(options.mode !== 'synthetic-veto' || options.syntheticFixture === true);
}

/** prepare owns final-redaction/source proof. The public hook itself does not supply canonical sources. */
export function admissionComparator(options) {
  options = Object.freeze({ ...options });
  policyOptions(options);
  return async (candidate, context) => {
    const baseline = options.baseline ? await options.baseline(candidate, context) : true;
    if (options.enabled !== true || !baseline) return baseline;
    let report;
    try {
      const prepared = await options.prepare(clone(candidate), clone(context));
      invariant(prepared.envelope.lane === 'admission');
      report = await options.advisor.evaluate(prepared.envelope, { readCurrentBinding: prepared.readCurrentBinding });
    } catch { report = immutable({ code: 'host_proof_unavailable', choice: 'abstain', authorized: false, memoryMutated: false }); }
    observe(options.onReport, report);
    // Shadow cannot change baseline. Synthetic treatment can only veto it, never expand authority.
    return options.mode === 'synthetic-veto' ? report.code === 'advised' && report.choice === 'admit' : baseline;
  };
}

/** Only the existing reference/note/fact/feedback hook calls are covered. Preferences/profile bypass it. */
export function conflictComparator(options) {
  options = Object.freeze({ ...options });
  policyOptions(options);
  return async (existing, incoming, context) => {
    const baseline = options.baseline ? await options.baseline(existing, incoming, context) : { action: 'supersede_existing' };
    if (options.enabled !== true || baseline.action === 'keep_existing') return baseline;
    let report;
    try {
      const prepared = await options.prepare(clone(existing), clone(incoming), clone(context));
      invariant(prepared.envelope.lane === 'update');
      report = await options.advisor.evaluate(prepared.envelope, { readCurrentBinding: prepared.readCurrentBinding });
    } catch { report = immutable({ code: 'host_proof_unavailable', choice: 'abstain', authorized: false, memoryMutated: false }); }
    observe(options.onReport, report);
    if (options.mode !== 'synthetic-veto') return baseline;
    return report.code === 'advised' && report.choice === 'supersede' ? baseline : { action: 'keep_existing', reason: 'experimental_shadow_veto' };
  };
}

/** All authority evidence is host supplied; even a fully eligible proposal is never an execution grant. */
export function deletionEnvelope({ scope, target, intent, recovery }) {
  invariant(target && typeof target.collection === 'string' && target.collection.length > 0 && typeof target.id === 'string' && target.id.length > 0);
  invariant(/^[a-f0-9]{64}$/.test(target.recordVersion) && /^[a-f0-9]{64}$/.test(target.supportVersion));
  const manifest = { scope, target };
  const targetDigest = digest(manifest);
  const eligible = intent?.kind === 'explicit_exact_forget' && intent.targetDigest === targetDigest &&
    recovery?.targetDigest === targetDigest && recovery.verifiedInSyntheticSimulator === true && /^[a-f0-9]{64}$/.test(recovery.snapshotDigest);
  return createEnvelope({ lane: 'delete', scope, binding: targetDigest,
    facts: { target, explicitIntentMatches: intent?.kind === 'explicit_exact_forget' && intent.targetDigest === targetDigest,
      recoveryVerifiedInSyntheticSimulator: eligible, requiresSeparateExecutionConfirmation: true },
    choices: eligible ? ['retain', 'propose_delete', 'abstain'] : ['retain', 'abstain'] });
}

function validOrder(ids, documents) {
  return Array.isArray(ids) && ids.length === documents.length && new Set(ids).size === ids.length &&
    ids.every(id => documents.some(document => document.id === id));
}

/** One bounded order-plan choice, NOT a general unconstrained listwise model. Disabled returns no adapter. */
export function orderPlanReranker({ enabled = false, advisor, scope, alternativeOrder, onReport } = {}) {
  invariant(typeof enabled === 'boolean');
  if (!enabled) return undefined;
  return Object.freeze({ async rerank(input) {
    try {
      const detached = clone(input);
      const binding = digest(detached);
      invariant(typeof detached.query === 'string' && detached.documents.length >= 2 && detached.documents.length <= 32);
      invariant(detached.documents.every(document => typeof document.id === 'string' && document.id.length > 0 && typeof document.text === 'string'));
      const identity = detached.documents.map(document => document.id);
      invariant(validOrder(identity, detached.documents));
      const alternative = clone(await alternativeOrder(detached));
      invariant(validOrder(alternative, detached.documents));
      const envelope = createEnvelope({ lane: 'rerank', scope, binding, facts: { query: detached.query, documents: detached.documents,
        plans: { identity, alternative } }, choices: ['identity', 'alternative', 'abstain'] });
      const report = await advisor.evaluate(envelope, { readCurrentBinding: async () => digest(input) });
      observe(onReport, report);
      if (report.code !== 'advised' || !['identity', 'alternative'].includes(report.choice)) throw new Error('Experimental order-plan reranker unavailable.');
      const ids = report.choice === 'identity' ? identity : alternative;
      invariant(validOrder(ids, detached.documents));
      return ids.map((id, index) => ({ id, score: (ids.length - index) / ids.length }));
    } catch { throw new Error('Experimental order-plan reranker unavailable.'); }
  } });
}
