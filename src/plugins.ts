import type {
  Capability, CapabilityRegistration, Dispose, Plugin, PluginContext, Scope,
} from './contracts.js';
import { ensure, HubError, identifier, immutable, text, validScope, visible } from './primitives.js';

type Status = 'installed' | 'starting' | 'active' | 'draining' | 'stopped' | 'failed';
interface Mount {
  plugin: Plugin;
  scope: Scope;
  status: Status;
  activation: number;
  leases: number;
  disposers: Dispose[];
  /** Wakers for stop() calls waiting on the last lease; a stop that gave up removes its own. */
  drained: Set<() => void>;
  /** The one disposal shared by every stop() call that saw the drain finish. */
  disposal?: Promise<void> | undefined;
}
interface ActivationBatch {
  readonly started: Mount[];
  open: boolean;
}
export interface CapabilityLease {
  readonly registration: CapabilityRegistration;
  release(): void;
}
/** Trusted, explicit module mounting. NOT a sandbox or a remote package installer. */
export class PluginHost {
  readonly #mounts = new Map<string, Mount>();
  readonly #services = new Map<string, { owner: string; value: unknown }>();
  readonly #capabilities: CapabilityRegistration[] = [];
  #starting = false;
  #activation = 0; // Never reused, including after uninstall/reinstall.

  install(plugin: Plugin, scope: Scope = []): void {
    ensure(!this.#starting, 'host-busy', 'Cannot install during activation');
    const manifest = immutable(plugin.manifest);
    identifier(manifest.id, 'plugin id'); identifier(manifest.version, 'plugin version');
    ensure(manifest.apiVersion === 1, 'plugin-api', 'Unsupported plugin API version');
    ensure(!this.#mounts.has(manifest.id), 'duplicate-plugin', `Plugin ${manifest.id} is already installed`);
    validScope(scope, true);
    [...manifest.requires ?? [], ...manifest.provides ?? []].forEach(x => identifier(x, 'service id'));
    ensure(new Set(manifest.provides).size === (manifest.provides?.length ?? 0), 'duplicate-service', 'Duplicate provides');
    this.#mounts.set(manifest.id, {
      plugin: { manifest, setup: ctx => plugin.setup(ctx) }, scope: immutable(scope),
      status: 'installed', activation: 0, leases: 0, disposers: [], drained: new Set(),
    });
  }

  /** Remove an inactive mount so it can be reinstalled or replaced. start() never retries a failed plugin. */
  uninstall(id: string): void {
    ensure(!this.#starting, 'host-busy', 'Cannot uninstall during activation');
    const status = this.#mounts.get(id)?.status;
    ensure(status === 'installed' || status === 'stopped' || status === 'failed', 'plugin-state', 'Only inactive plugins can be uninstalled');
    this.#mounts.delete(id);
  }

  /** Stage a batch in dependency order and publish only after every setup succeeds. */
  async start(): Promise<void> {
    ensure(!this.#starting, 'host-busy', 'Activation already running');
    this.#starting = true;
    const batch: ActivationBatch = { started: [], open: true };
    const { started } = batch;
    try {
      let pending = [...this.#mounts.values()].filter(m => m.status === 'installed' || m.status === 'stopped');
      while (pending.length) {
        const ready = pending.find(m => (m.plugin.manifest.requires ?? []).every(key => this.#service(key, started)));
        ensure(ready, 'missing-dependency', 'Unresolved or cyclic plugin service dependencies');
        await this.#activate(ready, batch);
        started.push(ready);
        pending = pending.filter(m => m !== ready);
      }
      // No await here: public resolution cannot observe a partially committed batch.
      for (const mount of started) mount.status = 'active';
    } catch (error) {
      const errors: unknown[] = [error];
      for (const mount of started.reverse()) {
        mount.status = 'draining';
        try { await this.#dispose(mount); mount.status = 'stopped'; }
        catch (e) { mount.status = 'failed'; errors.push(e); }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Plugin batch activation and rollback failed');
      throw error;
    } finally { batch.open = false; this.#starting = false; }
  }

  #service(key: string, staged: readonly Mount[] = []) {
    const service = this.#services.get(key);
    const owner = service && this.#mounts.get(service.owner);
    return owner && (owner.status === 'active' || (owner.status === 'starting' && staged.includes(owner)))
      ? service : undefined;
  }

  async #activate(mount: Mount, batch: ActivationBatch): Promise<void> {
    ensure(Number.isSafeInteger(this.#activation + 1), 'activation-limit', 'Plugin activation counter exhausted');
    mount.status = 'starting'; mount.activation = ++this.#activation;
    const { manifest } = mount.plugin;
    let open = true;
    const registering = (): void => ensure(open, 'closed-context', 'Contributions must be registered during setup');
    const ctx: PluginContext = {
      scope: mount.scope,
      service: <T>(key: string): T => {
        ensure([...(manifest.requires ?? []), ...(manifest.provides ?? [])].includes(key),
          'undeclared-service', `Declare dependency ${key}`);
        // Internal services and rollback cleanup may use this batch's completed setups.
        // Closing the batch prevents saved contexts from exposing a later activation.
        const service = this.#service(key, batch.open ? [...batch.started, ...(open ? [mount] : [])] : []);
        ensure(service, 'missing-service', `Service ${key} is unavailable`);
        return service.value as T;
      },
      provide: (key, value) => {
        registering();
        ensure(manifest.provides?.includes(key), 'undeclared-service', `Service ${key} was not declared`);
        ensure(!this.#services.has(key), 'duplicate-service', `Service ${key} already exists`);
        this.#services.set(key, { owner: manifest.id, value });
        mount.disposers.push(() => { this.#services.delete(key); });
      },
      capability: capability => {
        registering(); this.#registerCapability(mount, capability);
      },
      onDispose: dispose => { registering(); mount.disposers.push(dispose); },
    };
    try {
      const dispose = await mount.plugin.setup(ctx);
      open = false;
      if (dispose) mount.disposers.push(dispose);
      for (const key of manifest.provides ?? [])
        ensure(this.#services.get(key)?.owner === manifest.id, 'missing-service', `Plugin did not provide ${key}`);
    } catch (error) {
      open = false;
      mount.status = 'failed';
      try { await this.#dispose(mount); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Activation and cleanup failed'); }
      throw error;
    } finally { open = false; }
  }

  #registerCapability(mount: Mount, capability: Capability): void {
    identifier(capability.id, 'capability id'); text(capability.description, 'capability description');
    ensure(['read', 'write', 'physical'].includes(capability.effect), 'invalid-capability', 'Unknown effect type');
    for (const method of ['prepare', 'validate', 'check', 'execute', 'verify'] as const)
      ensure(typeof capability[method] === 'function', 'invalid-capability', `Missing ${method}`);
    const pluginId = mount.plugin.manifest.id;
    ensure(!this.#capabilities.some(r => r.pluginId === pluginId && r.capability.id === capability.id),
      'duplicate-capability', `Duplicate capability ${capability.id}`);
    // Freeze metadata and bind methods so caller mutations cannot change this activation.
    const copy: Capability = Object.freeze({
      id: capability.id, description: capability.description, effect: capability.effect,
      prepare: capability.prepare.bind(capability), validate: capability.validate.bind(capability),
      check: capability.check.bind(capability), execute: capability.execute.bind(capability),
      verify: capability.verify.bind(capability),
      ...(capability.reconcile ? { reconcile: capability.reconcile.bind(capability) } : {}),
    });
    const registration = Object.freeze({ pluginId, pluginVersion: mount.plugin.manifest.version,
      activation: mount.activation, scope: mount.scope, capability: copy });
    this.#capabilities.push(registration);
    mount.disposers.push(() => {
      const index = this.#capabilities.indexOf(registration);
      if (index >= 0) this.#capabilities.splice(index, 1);
    });
  }

  resolve<T>(key: string): T {
    const service = this.#service(key);
    ensure(service, 'missing-service', `No active service ${key}`);
    return service.value as T;
  }
  list(scope: Scope): readonly CapabilityRegistration[] {
    validScope(scope);
    return this.#capabilities.filter(r => this.#mounts.get(r.pluginId)?.status === 'active' && visible(r.scope, scope));
  }
  #lease(mount: Mount, registration: CapabilityRegistration): CapabilityLease {
    mount.leases++;
    let released = false;
    return { registration, release: () => {
      if (released) return;
      released = true; mount.leases--;
      if (mount.leases === 0) { for (const wake of mount.drained) wake(); mount.drained.clear(); }
    } };
  }
  /** Lease one specific activation, as bound by a proposal made in this process. */
  acquire(pluginId: string, capabilityId: string, activation: number, scope: Scope, pluginVersion?: string): CapabilityLease {
    const mount = this.#mounts.get(pluginId);
    const registration = this.list(scope).find(r => r.pluginId === pluginId &&
      r.capability.id === capabilityId && r.activation === activation &&
      (pluginVersion === undefined || r.pluginVersion === pluginVersion));
    ensure(mount && registration, 'unavailable-capability', 'Capability was removed, replaced, or is outside scope');
    return this.#lease(mount, registration);
  }
  /**
   * Lease the active activation of an exact plugin version, for a record persisted by an earlier process.
   * Query-only use (reconcile/verify): the activation that dispatched the action no longer exists.
   */
  rebind(pluginId: string, pluginVersion: string, capabilityId: string, scope: Scope): CapabilityLease {
    const mount = this.#mounts.get(pluginId);
    const registration = this.list(scope).find(r => r.pluginId === pluginId && r.capability.id === capabilityId);
    ensure(mount && registration, 'unavailable-capability',
      `Capability ${capabilityId} of plugin ${pluginId} is ${mount?.status ?? 'not installed'} or outside scope`);
    ensure(registration.pluginVersion === pluginVersion, 'plugin-version-mismatch',
      `Record requires ${pluginId}@${pluginVersion}; the active version is ${registration.pluginVersion}`);
    return this.#lease(mount, registration);
  }
  status(id: string): Status | undefined { return this.#mounts.get(id)?.status; }

  /**
   * Hide new capabilities first, then drain existing leases. No implicit action cancellation.
   * An aborted signal gives up the wait with `drain-aborted`: the plugin stays draining (still hidden, leases still
   * counted) and a later stop() resumes waiting. Nothing running is killed either way.
   */
  async stop(id: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    ensure(!this.#starting, 'host-busy', 'Cannot stop during activation');
    const mount = this.#mounts.get(id);
    ensure(mount?.status === 'active' || mount?.status === 'draining', 'plugin-state', 'Only active or draining plugins can be stopped');
    if (mount.status === 'active') {
      const provided = new Set(mount.plugin.manifest.provides ?? []);
      const dependent = [...this.#mounts.values()].find(m => m !== mount &&
        ['active', 'draining', 'starting'].includes(m.status) &&
        (m.plugin.manifest.requires ?? []).some(key => provided.has(key)));
      ensure(!dependent, 'active-dependent', `Stop dependent ${dependent?.plugin.manifest.id ?? ''} first`);
      mount.status = 'draining';
    }
    if (mount.leases > 0) await this.#drained(mount, options.signal);
    // Several callers may have waited on the same drain; the mount is disposed once.
    mount.disposal ??= this.#dispose(mount)
      .then(() => { mount.status = 'stopped'; }, (e: unknown) => { mount.status = 'failed'; throw e; })
      .finally(() => { mount.disposal = undefined; });
    await mount.disposal;
  }
  #drained(mount: Mount, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        mount.drained.delete(wake);
        reject(new HubError('drain-aborted', `Plugin ${mount.plugin.manifest.id} still holds ${mount.leases} lease(s); it stays draining`));
      };
      const wake = () => { signal?.removeEventListener('abort', abort); resolve(); };
      if (signal?.aborted) { abort(); return; }
      mount.drained.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async #dispose(mount: Mount): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of mount.disposers.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
  }
}
