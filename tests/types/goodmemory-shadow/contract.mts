import { createGoodMemoryShadowAdvisor } from '@cognitive-hub/core/goodmemory-shadow';
import type { GoodMemoryShadowAdvisor, GoodMemoryShadowRequest, GoodMemoryShadowHistoryRecord } from '@cognitive-hub/core/goodmemory-shadow';
import type { DecisionProvider } from '@cognitive-hub/core';

// Intentionally independent structural consumer: no GoodMemory runtime dependency.
interface HostRequest {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly previousVersion: string;
  readonly scope: { readonly userId: string; readonly sessionId?: string };
  readonly source: { readonly id: string; readonly content: string };
  readonly previous: { readonly sources: readonly { readonly id: string; readonly content: string }[]; readonly record: unknown };
  readonly allowedChoices: readonly ('keep' | 'supersede' | 'abstain')[];
  readonly candidate: { readonly content: string };
}
interface HostProvider {
  readonly name: string;
  advise(request: HostRequest, signal: AbortSignal): Promise<unknown>;
}
declare const decision: DecisionProvider;
declare const request: HostRequest;
declare const signal: AbortSignal;
const provider: GoodMemoryShadowAdvisor = createGoodMemoryShadowAdvisor({ decision, timeoutMs: 20, maxReplayRecords: 2 });
const host: HostProvider = provider;
const accepted: GoodMemoryShadowRequest = request;
const answer: Promise<unknown> = host.advise(request, signal);
const record: GoodMemoryShadowHistoryRecord | undefined = provider.history[0];
void [accepted, answer, record];
// @ts-expect-error Host labels are never model bridge options.
createGoodMemoryShadowAdvisor({ decision, baseline: 'keep' });
// @ts-expect-error Retention is immutable to consumers.
provider.history.push({} as GoodMemoryShadowHistoryRecord);
// @ts-expect-error Full unredacted replays are not exposed.
provider.replays;
// @ts-expect-error Advice is unknown until the host validates it.
(await answer).choice;
if (record) {
  // @ts-expect-error Scalar diagnostics are immutable too.
  record.cleanup = 'stopped';
}
