# Experimental GoodMemory shadow package seam

This optional bridge is exported only from `@cognitive-hub/core/goodmemory-shadow`.
It is a local experimental package boundary, not a registry release or a production
integration. The package remains `private: true` at its existing version. The root
API, Jev subpath, PostgreSQL subpath, and their behavior are unchanged.

## Contract and ownership

```ts
import { createGoodMemoryShadowAdvisor } from '@cognitive-hub/core/goodmemory-shadow';
import type { DecisionProvider } from '@cognitive-hub/core';

// Inject the host's offline/tested decision provider. This example opens no network connection.
declare const decision: DecisionProvider;
const provider = createGoodMemoryShadowAdvisor({
  decision,
  timeoutMs: 1000,
  // Omit this for no history; explicit diagnostic retention must be 0..128.
  maxReplayRecords: 0,
});
```

`GoodMemoryShadowRequest` declares only the minimum readonly structural fields the
bridge uses: schema version, request and previous-version hashes, scope, source ID,
previous source IDs, and the finite allowed choices. A richer GoodMemory request
can be assigned without importing GoodMemory into CognitiveHub. The full JSON
request, including its host-admitted candidate/span/supporting evidence, reaches
the injected decider. The host must redact and validate it before this call. No
credential, unrestricted source stream, or evaluator label belongs in that input.
The bridge snapshots the input before its first await so caller mutation cannot
change the evidence or eligibility during evaluation.

The provider shape is `name: string` and
`advise(request, signal): Promise<unknown>`. `unknown` is deliberate: this is model
advice for GoodMemory's strict validator, not a validated memory operation. Valid
choices are only `keep`, `supersede`, and `abstain`. The host's allowed choices
limit prepared candidates; wait/deliberate and an abstain-only request become
`abstain`. Errors, cancellation, invalid decisions, and invalid confidence produce
the intentionally invalid `{ choice: 'invalid_hub_result', evidenceSourceRecordIds: [] }`
shape, so the host cannot mistake a failed call for a successful abstention.
Invalid request structure and evaluator labels reject before the decider runs.

The bridge performs one real `IntentRuntime` advisory step, including policy and
preview checks. It does not receive a GoodMemory store, call a write operation,
automatically apply advice, or use confidence as authorization. The real callback
and execution-journal counters must both remain zero. The host remains responsible
for baseline comparison, grounding, attribution, current-version validation,
authorization, and every memory write. There is no instance `baseline` option, no
label-bearing request, and no `.replays` property. The example module is only a
re-export of this typed implementation.

## Explicit config-to-Jev opt-in

`createConfiguredGoodMemoryShadowAdvisor` is exported from this same subpath. The
caller supplies a parsed `memory.shadow` subsection; this package loads no files,
`.env`, environment variables, or home-directory settings. Omitted configuration,
an omitted `enabled`, or `enabled: false` returns frozen `{ enabled: false }` before
reading any other field or dependency. Disabled configuration is intentionally
ignored, including unknown fields. Skip the evaluator entirely in this branch:
the host evaluator may inspect a provider name even when its own flag is false.

An enabled subsection can look like this (the environment-variable name is a
reference, never the key itself):

```json
{
  "enabled": true,
  "apiKeyEnv": "JEV_API_KEY",
  "model": "<explicit-model-pin>",
  "timeoutMs": 1000,
  "maxReplayRecords": 0
}
```

```ts
import { createConfiguredGoodMemoryShadowAdvisor } from '@cognitive-hub/core/goodmemory-shadow';

declare const memoryShadow: unknown; // Selected from the host's explicit config.
declare const readEnv: (name: string) => unknown; // The host owns credential lookup.
const configured = createConfiguredGoodMemoryShadowAdvisor(memoryShadow, { readEnv });
if (configured.enabled) {
  // Pass configured.provider to the host's strict shadow evaluator only here.
  // Evaluate only host-approved, source-grounded requests; never apply its advice.
}
```

Enabled configuration accepts exactly `enabled`, `apiKeyEnv`, `model`, `endpoint`,
`timeoutMs`, and `maxReplayRecords`. Raw `apiKey`, unknown/symbol fields, getters,
and `toJSON` hooks are rejected without invoking them or echoing their values.
Only plain objects with own data fields are accepted. `apiKeyEnv` must match
`[A-Za-z_][A-Za-z0-9_]*` and have at most 256 characters. The explicit nonblank model
is capped at 243 characters so the complete `cognitivehub:` provider name fits
the host's 256-character bound.

The required `readEnv(name)` callback runs once, after config validation. Its key
must be a nonblank string of at most 512 characters without control characters.
Missing/invalid keys or thrown resolver errors fail with fixed messages and codes;
no input values or error causes are exposed. The returned wrapper and provider
are frozen and contain no raw config, key, resolver, or credential-bearing public
state. Jev holds its key privately. JSON serialization does not expose it.

The factory creates a real `JevDecisionProvider` and the existing advisory bridge,
but construction makes no network call. Calling enabled advice sends the
host-approved request to `https://api.typesafe.ai/v1/systemone` by default, or to
the explicit HTTPS `endpoint` (maximum 2048 characters; no URL credentials, query,
or fragment). Choose an endpoint trusted to receive both the API key and request
data. The optional injected `fetch` is for a host-controlled transport or an
offline fake. Tests use only synthetic keys and fake responses.

The configured timeout applies to both Jev and the advisor, with a 1000 ms default
and the existing 1..2147483647 integer bound. History remains off by default and
opt-in retention stays bounded at 0..128. HTTP/auth/transport/schema failures flow
through the existing finite failure categories. Cancellation, abstention,
concurrency limits, zero dispatch, and host-owned stale-version checks are unchanged.
There is still no store, writer, automatic evaluation, or automatic application.

## Privacy and bounded diagnostics

Retention is off by default: `.history` is empty with omitted/zero
`maxReplayRecords`. Opting in accepts an integer from 1 through 128. The newest
completed calls replace older entries, in completion order. Every read returns a
copied, deeply frozen array of copied, frozen records; callers cannot mutate a
record or a previous view. There is no persistence, raw-record callback, or
unbounded history API in this first boundary.

Only these fields can be retained:

| Field | Debugging value | Privacy trade-off |
| --- | --- | --- |
| `providerRequestDigest` | Joins one host evaluation to its provider-visible input | A validated 64-character SHA-256-format digest, not source text; still linkable and not anonymization |
| `previousVersion` | Distinguishes the compared version and helps diagnose stale comparisons | Another validated hash; may correlate repeated evaluations of the same data |
| `decisionId` | Correlates the Hub decision when one was reached; null otherwise | Random Hub ID, without a source ID, user identity, or full record |
| `choice` | Shows the finite selected choice; null on failure | Reveals a coarse outcome only, never a memory value |
| `outcome` | Distinguishes advised, abstained, and failed calls | Finite coarse status; no raw step or run |
| `failureCategory` | Separates timeout, cancellation, malformed advice, provider failure, and internal failure | Fixed normalized enum; never raw error text or provider-controlled codes |
| `elapsedMs` | Reveals slow evaluation/drain waits | Duration only, without a wall-clock timestamp |
| `confidence` (optional) | Diagnoses provider calibration when a finite scalar in [0,1] is supplied | Model scalar only; no surrounding metadata, and no authority or success guarantee |
| `dispatched` | Detects a regression that reached the real capability execute callback | Numeric counter, expected zero; no action data |
| `journalEntries` | Detects a regression that created an execution-journal entry | Numeric counter, expected zero; no execution record |
| `cleanup` | Distinguishes completed plugin stop from a bounded wait that ended first | Only `pending` or `stopped`; not a raw error or a claim of forced cancellation |

No source text, source IDs, raw scope/user values, prompt, raw errors/reasons,
metadata, full Hub records, or evaluator labels are retained in this history.
Internal decision recording explicitly uses `recordFacts: false`, and the
request-local runtime uses hashed scope instead of raw identities. Internal stores
are not exposed or retained on the returned advisor. Nevertheless, the injected
decider necessarily receives the approved request while working: disabling history
does not erase data held by that decider, its transport, or an uncooperative pending
call. Host/provider logging and retention require their own policy.

## Timeouts, cancellation, and resource safety

`timeoutMs` is a positive integer no greater than 2147483647, default 1000. Each
advisor shares one concurrency-one limiter across its calls. A timed-out or
cancelled underlying decision continues occupying that slot until it actually
settles. A queued caller can time out or cancel without starting another vendor
call. Actual settlement makes the slot available again. To share a concurrency
limit across different advisor instances, the host must supply an already-shared
limiter; this factory's limit is per advisor instance.

Plugin shutdown waits for at most `min(timeoutMs, 100)` milliseconds after the
advisory call. Ending that wait does not release active leases or force-cancel
callbacks. `cleanup: 'pending'` describes the state at return and is never mutated
later, even when a late callback settles. These limits bound asynchronous waiting;
they cannot preempt synchronous JavaScript that blocks the event loop. No work is
scheduled automatically, and no live model call is part of the tests.

## Local file and tarball consumption

The explicit npm `files` list includes `dist`; `prepack` builds JavaScript and
`.d.ts` files before a local tarball is made. Generated `dist` and dependency trees
remain untracked. With the normal development dependencies already installed:

```sh
npm run test:goodmemory-shadow
npm pack --pack-destination /path/to/local/artifacts
```

The resulting local tgz can be installed by a test host using its normal
`file:/absolute/path/to/cognitive-hub-core-0.3.0.tgz` dependency workflow. A direct
`file:/absolute/path/to/checkout` consumer must use a built checkout (`npm run
build` first); it must not import example paths or TypeScript source internals.
This workflow requires no registry publication or version bump.

`npm run test:goodmemory-shadow` runs the small typed package consumer and focused
offline tests. They cover export isolation, diagnostic bounds/defaults/redaction,
immutable copies, input aliasing, abstention, invalid responses, normalized errors,
timeout/cancellation, shared slot retention/recovery, actual advisory preview,
`recordFacts: false`, and zero live dispatch/journal claims. The injected Jev test
uses a synthetic response only. These are contract tests, not online model-quality,
production-safety, or end-to-end memory-policy certification.
