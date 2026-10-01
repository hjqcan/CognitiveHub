# Current-support gating experiment

This opt-in research example adds a current-support check to the [four-lane comparator](./goodmemory-four-lane-exploration.md). It does not install a production hook or change the package exports. Use a source checkout or an explicitly built private local package; this is not an npm release.

## Why another check?

A record can remain byte-for-byte unchanged and active in audit export while its supporting source becomes ineligible. A version hash detects changes to the hashed state; it does not establish current support or authorship. The experiment asks whether a separate trusted host check can refuse a proposal before or after one finite decision, including when that version hash has not changed.

The hypothesis is mechanical. Fake providers cannot establish Jev quality, language generalization, or usefulness of a proposed write. Passing these tests does not prove the absence of overfitting. Development cases, independent validation, and an untouched final family partition are tracked separately; fixing a result consumes that partition for subsequent comparisons.

## Research API

Import `createSourceBoundAdvisor` from `examples/goodmemory-four-lane/source-gate.mjs` and `createEnvelope`/`digest` from the sibling `advisor.mjs`.

```js
const advisor = createSourceBoundAdvisor({
  enabled: true,
  decision: syntheticDecisionProvider,
  timeoutMs: 1000,
  async inspectCurrent(descriptor, signal) {
    // Trusted host code reads actual current eligibility and version here.
    // Never return a model-authored certificate or copy a gold test label.
    const state = await inspectActualHostState(descriptor, signal);
    return {
      status: state.support, // current | unsupported | unavailable
      requestDigest: descriptor.requestDigest,
      scopeDigest: digest(descriptor.scope),
      binding: state.currentBinding,
    };
  },
});
const report = await advisor.evaluate(envelope, { signal });
```

The inspector gets an immutable lane, complete five-dimensional scope, request digest and expected binding. Its receipt must have exactly the four shown data fields. Wrong request/scope is `invalid_support`; changed binding is `stale`; matching but revoked support is `source_unsupported`; absent capability or a thrown inspector is `source_unavailable`. Malformed receipts are invalid. A matching `current` receipt is required before and after the provider. Failure before the provider uses no model call; failure afterward discards its proposal. A late callback cannot change a returned report.

`decision` is the standard Hub `DecisionProvider` interface. The existing `createConfiguredGoodMemoryShadowAdvisor` returns a preference-specific shadow advisor, not this four-lane provider. Its configuration switch does not automatically activate this research gate. A real provider run requires a separately authorized host setup and its own quality/cost evaluation.

The receipt is a trusted callback observation, not an authenticated proof. Hashes do not prove its truth. Only the host can establish source ownership, current support, source clocks and policy permission. Provider facts must already be redacted and permitted; the inspector must not restore removed raw text into the request. Never treat confidence or model metadata as support or authorization.

Reports contain finite codes, hashes and call counts, with `authorized:false`, `memoryMutated:false`, and zero dispatch/journal entries. That describes this advisor, not every action performed by the surrounding host. A shadow baseline is deliberately unchanged when a proposal is refused. Synthetic veto remains narrower than the baseline; delete remains proposal-only; rerank still requires an exact complete finite candidate permutation.

## Budget and fallback

- Default disabled: no envelope read, source check or provider call
- One active evaluation per instance, at most two source checks and one provider call, no retries
- Timeout is a positive integer up to 3000 ms; existing asynchronous deadline and bounded cleanup apply
- An uncooperative inspector or provider keeps its slot occupied until its promise settles; later requests return `busy` without adding work
- The timeout cannot preempt synchronous JavaScript or bound host preparation/baseline callbacks outside this API
- Diagnostics do not retain raw facts, raw callback errors or receipt bodies; there is no replay persistence

An already-aborted request returns `cancelled` before checking occupancy. Instances are independent. There is a race after the last source check: no atomic mutation/CAS permission is granted. Production deletion still lacks the separately required exact-target authority and recovery contract.

## Actual GoodMemory capability boundary

The development replay pins closed GoodMemory source `50157bfaaf8c48cac8f6059583858ffce0da302f`, local package SHA256 `66baacf3da56cb46a872a552ed4a0d6340622f90040762d4bd96fea27898921e`. This package retains version 0.8.1 in its metadata but is unpublished development code, not registry 0.8.1.

Public `recall`/`buildContext` checks observation support. Public `exportMemory` is audit data. In the fixture, maintenance creates an observation, an external synthetic event inactivates a source, and the observation remains active and unchanged in export while current recall suppresses it. A precise public trace with that record's `observation_support_unverified` reason can inform this narrow inspector. Mere absence from recall cannot: relevance, budgets or other policy may omit a valid record, so unexplained absence is `unavailable`.

The public API does not expose a universal source-eligibility oracle for arbitrary incoming writes or conflict targets. The four-lane replay therefore evaluates read-only proposals over retrieved evidence, not four newly automatic production hooks. Its delete choice is retain only, with no memory deletion call.

The real reranker is also exercised. The core excludes the unsupported observation before the outbound hook. A deliberately strict inspector compares the public recall representation with the hook's documents, and returns unavailable when they differ. That preserves deterministic recall and makes zero provider calls. It is not a successful positive guarded rerank or a ranking improvement. Duplicating private text-rendering or source-eligibility internals just to pass this fixture would hide the missing public contract. A reusable production bridge needs a core-issued, scoped candidate/support snapshot or equivalent public capability first.

### What each lane still needs

- Admission: a post-redaction, source-grounded candidate snapshot at the actual admission boundary. The current boolean hook does not carry the complete canonical source proof; source persistence happens later. Evaluator origin labels cannot fill this gap.
- Update: an exact collection/ID, current record plus support version, and incoming source proof under the same scope. Existing conflict hooks do not uniformly cover preferences/profile or every import/revision path. An advisor result cannot replace source-clock rules or an atomic apply check.
- Delete: a collection-qualified target, explicit current user intent, separate confirmation/recovery policy and version-checked reversible application capability. The existing hard-delete entry point is not such a contract. This experiment exposes no delete function.
- Rerank: a core-issued immutable candidate DTO with the actual policy-permitted model text and an opaque support/version receipt that the core can revalidate. Candidate admission and source checks must remain outside the model. A generic bridge should not reconstruct private rendering or restore candidates omitted by the core.

These are proposed requirements, not new APIs. Any future public receipt must include complete scope and collection-qualified identity, distinguish unsupported from unknown, limit candidate counts/bytes, and bind revalidation to exactly the provider-visible text. Inspection still does not grant a write: mutation needs a separate atomic contract. Missing support must preserve the original path in shadow mode or fail closed in an explicitly approved restrictive mode.

## Reproduce development checks

```sh
npm run build
node --test tests/goodmemory-source-gate.test.mjs
node examples/goodmemory-four-lane/current-support-replay.mjs \
  /absolute/path/to/unpacked-goodmemory/dist/index.js /tmp/source-gate-results
```

Use only synthetic data and deterministic providers. The replay does not configure credentials or call a real service. It reports paired advisor outcomes separately from public recall fallback, latency and call counts. For each claimed lane, valid-current positive controls and abstention controls remain in the denominator; rejecting everything cannot pass.

Independent validation/final assessments must freeze their inputs, oracles, source/package identities and supported families before execution. Label/family information belongs only to the evaluator and never in an envelope. Preserve failed runs and capability gaps. A repeated run after a fix is regression evidence, not a new blind test or a semantic uplift.
