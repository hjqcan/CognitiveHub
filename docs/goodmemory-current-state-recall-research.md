# Current-state recall facade research — v2 candidate

This unpublished, default-off file-path example adds a bounded read facade around
real GoodMemory `recall`, `diagnoseRecall` and `buildContext`. It does not change
GoodMemory source, Hub core, package exports/version, admission/update shadow,
deletion proposals or a production default. It repairs specific stale fallback
and packet races only when the host supplies complete independent state and
source authority. It is not a general GoodMemory consistency implementation.

## Exact baseline and observed defect

Anonymous remote checks on 2026-10-04 pinned Hub main to
`04d2ed2291cf0c7f333daacc39d10ee349727f92` and GoodMemory main to
`d4b78f3cea3a61a5a0d8bb121a69034ae4fa6ac6` (package version 0.8.2). Tests import
that GoodMemory **source under Bun**, not an older installed package or a newly
released package. Original user checkouts were not modified.

At that GoodMemory revision:

- `src/api/recallOrchestrator.ts` applies the observation fence around reranking,
  but that fence concerns derived observation support, not every ordinary record.
- `src/api/recallReranking.ts` catches reranker errors and returns its captured
  deterministic result. A source-bound advisor's failed postcheck rejects advice
  but does not reread this fallback.
- `src/api/createGoodMemory.ts:230` renders `input.recall.packet`; it does not
  establish that the packet remains current.

The paired fixture holds injected fake HTTP, changes an ordinary canonical fact
from Monday to Tuesday, then returns HTTP 503. With the original caller seam,
both recall and the subsequently built prompt still contain Monday. A second
baseline captures recall, updates storage afterward, then demonstrates the same
old prompt without any model. These are reproducible mechanism defects, not
semantic benchmark or live model-quality results.

## Host authority is a prerequisite

`createCurrentStateRecallHost` is imported from
`examples/goodmemory-four-lane/current-state-recall.mjs`. Missing/false `enabled`
returns `{ enabled: false }` without inspecting other dependencies. Enabled use
requires these explicit callbacks:

| Dependency | Required host contract |
| --- | --- |
| `createMemory(reranker)` | Construct the real GoodMemory instance with this adapter. Do not retain a raw alias for claimed fenced reads. |
| `readCurrent(fullScope, signal)` | Independently owned receipt with exactly `status`, `scopeDigest`, `revision`, `stable`. Scope has tenant/user/workspace/agent/session, absent dimensions represented as null. |
| `prepareRerank({input, plans, scope, state}, signal)` | Independently verify canonical membership, attribution, eligibility and source support, then approve/redact the exact final envelope. Returns a `createEnvelope` rerank envelope. |
| `alternativeOrder(input, signal)` | Return a complete finite permutation of the admitted input IDs. Identity and alternative are the only rank plans. |
| `advisor.evaluate(envelope, {signal})` | Reuse the existing configured source-bound advisor with its own independent `inspectCurrent`; no copied positive hash receipt. |
| `timeoutMs` | Optional common read deadline, integer 1–3000, default 3000. |

The revision must be non-reused, including A→B→A, and `stable` must exclude every
in-flight mutation. Its scope must cover **all** state affecting these reads:
canonical documents, source/support approval and revocation, recall policy,
derived support, projections, vectors, session state and clock-dependent
eligibility. Every relevant writer must participate in that same protocol,
including internal recall writes. A digest returned by an arbitrary callback
does not establish these properties. This module cannot enforce them for an
external SQLite/PostgreSQL writer, another process or a raw adapter alias.

The fixture's authority is deliberately narrow: independently registered exact
namespaces and explicit active canonical facts/references, approved collection/ID
membership, canonical text vocabulary before redaction, current canonical reads
and finally redacted facts in the binding. It does not approve derived
observations, all wildcard scopes, arbitrary evidence/source graphs or every
memory collection. Unsupported/ambiguous sources skip advice and retain a stable
baseline; they do not gain approval from a matching digest or model confidence.

## Behavior and integration

The facade checks the host revision before/after the entire actual recall, not
only around the model. It scopes reranker calls using `AsyncLocalStorage`; a
detached adapter has no caller scope and cannot transmit. Before/after advice it
checks the independent current-state receipt. Advice can only choose identity or
alternative over exactly the admitted IDs. Records/contents cannot be added or
rewritten. Non-advised, unauthorized/mutating/dispatching/journaling reports are
rejected. Query/document text must come from the host's final approved envelope.

### v2 report correlation

The facade independently reconstructs the complete schema-1 envelope and checks
its digest before calling the advisor. That digest includes the exact full scope,
host source/content/revision binding, approved redacted facts and finite choices.
An advised report must have exactly the existing configured-source report fields:
schema version 1, mode `research-shadow`, lane `rerank`, matching `requestDigest`,
two support checks, one provider call, a finite identity/alternative choice and
the unchanged zero-authority/mutation/dispatch/journal flags. Reports are detached
as supported ordinary data before validation; accessors are not invoked.

A foreign-scope report, a cached report from an earlier source binding, a wrong
schema/mode/lane/digest, missing source checks or a tampered envelope echo cannot
choose a plan. Stable deterministic recall remains usable on rejection; no extra
advisory request or reread is added solely for this report failure.

These are correlation and contract checks, not a signature or an independent
source oracle. An arbitrary advisor can fabricate matching hashes and counters.
The mandated configured source-bound advisor and its independently authoritative
`inspectCurrent` remain prerequisites; arbitrary/substituted advisors do not gain
authority from passing the report shape checks. The source/clock/writer protocol
and consumer migration omissions in this document are unchanged.

If a recall interval changes, it performs one complete reread with `rerank:false`
and rebuilds the baseline packet through GoodMemory. Another change fails closed
with static code `current_state_unavailable`. No additional advisory HTTP is sent
for this refresh. Unsupported/small windows and explicit no-rerank calls retain
normal baseline selection with the same outer state checks. Diagnosis is always
baseline-only and fenced.

Issued recall objects are immutable snapshots **within the data contract below**
and have private provenance. A later
`buildContext` accepts only this facade's issued object; cloned, deserialized or
foreign results are rejected. If the snapshot is old, it rereads the original
request without advice. It rechecks after rendering. There are at most two render
attempts, each refresh using at most two baseline read attempts. The common
deadline also bounds these nested attempts. Invalid/in-flight state is rejected,
not polled indefinitely.

Hosts that use records/metadata alongside the fragment should explicitly use the
new coherent-pair method:

```js
const host = createCurrentStateRecallHost({ enabled: true, ...trustedHostPorts });
const { recall, context } = await host.memory.recallAndBuildContext(
  { scope, query }, { output: 'system_prompt_fragment', maxTokens: 1000 }, { signal },
);
// Derive items, IDs, routing and any feedback steering from this same recall.
```

The method's positive test updates canonical memory during actual GoodMemory
context construction and verifies both returned records and prompt use Tuesday.
It establishes a consistent interval through the final host check; it cannot
make later prompt composition or model dispatch atomic with subsequent writes.

### v2 supported snapshot values

The facade supports acyclic ordinary data graphs composed of null, undefined,
booleans, strings, finite numbers, dense ordinary arrays, and ordinary objects
with `Object.prototype` or null prototype. Object properties must be own,
enumerable string-keyed data properties. Arrays have only their dense indexed
data properties and native length. Optional undefined properties are preserved,
so normal GoodMemory public records remain usable without JSON coercion. Shared
acyclic values are copied by value; alias identity is not preserved. Copying is
bounded to depth 64 and 100000 visited nodes per graph.

Inputs captured for recall, receipts/windows/envelopes/reports, and returned
recall/context values are detached through descriptor inspection into this
supported graph and deeply frozen. The coherent-pair container is also frozen.
Descriptors are checked before their values are read: getters are rejected
without invocation, and custom instances are not silently flattened by
`structuredClone`. Ordinary non-proxied data is required; adversarial Proxy traps
and synchronously blocking host objects/callbacks remain outside the contract.

Date, Map, Set, buffers/views/typed arrays, custom instances, accessors, symbol
properties/values, functions, bigint, non-finite numbers, sparse/extended arrays
and cyclic graphs are unsupported. Date/Map/Set internals cannot be made immutable
by `Object.freeze`; the facade rejects such values rather than returning a
misleading frozen object or changing their meaning into a string. GoodMemory's
`PreferenceMemory.value: unknown` is wider than this facade contract. No canonical
record is rewritten or deleted to fit it.

An unsupported request fails before base recall. An unsupported returned graph
fails with static `current_state_unavailable` after that read/render, without a
data-conversion reread loop. Advice or GoodMemory's own writes may already have
occurred before an unsupported result is inspected; result rejection does not
undo them. Prefer normalized ordinary values at the host boundary if this facade
is required. Existing two-read/two-render state-change bounds remain unchanged.

The facade neither resolves keys nor selects a live provider. The supplied
advisor retains the unchanged physical transport/reader slot after cancellation.
A timeout bounds the caller wait, not completion of every underlying read or
internal write. Writers must remain tracked until physical completion. A held
fake fetch followed by another request proves busy fallback without duplicate
HTTP. There are no implicit retries or alternate credentials/providers.

Other methods remain bound delegates to the real GoodMemory instance. Admission
and update keep the existing shadow policy; deletion is still an unauthorized
proposal with no delete capability. This research adapter grants no new mutation
authority. GoodMemory's own public recall can still mutate its store as described
below.

## Actual caller audit and deliberate omissions

No existing GoodMemory factory, caller or installed host was automatically
replaced. A host must inject this facade where dependencies permit it. The table
records the real source paths at the pinned revision, not an assertion that all
these paths were migrated or end-to-end tested.

| Caller | Observed path and remaining work |
| --- | --- |
| Core API | `src/api/createGoodMemory.ts:212,219,230`. Actual public recall/diagnose/context seam tested. Raw public instances and private engine/assembly aliases bypass the facade. |
| HTTP bridge | `src/http/index.ts:1343,1352,1361`. Calls recall then context, then derives items/hasContext/routing from the older recall. Needs coherent-pair adoption and error mapping; no HTTP server test here. |
| Installed MCP | `src/install/hostMcpServer.ts:184,191,267`. Context tool derives routing from old recall; search only uses recall. Factory/injection and coherent context routing remain unmodified. |
| Installed hooks | `src/install/hostHookRuntime.ts:581,587`. Builds fragment then returns prior recall and record IDs. Needs coherent-pair adoption; installation/runtime processes not exercised. |
| Runtime Kit | `src/runtime-kit/public.ts:438,448,513`. Real `beforeModelCall` test proves fresh built text can accompany old returned recall. It later steers from old feedback and separately exports raw carryover, outside the facade's final check. Must migrate both record use and subsequent composition; not fully repaired. |
| AI SDK | `src/ai-sdk/public.ts:263,710` uses Runtime Kit before generation. Inherits its omissions; no generation/streaming or live model run. |
| LangGraph | `src/langgraph/index.ts:372` uses recall but maps results to a separately captured namespace snapshot and adds BM25 fallback from that snapshot. The whole search needs its own outer fence; guarding only recall is insufficient. |
| Progressive recall | `src/progressive/recall.ts:293` calls recall then caches/expands candidate state across operations. Injected individual recalls can be fenced; multi-step index/read consistency is unproved. |
| Inspector | `src/inspector/adminApi.ts:486` takes recall for traces. Injection is unmodified; inspector backend/UI not tested. |
| CLI diagnosis | `src/cli/memory.ts:692` uses diagnoseRecall. Injected diagnosis is fenced without model; actual CLI construction unmodified. |
| Internal retrieval wrapper | `src/api/internalRetrievalRollout.ts:160,203` delegates public methods. Requires wrapping/injection order review; private internal calls bypass the facade. |
| Eval/replay consumers | `src/testing/scenarioReplay.ts` and `src/eval/{runners,longmemeval,implicitmembench-research,implicit-behavior,behavioral-adaptation,phase74FullRuntime}.ts` use public recall/context. No benchmark rerun or migration claim. |

Internal decomposition/multi-hop orchestration is inside an injected outer
public recall interval, but its eligibility/output semantics are not separately
covered by these fixtures. Episodes/archives can occur in the real reranker
window, but only facts and a reference receive positive source approval here.
Session buffers/journals, projection/vector-enabled retrieval, production
backends, cross-process writers and post-return mutation are not validated.

### Public recall itself can write

`src/api/goodMemoryAssembly.ts:149` enables post-recall observations by default.
`src/api/evolutionRuntime.ts:312` can apply verification pressure and persist
facts, experiences, learning proposals and promotion records. This is separate
from the removed access-count telemetry.

Positive tests fix the clock to 2026-01-02 with explicit 2026-01-01 sources and
verify no relevant self-write interval. A negative fixture uses the October clock
with those aged facts: public recall performs semantic/governance writes, both
read attempts change revision, and the strict facade fails closed. We do not use
an internal-only `postRecallMutations:false` switch to pretend public API support.
Until a host can provide a stable read transaction or GoodMemory exposes a
defensible public read mode, this facade is intentionally unusable for such
self-writing recalls. Merely accepting the later revision would bless possibly
stale captured output.

## Offline verification and limits

First build this Hub checkout with existing dependencies. Use an isolated,
pristine GoodMemory source checkout at the exact pinned commit and its required
dependencies. The supplied runner refuses a different head or modified tracked
`src` files; no key/configuration setup is required:

```sh
npm run build
node scripts/verify-goodmemory-current-state.mjs /absolute/GoodMemory /absolute/bun
```

The runner supplies a minimal environment, disables Bun dotenv loading,
automatic installs and implicit Bun config, and selects the exact source entry.
The fixture blocks ambient `fetch`; all HTTP is explicitly injected synthetic
transport. It stores parsed synthetic request bodies, not authentication headers.
Do not replace it with the user's existing `.env` or a real fetch to relabel this
suite as live validation.

Observed on Node 22.14.0 and Bun 1.3.14:

- v2 research runner: 48 passed, 0 failed: the unchanged 23 original seam cases
  plus 25 report/data-contract regression cases. Stable configured advice and
  deeply nested plain-value recall/context succeed. The new tests run against
  the preserved v1 implementation yielded 3 passes and 22 failures before the
  fix; some previously rejected types/cycles already passed their rejection gate.
- The reviewer's unchanged 27 independent tests passed against v2, including all
  four context forms, stable fresh October records and exact finite retry bounds.
  This is author rerun evidence, not a new independent v2 approval. The original
  v1 review/probes and candidate bytes are preserved separately for rereview.
- Existing Hub `npm run check`: typecheck/build/type-contract checks succeeded;
  327 Node tests passed. Admission/update/delete source remains unchanged.
- Related GoodMemory source suites: 125 passed, 2 PostgreSQL-dependent skipped,
  0 failed across recall API, touch helpers, observation validity, evidence-ledger
  context and Runtime Kit tests. No real PostgreSQL claim.
- Hub build succeeded. Full GoodMemory package build was attempted and stopped
  because the inspector workspace's Vite executable was absent in reused local
  dependencies. Source seam tests do not establish package/inspector build health.

No live API key was read or sent, no credential was created, and no npm
publication/default enablement or semantic-quality uplift is claimed. The earlier
single live admission abstention remains separate evidence. Promotion requires
real host-owned revision/source protocols and caller migrations, then separate
authorized validation; these fixtures cannot supply that authority.
Publication remains on hold pending independent review of these exact v2 bytes.
