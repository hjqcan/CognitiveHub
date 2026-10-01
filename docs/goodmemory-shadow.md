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
