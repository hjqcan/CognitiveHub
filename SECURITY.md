# Security and operational boundary

This is a development foundation, not a safety-certified robot controller or a sandbox.

In-process plugins are trusted code with the process's privileges. A manifest, scope, or policy hook does not sandbox malicious plugin code. Do not install unreviewed modules or let a model select arbitrary code to load. Remote workers and least-privilege gateways are a future integration boundary, not an implemented security guarantee.

The host must remain authoritative for identity, current grants, intent revisions, task/resource ownership, conditional writes, and physical safety. `live: true` is only an opt-in switch. A plugin's description or reported effect type cannot grant authority.

Use stable operation IDs and canonical resource names. Propagate idempotency keys to the real executor. A timeout can conceal a successful external effect: reconcile it; do not blindly retry. The memory journal can be exported as JSON and rebuilt by a later process, which then re-binds open records to the exact same plugin version for queries only; the export contains business data and needs the same governance as the journal. It does not coordinate multiple processes: one hub drives a journal at a time. Do not run production irreversible actions until a durable journal, ownership leases and executor-side deduplication are implemented and tested.

Jev requests transmit supplied state to the configured HTTPS endpoint. Only provide task-relevant, approved data; never API credentials, private logs, or unrestricted sensor content. Redirects are rejected. API error bodies are not echoed. Input/response byte limits are enforced. These controls do not prevent semantic prompt injection; host authorization still applies.

The PostgreSQL adapters take an injected client and issue only parameterized statements; they never interpolate data into SQL. The host owns credentials, pooling, TLS and the DDL rights `migrate()` needs. The `data` columns hold the same business data as the memory journal.

Decision records store the full request the decider saw, including observation facts and bound candidate inputs; govern them like the journal. `scripts/replay.mjs --reevaluate jev` sends recorded state to the external API and only runs with an explicitly provided key.

Memory journals and deliberation inboxes contain business data. They require host-side access control, retention, deletion, and encrypted persistence before production. The event sink is observability, not a durable security audit.

Do not commit `.env`, live API keys, production traces, or customer data. If reporting a vulnerability, avoid publishing secrets or weaponized details in public issues; use GitHub private vulnerability reporting if the repository enables it, otherwise contact the maintainer privately.
