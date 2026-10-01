# GoodMemory four-lane exploration

This is an opt-in, source/example-only research checkpoint. It does not install a
production hook, change GoodMemory's default behavior, add a package export, or
authorize a deletion. It uses fake decision providers and isolated synthetic
stores. No live Jev accuracy, relevance improvement, cost or latency claim follows.

The separate `goodmemory-shadow` package subpath supports default-off Jev
configuration. These four-lane examples inject a `DecisionProvider` explicitly;
they do not discover config files, load credentials or activate themselves.

## Four different boundaries

| Lane | Real integration exercised | Experimental authority and fallback | First checkpoint's gaps |
| --- | --- | --- | --- |
| Write admission | `GoodMemoryPolicyHooks.shouldRemember` during real `remember` | Shadow returns the original baseline. Explicit `synthetic-veto` may only narrow it; missing proof, invalid advice or abstention rejects the candidate in that isolated mode | Hook receives post-policy candidate text, not complete canonical source records. Source persistence and generated episodes are separate. Imports/explicit feedback have additional paths |
| Conflict update | `resolveConflict` during real reference replacement | Exact prior record/evidence/source binding before and after advice. The example offers supersede only for a fixture-owned newer incoming clock; isolated treatment may veto, never expand baseline permission | Reference-only replay. Preferences retain their separate deterministic chronology/CAS and existing shadow evaluator; profile, revision, imports and explicit feedback are not silently intercepted |
| Deletion judgment | A proposal over real exported synthetic memory | `retain` / `propose_delete` only. Exact collection, ID, full scope and record/support digest; explicit-intent and recovery-manifest binding; every result remains `authorized:false`. No `forget`, `deleteAllMemory` or store writer is given to Hub | The recovery exercise removes/restores one entry in a separate fixture Map. It is not a public GoodMemory hard-delete undo proof or confirmation implementation |
| Recall rerank | Public `adapters.reranker` during real `recall` | One choice between two host-frozen complete ordering plans. Only existing exact IDs receive mechanically derived scores. Any invalid advice or callback failure yields a fixed error and GoodMemory's original-order fallback | This is an order-plan selector, not arbitrary listwise ranking. Existing pool covers facts/references/episodes/archives, at least two candidates, once after public recall merging. Notes/preferences/profile/feedback and internal diagnostic paths are outside that seam |

`admit` and `supersede` are advice. In the isolated treatment, they merely allow
the existing GoodMemory writer to continue under its own guards. A rejected
baseline is never revived. Do not treat a proposal report's `memoryMutated:false`
as a claim that the entire host run has no writes: baseline/treatment `remember`
runs do write synthetic memory, and the replay counts those records separately.

## Contract, privacy and budget

`advisor.mjs` defines a separate versioned envelope, rather than broadening the
preference-only v1 package contract. It binds lane, all five explicit scope
dimensions, a caller-owned state hash, bounded JSON facts and finite choices.
The baseline/oracle stays outside provider facts. `createEnvelope` deep-copies and
freezes data, limits request size to 128 KiB, and requires abstention. Invalid
inputs and advice fail closed. A digest proves consistency, not source truth,
actor authority or completeness; trusted host preparation still owns those facts.

Each enabled evaluation performs a real `PluginHost` / `IntentRuntime` advisory
step, with one-decision budget, no execution grant, hard-failing execute callback,
and actual dispatch/journal counters. A shared concurrency-one limiter retains
an uncooperative decision's slot until actual settlement. There is no history or
automatic persistence. Optional host diagnostic callbacks receive only the report;
sync throws and rejected promises cannot control the memory pipeline.

The advisor timeout defaults to 1000 ms, caps at 3000 ms, and covers its version
reads and Hub/provider waiting. Plugin cleanup has a separate bounded drain wait
of `min(timeoutMs, 100)`. It cannot preempt synchronous JavaScript or forcibly stop
an uncooperative provider. Host `baseline`, `prepare`, `alternativeOrder`, their
closures and backends are trusted caller code outside this timer. Do not claim an
end-to-end adapter latency bound. Shallow option freezing prevents later switch
changes; it does not freeze external services or closure state.

## Run the development comparator

Build CognitiveHub normally, then use an explicit GoodMemory module entry from a
locally built source/tarball candidate containing preference source evidence.
Registry `goodmemory@0.8.1` does not contain the experimental shadow additions.

```sh
npm run build
node --test tests/goodmemory-four-lane.test.mjs
node examples/goodmemory-four-lane/development-replay.mjs \
  /path/to/installed/goodmemory/dist/index.js /tmp/four-lane-report
```

The replay creates isolated in-memory stores and executes public `remember`,
`resolveConflict`, `recall` and `exportMemory` paths. It writes synthetic evidence
only to the explicitly supplied output directory. Never substitute real user
stores or attach this treatment to production by copying the example unchanged.

## Observed mechanism results, 2026-10-01

- Development replay: 20 scenario groups: admission 5, reference update 6,
  deletion proposal 4, recall rerank 5. Admission/update run paired baseline,
  shadow and explicit isolated-veto variants
- Shadow preserved baseline storage results. A candidate veto still retained
  its source message, demonstrating why this is not a universal persistence gate
- Reference treatment kept the old target on abstention and on older/equal/missing
  incoming observation clocks. This is a deliberately stricter experimental
  reference policy, not a claim that all write paths use it
- Actual public recall changed the same admitted pool from `a,b,c` to `c,b,a`;
  abstention and invalid decisions restored `a,b,c`. A different user's record
  never entered the reranker pool. This demonstrates ordering control, not better
  semantic relevance; GoodMemory's generic trace still labels its custom scorer
  as pointwise even though this adapter selects a bounded order plan
- Real GoodMemory deletion calls and Hub dispatch/journal counts were zero
- Fourteen focused mechanism tests pass, including callback errors, option/input
  aliasing and timeout slot retention/recovery
- A separately authored, pre-sealed 16-case mechanism holdout passed its v1 first
  run, four per lane. Subsequent independent source review found three gaps:
  async diagnostic rejection, raw plan-callback errors and a truthy non-boolean
  reranker switch. These were fixed in v2, plus a retained-options mutation issue
  found in self-review; the unchanged 16 cases and the new review probes passed
  again. The second run is a repair regression, not a new blind quality result

These tests do not establish automatic-write quality, successful permanent-delete
recovery, race-free storage CAS beyond GoodMemory's real writer, full recall-kind
coverage, online Jev improvement, or production readiness. A production deletion
design still needs an explicit collection-qualified, version-checked reversible
operation and a separate user-authority/confirmation contract.
