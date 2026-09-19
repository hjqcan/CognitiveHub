import type { Json, Scope } from './contracts.js';

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
