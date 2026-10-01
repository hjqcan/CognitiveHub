import { createGoodMemoryShadowAdvisor, createConfiguredGoodMemoryShadowAdvisor } from '@cognitive-hub/core/goodmemory-shadow';
import type { GoodMemoryShadowAdvisor, GoodMemoryShadowRequest, GoodMemoryShadowHistoryRecord, GoodMemoryShadowConfig, ConfiguredGoodMemoryShadowAdvisor, GoodMemoryShadowConfigDependencies } from '@cognitive-hub/core/goodmemory-shadow';
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

const config: GoodMemoryShadowConfig = { enabled: true, apiKeyEnv: 'JEV_API_KEY', model: 'offline-explicit-pin' };
const deps: GoodMemoryShadowConfigDependencies = { readEnv: _name => 'synthetic-fixture-key' };
const configured: ConfiguredGoodMemoryShadowAdvisor = createConfiguredGoodMemoryShadowAdvisor(config, deps);
if (configured.enabled) {
  const configuredHost: HostProvider = configured.provider;
  const configuredAnswer: Promise<unknown> = configuredHost.advise(request, signal);
  void configuredAnswer;
  // @ts-expect-error Config state is immutable.
  configured.provider = provider;
} else {
  // @ts-expect-error Disabled state has no provider to accidentally evaluate.
  configured.provider;
}
// @ts-expect-error Credentials are never exposed on config state.
configured.apiKey;
// @ts-expect-error Raw keys are not part of the accepted configuration schema.
const rawConfig: GoodMemoryShadowConfig = { enabled: true, apiKey: 'placeholder', model: 'pin' };
// @ts-expect-error Enabled config requires an explicit model.
const missingModel: GoodMemoryShadowConfig = { enabled: true, apiKeyEnv: 'JEV_API_KEY' };
// @ts-expect-error Config state is immutable.
configured.enabled = false;
void [rawConfig, missingModel, createConfiguredGoodMemoryShadowAdvisor()];
