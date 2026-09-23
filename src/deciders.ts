import type { Decision, DecisionProvider, DecisionRequest } from './contracts.js';
import { ensure, HubError } from './primitives.js';

export interface DecisionLimiterOptions {
  /** How many calls to the wrapped decider may be in flight at once, across every run and hub that shares this limiter. */
  readonly concurrency: number;
  /** Total calls allowed; null or absent means unlimited. Can be raised later through `maxCalls`. */
  readonly maxCalls?: number | null;
  /** Name of the limiter itself; defaults to `limit(<inner name>)`. */
  readonly name?: string;
}
interface Waiter { readonly signal: AbortSignal; readonly grant: () => void; readonly cancel: () => void }
const count = (value: number | null, name: string): void =>
  ensure(value === null || (Number.isInteger(value) && value >= 0), 'invalid-options', `${name} must be a non-negative integer or null`);

/**
 * Shares one decider between many runs: a FIFO concurrency limit and an optional call budget.
 * - A slot is released when the wrapped call actually settles, not when a caller stops waiting: a call abandoned on a
 *   deadline is still a real request to the vendor, and freeing its slot early is how "concurrency 2" becomes 4 in flight.
 * - A released slot passes straight to the next waiter, so no newcomer can take it in between.
 * - A caller aborted while queued leaves the queue and spends no budget. The budget is counted when a call is dispatched;
 *   calls that fail still count.
 * - With the budget spent it answers `deliberate` without calling the decider (metadata.code 'decision-budget'), so the
 *   host hears about it at once instead of every run retrying. Raise `maxCalls` and answer the requests to continue.
 * Decisions keep their own `provider`; ones without it are stamped with the wrapped decider's name.
 */
export class DecisionLimiter implements DecisionProvider {
  readonly name: string;
  readonly #inner: DecisionProvider;
  readonly #concurrency: number;
  #maxCalls: number | null;
  #used = 0;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(inner: DecisionProvider, options: DecisionLimiterOptions) {
    ensure(inner !== null && typeof inner === 'object' && typeof inner.decide === 'function', 'invalid-options', 'A decider to wrap is required');
    ensure(Number.isInteger(options.concurrency) && options.concurrency > 0, 'invalid-options', 'concurrency must be a positive integer');
    const maxCalls = options.maxCalls ?? null;
    count(maxCalls, 'maxCalls');
    this.#inner = inner;
    this.#concurrency = options.concurrency;
    this.#maxCalls = maxCalls;
    this.name = options.name ?? `limit(${inner.name})`;
    ensure(typeof this.name === 'string' && this.name.trim().length > 0, 'invalid-options', 'name must be a nonempty string');
  }
  get maxCalls(): number | null { return this.#maxCalls; }
  set maxCalls(value: number | null) { count(value, 'maxCalls'); this.#maxCalls = value; }
  /** Calls dispatched to the wrapped decider so far. */
  get used(): number { return this.#used; }
  get inFlight(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }

  #spent(): boolean { return this.#maxCalls !== null && this.#used >= this.#maxCalls; }
  #exhausted(): Decision {
    return { kind: 'deliberate', reason: 'The shared decision budget is exhausted', provider: this.name,
      metadata: { code: 'decision-budget', used: this.#used, maxCalls: this.#maxCalls } };
  }

  async decide(request: DecisionRequest, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    if (this.#spent()) return this.#exhausted();
    await this.#acquire(signal);
    // Checked again at dispatch: another caller may have spent the last call while this one queued.
    if (this.#spent()) { this.#release(); return this.#exhausted(); }
    this.#used++;
    const call = Promise.resolve().then(() => this.#inner.decide(request, signal));
    void call.then(() => this.#release(), () => this.#release());
    const decision = await call;
    return decision !== null && typeof decision === 'object' && decision.provider === undefined
      ? { ...decision, provider: this.#inner.name } : decision;
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (this.#active < this.#concurrency && this.#queue.length === 0) { this.#active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: () => { signal.removeEventListener('abort', waiter.cancel); resolve(); },
        cancel: () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason ?? new HubError('aborted', 'Decision cancelled while queued'));
        },
      };
      this.#queue.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
  #release(): void {
    const next = this.#queue.shift();
    if (next) next.grant();          // the slot moves to the next waiter; #active is unchanged
    else this.#active--;
  }
}
export const limitDecider = (inner: DecisionProvider, options: DecisionLimiterOptions): DecisionLimiter => new DecisionLimiter(inner, options);
