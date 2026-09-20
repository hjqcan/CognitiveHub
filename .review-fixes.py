from pathlib import Path
root = Path('.')
def load(p): return (root / p).read_text()
def save(p,s): (root / p).write_text(s)
def replace(s,a,b,n=1):
    assert s.count(a)==n, (a[:100],s.count(a),n)
    return s.replace(a,b)

p='src/plugins.ts';s=load(p)
s=replace(s,'  #starting = false;','  #starting = false;\n  #activation = 0; // Never reused, including after uninstall/reinstall.')
s=replace(s,"    mount.status = 'starting'; mount.activation++;", "    ensure(Number.isSafeInteger(this.#activation + 1), 'activation-limit', 'Plugin activation counter exhausted');\n    mount.status = 'starting'; mount.activation = ++this.#activation;")
s=replace(s,'acquire(pluginId: string, capabilityId: string, activation: number, scope: Scope): CapabilityLease {','acquire(pluginId: string, capabilityId: string, activation: number, scope: Scope, pluginVersion?: string): CapabilityLease {')
s=replace(s,'r.capability.id === capabilityId && r.activation === activation);','r.capability.id === capabilityId && r.activation === activation &&\n      (pluginVersion === undefined || r.pluginVersion === pluginVersion));')
save(p,s)
p='src/contracts.ts';s=load(p)
s=replace(s,'  readonly idempotencyKey: string;','  readonly idempotencyKey: string;\n  /** Exclusive latest dispatch time (epoch ms). Host gateways must enforce it before their own side effect. */\n  readonly dispatchDeadlineAt?: number;')
s=replace(s,'  /** The host authenticates responses and reproposes against fresh state. */','  /** At-least-once delivery: deduplicate by request.id. The host authenticates responses and reproposes against fresh state. */')
save(p,s)
p='src/hub.ts';s=load(p)
s=replace(s,'registration.capability.id, registration.activation, intent.scope);','registration.capability.id, registration.activation, intent.scope, registration.pluginVersion);')
s=replace(s,'    options: { live?: boolean; signal?: AbortSignal } = {}): Promise<ExecutionResult> {','    options: { live?: boolean; signal?: AbortSignal; deadlineAt?: number } = {}): Promise<ExecutionResult> {')
s=replace(s,"    identifier(operationId, 'operation id');", "    identifier(operationId, 'operation id');\n    if (options.deadlineAt !== undefined)\n      ensure(Number.isFinite(options.deadlineAt), 'invalid-deadline', 'Dispatch deadline must be finite');")
s=replace(s,"      ensure(proposal.expiresAt > this.#now(), 'stale-proposal', 'Proposal has expired');\n      lease = this.#options.plugins.acquire(action.pluginId, action.capability, action.activation, intent.scope);", "      ensure(proposal.expiresAt > this.#now(), 'stale-proposal', 'Proposal has expired');\n      const deadlineAt = Math.min(proposal.expiresAt, options.deadlineAt ?? Infinity);\n      ensure(deadlineAt > this.#now(), 'dispatch-expired', 'Dispatch authorization has expired');\n      lease = this.#options.plugins.acquire(action.pluginId, action.capability, action.activation, intent.scope, action.pluginVersion);")
s=replace(s,'const ctx: ExecutionContext = Object.freeze({ intent, observation, action, operationId, idempotencyKey: id, signal });','const ctx: ExecutionContext = Object.freeze({ intent, observation, action, operationId, idempotencyKey: id, signal,\n          dispatchDeadlineAt: Math.min(deadlineAt, observation.validUntil) });')
s=replace(s,"        ensure(proposal.expiresAt > this.#now() && observation.validUntil > this.#now(), 'stale-proposal', 'Proposal expired in preflight');", "        ensure(proposal.expiresAt > this.#now() && observation.validUntil > this.#now(), 'stale-proposal', 'Proposal expired in preflight');\n        ensure(ctx.dispatchDeadlineAt! > this.#now(), 'dispatch-expired', 'Dispatch authorization expired in preflight');")
s=replace(s,": context.observation.validUntil <= now ? 'observation-expired'", ": context.observation.validUntil <= now ? 'observation-expired'\n        : context.dispatchDeadlineAt! <= now ? 'dispatch-expired'")
s=replace(s,"            signal => capability.execute({ ...context, signal })));", "            signal => {\n              // Check at callback entry too: claim/audit hooks and queued microtasks can consume the remaining time.\n              if (context.dispatchDeadlineAt! <= this.#now())\n                return Promise.resolve<Receipt>({ status: 'failed', reason: 'dispatch-expired', evidence: null });\n              return capability.execute({ ...context, signal });\n            }));")
save(p,s)
p='src/run.ts';s=load(p)
s=replace(s,'ExecutionRecord, Guidance, Intent, Json, Observation','DeliberationRequest, ExecutionRecord, Guidance, Intent, Json, Observation')
s=replace(s,"  readonly status: RunStatus;", "  readonly status: RunStatus;\n  /** Sticky host intent, independent of waiting/recovery status. Absent in legacy v0.2 snapshots. */\n  readonly stopRequested?: boolean;\n  /** Event consumption and the resulting state change are committed in the same Run CAS. */\n  readonly processedEvents?: readonly string[];\n  /** Single outstanding notification, atomically persisted with request/status before external delivery. */\n  readonly outbox?: { readonly message: DeliberationRequest; readonly delivered: boolean; readonly retryAt: number } | null;")
s=replace(s,'  /** Records an event key for a run; returns false when it was seen before. */','  /** Legacy standalone deduplication API. IntentRuntime uses Run.processedEvents plus one CAS instead. */')
save(p,s)
p='src/runtime.ts';s=load(p)
s=replace(s,"import type { ExecutionRecord, Guidance, Intent, Json, Observation, ProposalResult }", "import type { DeliberationRequest, ExecutionRecord, Guidance, Intent, Json, Observation, ProposalResult }")
s=replace(s,"const intentKey = (intent: Intent): string => canonical([intent.scope, intent.id]);", "const intentKey = (intent: Intent): string => canonical([intent.scope, intent.id]);\nconst stopping = (run: Run): boolean => run.stopRequested === true || run.status === 'stopping';")
s=replace(s,"    // Requests raised inside hub.propose() are tagged with the run being stepped, so the host knows what to answer.\n","    // Managed requests are returned by propose(), then persisted with their Run before delivery.\n    // Direct users of runtime.hub retain the single-turn provider behavior.\n")
s=replace(s,"      await host.request(runId === undefined ? request : immutable({ ...request, runId, kind: 'decision', subject: null }));", "      if (runId === undefined) await host.request(request);")
s=replace(s,"      status: 'active', operations: [], wait: [], request: null, approved: null, answers: [],", "      status: 'active', stopRequested: false, processedEvents: [], outbox: null,\n      operations: [], wait: [], request: null, approved: null, answers: [],")
s=replace(s,"      (r.status === 'waiting' && r.wait.some(c => c.kind === 'time' && now >= c.at))).map(r => r.id);", "      (r.status === 'waiting' && r.wait.some(c => c.kind === 'time' && now >= c.at)) ||\n      (r.status === 'deliberating' && r.outbox && !r.outbox.delivered && now >= r.outbox.retryAt)).map(r => r.id);")
s=replace(s,"      if (run.status === 'deliberating') return { run, outcome: 'deliberating' };\n",'')
s=replace(s,"    const hubSignal = signal ? { signal } : {};", "    const hubSignal = signal ? { signal } : {};\n    if (draft.run.status === 'deliberating') {\n      await this.#flushOutbox(draft);\n      return 'deliberating';\n    }")
s=replace(s,"    if (draft.run.status === 'stopping') {", "    if (stopping(draft.run)) {")
s=replace(s,'budget.deadlineAt !== null && now >= budget.deadlineAt','budget.deadlineAt !== null && this.#now() >= budget.deadlineAt')
s=replace(s,"      await save({ status: 'deliberating', request: { id: proposal.request.id, kind: 'decision', subject: null },\n        wait: [{ kind: 'deliberation', requestId: proposal.request.id }] });\n      this.#emit('run.deliberating', { runId: draft.run.id, requestId: proposal.request.id, kind: 'decision' });\n      return 'deliberating';", "      return this.#parkRequest(draft, 'decision', immutable({ ...proposal.request,\n        runId: draft.run.id, kind: 'decision', subject: null }));")
s=replace(s,"    try {\n      // 8. Approval gate", "    try {\n      // Recheck the Run deadline after every slow decision; hub.execute enforces it again after preflight/claim.\n      if (budget.deadlineAt !== null && this.#now() >= budget.deadlineAt)\n        return this.#deliberate(draft, 'budget', 'The run deadline has passed', { deadlineAt: budget.deadlineAt }, proposal.stateVersion);\n      // 8. Approval gate")
s=replace(s,'approved.expiresAt > now','approved.expiresAt > this.#now()')
s=replace(s,"      // 9. Persist the operation before dispatch", "      const deadlineAt = Math.min(budget.deadlineAt ?? Infinity,\n        draft.run.approval === 'each-action' ? draft.run.approved!.expiresAt : Infinity);\n      // 9. Persist the operation before dispatch")
s=replace(s,"this.hub.execute(proposal.id, operationId, { live: true, ...hubSignal })", "this.hub.execute(proposal.id, operationId, { live: true, ...hubSignal,\n        ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) })")
s=replace(s,"{ status, wait: [], request: null, approved: null, outcome, lease: null }", "{ status, wait: [], request: null, outbox: null, approved: null, outcome, lease: null }")
a=s.index('  async #deliberate(');b=s.index('\n  /** Hand the run an external event.', a)
s=s[:a]+'''  async #deliberate(draft: Draft, kind: RequestKind, reason: string, subject: Json, stateVersion: string | null): Promise<StepOutcome> {
    const run = draft.run;
    return this.#parkRequest(draft, kind, immutable({ id: newId(), intent: run.intent, stateVersion, reason,
      createdAt: this.#now(), runId: run.id, kind, subject }));
  }
  /** The waiting state and full notification form one transaction in the Run store (inline outbox). */
  async #parkRequest(draft: Draft, kind: RequestKind, message: DeliberationRequest): Promise<StepOutcome> {
    const run = draft.run;
    draft.run = await this.#save(run, { status: 'deliberating', stopRequested: stopping(run),
      request: { id: message.id, kind, subject: message.subject ?? null },
      wait: [{ kind: 'deliberation', requestId: message.id }],
      outbox: { message, delivered: false, retryAt: this.#now() } });
    await this.#flushOutbox(draft);
    this.#emit('run.deliberating', { runId: run.id, requestId: message.id, kind });
    return 'deliberating';
  }
  /** At-least-once with a stable ID. The provider must deduplicate if delivery succeeds but acknowledgment is lost. */
  async #flushOutbox(draft: Draft): Promise<void> {
    const item = draft.run.outbox;
    if (!item || item.delivered || draft.run.request?.id !== item.message.id) return;
    const pending = { ...item, retryAt: this.#now() + draft.run.waitMs };
    draft.run = await this.#save(draft.run, { outbox: pending });
    // On either delivery or acknowledgment failure, the original message remains recoverable.
    await bounded(this.#timeout, undefined, () => this.#options.deliberation.request(item.message));
    draft.run = await this.#save(draft.run, { outbox: { ...pending, delivered: true } });
  }
''' +s[b:]
a=s.index('      if (!(await this.runs.markEvent(id, event.key)))');b=s.index("      this.#emit('run.woken'", a)
s=s[:a]+'''      if ((run.processedEvents ?? []).includes(event.key)) {
        this.#emit('run.event.duplicate', { runId: id, key: event.key }); return { accepted: false, woke: false };
      }
      if (runTerminal(run.status)) {
        this.#emit('run.event.ignored', { runId: id, key: event.key, status: run.status }); return { accepted: false, woke: false };
      }
      const now = this.#now();
      const woke = (run.status === 'waiting' || run.status === 'stopping') && (event.type === 'host' || run.wait.some(c =>
        c.kind === 'state' ? event.type === 'state-changed' && field(event.data, 'version') !== c.version
        : c.kind === 'execution' ? event.type === 'execution-updated' && field(event.data, 'recordId') === c.recordId
        : c.kind === 'time' ? event.type === 'timer' && now >= c.at : false));
      // No separate markEvent write: a failed CAS consumes nothing, and a lost acknowledgment is safely deduplicated.
      await this.#save(run, { processedEvents: [...(run.processedEvents ?? []), event.key],
        ...(woke && run.status === 'waiting' ? { status: stopping(run) ? 'stopping' as const : 'active' as const, wait: [] } : {}) });
      if (!woke) return { accepted: true, woke: false };
''' +s[b:]
s=replace(s,"const resumed = run.status === 'paused' ? 'paused' : 'active';", "const resumed = run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active';")
s=replace(s,"patch = (await this.#open(run)) ? { status: 'stopping', request: null, wait: [], approved: null, outcome }\n            : { status: 'stopped', request: null, wait: [], approved: null, outcome, lease: null };", "patch = (await this.#open(run)) ? { status: 'stopping', stopRequested: true, request: null, wait: [], approved: null, outcome }\n            : { status: 'stopped', stopRequested: true, request: null, wait: [], approved: null, outcome, lease: null };")
s=replace(s,"{ ...patch, answers: [...run.answers,", "{ ...patch, outbox: null, answers: [...run.answers,")
s=replace(s,"runTerminal(run.status) || run.status === 'stopping'", "runTerminal(run.status) || stopping(run)")
s=replace(s,"status: run.request ? 'deliberating' : 'active'", "status: run.request ? 'deliberating' : stopping(run) ? 'stopping' : 'active'")
s=replace(s,"{ status: 'stopping', request: null, approved: null, wait: [], outcome }", "{ status: 'stopping', stopRequested: true, request: null, outbox: null, approved: null, wait: [], outcome }")
s=replace(s,"{ status: 'stopped', request: null, approved: null, wait: [], outcome, lease: null }", "{ status: 'stopped', stopRequested: true, request: null, outbox: null, approved: null, wait: [], outcome, lease: null }")
s=replace(s,"intent, request: null, approved: null, wait: [], counters:", "intent, request: null, outbox: null, approved: null, wait: [], counters:")
s=replace(s,"status: run.status === 'paused' || run.status === 'stopping' ? run.status : 'active'", "status: run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active'")
s=replace(s,"request: null, wait: [], status: run.status === 'paused' ? 'paused' : 'active'", "request: null, outbox: null, wait: [], status: run.status === 'paused' ? 'paused' : stopping(run) ? 'stopping' : 'active'")
save(p,s)
p='src/pg.ts';s=load(p)
s=replace(s,'export const SCHEMA_VERSION = 2;', 'export const SCHEMA_VERSION = 3;')
s=replace(s,"  `CREATE UNIQUE INDEX IF NOT EXISTS cognitive_hub_runs_one_unsettled_per_intent ON cognitive_hub_runs (tenant, intent_id)\n     WHERE status NOT IN ('completed', 'failed', 'stopped')`,", "  `CREATE UNIQUE INDEX IF NOT EXISTS cognitive_hub_runs_one_unsettled_per_scope_intent\n     ON cognitive_hub_runs ((data #> '{intent,scope}'), intent_id)\n     WHERE status NOT IN ('completed', 'failed', 'stopped')`,")
s=replace(s,"  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (2, extract(epoch from now()) * 1000)\n     ON CONFLICT (version) DO NOTHING`,", "  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (2, extract(epoch from now()) * 1000)\n     ON CONFLICT (version) DO NOTHING`,\n  // v3: install the scoped replacement before dropping the v1 index; preserve legacy event receipts.\n  `DROP INDEX IF EXISTS cognitive_hub_runs_one_unsettled_per_intent`,\n  `UPDATE cognitive_hub_runs r SET data = jsonb_set(r.data, '{processedEvents}',\n     COALESCE((SELECT jsonb_agg(e.key ORDER BY e.key) FROM cognitive_hub_run_events e WHERE e.run_id = r.id), '[]'::jsonb))\n     WHERE NOT (r.data ? 'processedEvents')`,\n  `INSERT INTO cognitive_hub_schema (version, applied_at) VALUES (3, extract(epoch from now()) * 1000)\n     ON CONFLICT (version) DO NOTHING`,")
s=replace(s,"  if (run.status === 'active' || run.status === 'stopping') return run.updatedAt;", "  if (run.status === 'active' || run.status === 'stopping') return run.updatedAt;\n  if (run.status === 'deliberating' && run.outbox && !run.outbox.delivered) return run.outbox.retryAt;")
save(p,s)
p='src/memory.ts';s=load(p)
s=replace(s,"    for (const key of events) { identifier(key, 'event key'); this.#events.add(key); }", "    for (const key of events) {\n      identifier(key, 'event key'); this.#events.add(key);\n      const pair: unknown = JSON.parse(key);\n      ensure(Array.isArray(pair) && pair.length === 2 && pair.every(x => typeof x === 'string'), 'invalid-event', 'Invalid exported event key');\n      const run = this.#runs.get(pair[0] as string);\n      if (run && !(run.processedEvents ?? []).includes(pair[1] as string))\n        this.#runs.set(run.id, immutable({ ...run, processedEvents: [...(run.processedEvents ?? []), pair[1] as string] }));\n    }")
save(p,s)
p='tests/stores.test.mjs';s=load(p)
s=replace(s,'[1, 2]); assert.equal(SCHEMA_VERSION, 2);','Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1)); assert.equal(SCHEMA_VERSION, 3);')
save(p,s)
