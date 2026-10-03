# Configured current-source research advisor

This example is not a stable package export or an automatically installed GoodMemory hook. It adds one explicit configuration constructor to the existing four-lane research examples. Its local name is `createConfiguredSourceBoundAdvisor`; do not adopt a production `memory.*` config key from this experiment.

The caller passes an explicit subsection with `enabled`, `apiKeyEnv`, `model`, `endpoint`, optional `timeoutMs` (default 1000, 1–3000) and optional `maxPayloadBytes` (default 262144, 1–1048576). The endpoint is mandatory HTTPS with no URL credentials, query or fragment. Unknown enabled fields, direct `apiKey`, accessors and invalid values are rejected. Omitted or false `enabled` returns `{ enabled: false }` without inspecting other fields or dependencies; inactive extra fields are deliberately ignored for lazy optional configuration.

An enabled caller must provide exactly three dependencies: `readEnv(name)`, `fetch(url, init)` and `inspectCurrent(descriptor, signal)`. There is no fallback to `process.env`, ambient fetch, a default endpoint, a generated source receipt or another provider. A missing key fails before provider construction. The key is resolved once by the host callback; configuration does not request or persist credentials. Creating the object performs no HTTP or source inspection. This example does not grant permission to transmit memory; only host-approved/redacted snapshots may later be evaluated.

The returned `advisor` is the existing finite source-bound research evaluator. The host remains responsible for canonical source membership, scope, eligibility and current support. A matching digest alone is not evidence of any of these. Model advice cannot supply or override a source receipt. Missing/unsupported/stale source proof, invalid responses, errors and cancellation yield no advice. Each evaluation checks host proof before and after the provider.

Reuse one configured instance for its intended concurrency domain. The v2 wrapper owns the injected transport promise and any returned response reader through cancellation and lock release. Its provider promise remains pending until that work actually settles, even when the outer advisor has already returned timeout/cancelled. Concurrent evaluations then return busy. No promise of TCP-level abort completion is made; the injected transport and native response stream define the observable boundary. Detached work secretly started by a transport, synchronous infinite loops and new independent configured instances are outside the shared-slot contract. A never-settling dependency retains its slot indefinitely.

The raw response is read under the configured accepted-byte bound before being passed to the existing Jev parser. A too-large chunk is rejected and cancelled; this is not a limit on every network/JavaScript allocation. Failed cancellation or lock release cannot produce positive advice. Errors are static and do not expose provider bodies, keys or thrown dependency messages.

Admission/update integration remains the existing research policy comparators. Ordinary shadow preserves baseline decisions; the retained development replay's `synthetic-veto` mode exists only for isolated synthetic fixtures. Preferences/profile bypass the generic conflict hook. Deletion is only a finite proposal and has no actual delete/forget capability. Public rerank can choose one of two frozen complete plans for already-admitted IDs; it neither adds IDs nor changes their contents. Notes/preferences/profile/feedback and small/no-rerank recalls are not silently covered.

The development evidence uses exact packaged GoodMemory 0.8.2 and Hub 724ddf2, injected fake HTTP and synthetic keys. It proves config/wiring and specific lifetime mechanisms, not live provider behavior, semantic quality, generic current-source proof, stale-fallback repair, full every-recall coverage, permanent-delete recovery or production readiness. No Hub export, version, core implementation, GoodMemory code or default changes here.

## Two separate entrypoints

| Entry | Enabled result | Host call and scope |
| --- | --- | --- |
| `createConfiguredGoodMemoryShadowAdvisor` from `@cognitive-hub/core/goodmemory-shadow` | `{ enabled: true, provider }` | The existing example host passes a parsed `memory.shadow` subsection, then supplies `provider` to GoodMemory's independent experimental preference snapshot evaluator. Choices are keep/supersede/abstain; it is not an automatic remember, conflict or deletion hook. See [the preference bridge](goodmemory-shadow.md). |
| `createConfiguredSourceBoundAdvisor` from this example's **file path** | `{ enabled: true, advisor }` | Explicitly call `advisor.evaluate(envelope, { signal })`, or compose the existing four-lane research adapters with caller-owned preparation and source inspection. This does not consume `memory.shadow`. |

These results and call contracts are not interchangeable: the first exposes a
`provider.advise` contract; the second exposes `advisor.evaluate`. This adoption
does not rename or modify the preference bridge, introduce another stable package
export, install an application preset, change package version/private/exports, or
enable a production default.

## Import from a built checkout or unpacked private tarball

Build the checkout with the repository's normal `npm run build` first. The example
imports `dist/jev.js` and the existing runtime files; a source checkout without
`dist` is not a runnable consumer. For a private package check, build once and use
`npm pack --ignore-scripts` to avoid repeating prepack. The package's existing
`files` list includes examples, docs and dist; this file does not extend exports.

In a separate Node >=22 host, select an explicit absolute checkout/package root
and load the example by file URL:

```js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]); // built checkout, or extracted package/ directory
const entry = pathToFileURL(resolve(packageRoot,
  'examples/goodmemory-four-lane/configured-advisor.mjs')).href;
const { createConfiguredSourceBoundAdvisor } = await import(entry);
const disabled = createConfiguredSourceBoundAdvisor(undefined);
// disabled.enabled === false; no environment, transport or support callback is read.
```

`@cognitive-hub/core/examples/goodmemory-four-lane/configured-advisor.mjs` is not an
exported subpath. Installing/extracting a tarball does not make that bare import
valid. Use the selected file URL; do not widen package exports to bypass this
example boundary.

The caller may keep this explicit configuration object disabled:

```js
const config = {
  enabled: false,
  apiKeyEnv: 'TYPESAFE_AI_API_KEY', // a name only; its value belongs to the host
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  timeoutMs: 1000,
  maxPayloadBytes: 262144,
};
const configured = createConfiguredSourceBoundAdvisor(config, hostDependencies);
if (configured.enabled) {
  // Only after the host's approval to transmit this exact redacted envelope:
  const report = await configured.advisor.evaluate(hostApprovedEnvelope, { signal });
}
```

`hostDependencies` must explicitly supply `readEnv`, `fetch` and `inspectCurrent`
when enabled. A missing/blank key fails before provider construction; the factory
does not discover credential files, read `.env`, request new credentials or make
an HTTP request during construction. Undefined/disabled configuration returns
before inspecting dependencies. Do not put a key in this object, argv, a report
or a log. A transport-capable run that resolves and sends the key remains the
user/host's action-time responsibility.

The protocol is Jev/System One typed evaluation (`state`, `questions.next`, finite
Choice probabilities and usage), not OpenAI-compatible chat/completions. An
unrelated chat API endpoint or key is not a compatible substitute. The example
has no implicit retries.

## What inspectCurrent must establish

`inspectCurrent(descriptor, signal)` receives the exact lane, scope, request
digest and binding. Its receipt has `status`, `requestDigest`, `scopeDigest` and
`binding`. These fields correlate a **host inspection** with the immutable
request; they do not create source authority. A callback that simply copies the
descriptor's hashes into a `current` receipt is not proof.

Before returning `current`, the host must independently inspect its canonical
records and approved source/support set: exact complete scope, source membership
and attribution, eligibility/current support, and the content/version binding of
the exact finally redacted envelope it approved for transmission. The model
cannot supply that receipt. If the host cannot establish these facts, return a
correctly bound `unavailable` receipt; do not manufacture `current`. A changed
binding or unsupported source cannot be promoted by model confidence.

The pre/post inspection rejects unsupported or changed bindings observed at those
checks. It is not a transactional storage CAS, an atomic write permission or a
guarantee that support cannot change afterward. Reuse one configured instance for
one concurrency domain. A timeout ends the caller's wait; unsettled fetch or
response cancellation/release still occupies that instance and subsequent
evaluations return `busy`. Creating a new instance does not share or repair that
occupancy.

## Four-lane coverage and remaining gaps

| Lane | Existing host seam | This example's boundary |
| --- | --- | --- |
| Admission | `remember` calls `policy.shouldRemember` | Ordinary shadow records finite advice and returns the baseline decision. No automatic write authority. The earlier development replay's `synthetic-veto` mode is an explicitly isolated synthetic comparator, not this adoption's default. |
| Update | `remember` calls `policy.resolveConflict` | The demonstrated correction is a reference conflict. It does not cover every preference/profile update path or replace their independent handling. Ordinary shadow preserves the baseline. |
| Delete | Manually prepared `deletionEnvelope` | A bounded `propose_delete` option, always `authorized: false`; no delete/forget method, automatic deletion hook or verified hard-delete undo. |
| Rerank | `recall` calls `adapters.reranker` | Select one of two finite complete plans over already-admitted exact IDs. It cannot add foreign IDs or change records. The demonstrated source receipts are synthetic fixtures, not a general GoodMemory source-proof API. |

Unavailable proof at the precheck prevents HTTP; a failed postcheck discards advice after the request has already occurred. The host fallback is preserved.
`rerank: false`, small windows, unsupported pools and other memory kinds do not
promise evaluation on every recall. A fallback already captured for this recall
may itself be stale after a concurrent update; detecting stale advice does not
repair that fallback. The same issue prevents treating source rechecks as a
general concurrency or factual-authority guarantee. See [the four-lane
exploration](goodmemory-four-lane-exploration.md) and [current support
exploration](goodmemory-current-support-exploration.md).

## Evidence identity and the separate Mac live observation

The retained configured-source checkpoint was bound to Hub
`724ddf2c95b92982ce41ee6e0ab8c299cb9466b9` and packaged GoodMemory 0.8.2. Its 12
configuration groups, 21 host-seam groups, 9 lifecycle groups and ownership/key
controls used synthetic keys and injected fake HTTP. These overlap as development
mechanism checks; they are not independent semantic samples or a new version's
release result. Package adoption smoke checks must be reported separately from
that retained evidence. This document does not claim a full repository, real
PostgreSQL, release, publication or automatic four-lane gate.

On 2026-10-03 a Mac user manually ran one separate synthetic admission live
attempt: one HTTP 200 response, 1507 ms until fetch returned the response, request
model `jev-1.13.0`, final report `abstained`, and identical enabled/disabled shadow
results (accepted 1/rejected 0; one preference, source and evidence). Advice
mutations, real deletes and Hub dispatches were zero. This establishes that
attempt's transport/parser compatibility, not memory-quality improvement.

The original service choice, distribution, confidence and response model were not
retained. `wait` or `ask` is only a deduction from the recorded report and the
audited mapping; neither specific token nor response model can be backfilled. The
other three lanes have no live observation in that run. A separate local
diagnostic runner was later frozen to retain whitelisted response fields and
distinguish request/response models, but it has not run live. That runner is not
added to this package or used to relabel the original seen case. No live logs or
credentials belong in the private tarball.
