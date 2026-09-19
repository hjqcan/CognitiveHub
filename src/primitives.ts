import type { BoundAction, ExecutionRecord, Json, Receipt, Scope } from './contracts.js';

export class HubError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HubError'; }
}
export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new HubError(code, message);
}
export function identifier(value: string, name: string): void {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= 512,
    'invalid-contract', `${name} must be a nonempty string (max 512 characters)`);
}
export function validScope(scope: Scope, allowRoot = false): void {
  ensure(Array.isArray(scope) && (allowRoot || scope.length > 0), 'invalid-scope', 'A tenant scope is required');
  scope.forEach(part => identifier(part, 'scope segment'));
}
export function visible(mount: Scope, target: Scope): boolean {
  return mount.length <= target.length && mount.every((part, i) => part === target[i]);
}
/** Fail on non-JSON values rather than silently coercing NaN/undefined. */
export function assertJson(value: unknown, seen = new Set<unknown>()): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  ensure(typeof value === 'object' && value !== null, 'invalid-json', 'Expected finite JSON data');
  ensure(!seen.has(value), 'invalid-json', 'Cyclic data is not supported');
  ensure(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null, 'invalid-json', 'Expected a plain JSON object');
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, seen);
  seen.delete(value);
}
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  };
  freeze(copy);
  return copy;
}
export function canonical(value: unknown): string {
  assertJson(value);
  const sort = (v: Json): Json => Array.isArray(v) ? v.map(sort) :
    v !== null && typeof v === 'object' ? Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)])
    ) : v;
  return JSON.stringify(sort(value));
}
export const newId = (): string => crypto.randomUUID();

type JsonObject = { readonly [key: string]: Json };
const jsonObject = (value: Json | undefined, code: string, name: string): JsonObject => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), code, `${name} must be a JSON object`);
  return value as JsonObject;
};
/** What a bound action would do. Excludes the process-local activation and the model-facing description. */
export function actionIdentity(action: BoundAction): Json {
  return { pluginId: action.pluginId, pluginVersion: action.pluginVersion, capability: action.capability, key: action.key,
    input: action.input, resources: action.resources, effect: action.effect, scope: action.scope };
}
export function assertReceipt(value: unknown): asserts value is Receipt {
  assertJson(value);
  const receipt = jsonObject(value, 'invalid-receipt', 'Receipt');
  const status = receipt.status;
  ensure(status === 'accepted' || status === 'completed' || status === 'failed' || status === 'unknown',
    'invalid-receipt', 'Unknown receipt status');
  if (status === 'accepted') identifier(receipt.handle as string, 'task handle');
  if (status === 'failed' || status === 'unknown') identifier(receipt.reason as string, 'receipt reason');
  if (status !== 'unknown') ensure(Object.hasOwn(receipt, 'evidence'), 'invalid-receipt', 'Receipt evidence is required');
}
const STATUSES: readonly string[] = ['submitted', 'pending', 'unknown', 'verified', 'failed'];
/** Shape check for records loaded from a journal. Fails closed: the hub only adopts what it can validate. */
export function assertRecord(value: unknown): asserts value is ExecutionRecord {
  assertJson(value);
  const record = jsonObject(value, 'invalid-record', 'Execution record');
  identifier(record.id as string, 'record id');
  identifier(record.operationId as string, 'operation id');
  identifier(record.fingerprint as string, 'fingerprint');
  ensure(typeof record.status === 'string' && STATUSES.includes(record.status), 'invalid-record', 'Unknown execution status');
  ensure(Number.isInteger(record.revision) && (record.revision as number) >= 0, 'invalid-record', 'Revision must be a non-negative integer');
  ensure(Number.isFinite(record.createdAt) && Number.isFinite(record.updatedAt), 'invalid-record', 'Record timestamps must be finite');
  ensure(Object.hasOwn(record, 'receipt') && Object.hasOwn(record, 'evidence'), 'invalid-record', 'Record receipt and evidence are required');
  const intent = jsonObject(record.intent, 'invalid-record', 'Record intent');
  identifier(intent.id as string, 'intent id');
  validScope(intent.scope as Scope);
  identifier(jsonObject(record.observation, 'invalid-record', 'Record observation').version as string, 'state version');
  const action = jsonObject(record.action, 'invalid-record', 'Record action');
  for (const key of ['pluginId', 'pluginVersion', 'capability', 'key'] as const) identifier(action[key] as string, `action ${key}`);
  ensure(Array.isArray(action.resources), 'invalid-record', 'Action resources must be an array');
  for (const resource of action.resources) identifier(resource as string, 'resource id');
  if (record.receipt !== null) assertReceipt(record.receipt);
}

/** Deadline bounds waiting, not external side effects. Late results are never executed. */
export async function bounded<T>(
  milliseconds: number, signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  ensure(Number.isFinite(milliseconds) && milliseconds > 0, 'invalid-timeout', 'Timeout must be positive');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forward = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new HubError('aborted', 'Operation aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new HubError('timeout', 'Operation deadline exceeded')), milliseconds);
    });
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', forward);
  }
}
