import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { runProcess } from './process-runner.js';

function parseJsonOutput(stdout) {
  // GitNexus emits `{...}` for object results and `[]` for empty list results.
  // Accept either shape.
  const objectStart = stdout.indexOf('{');
  const objectEnd = stdout.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd >= objectStart) {
    return JSON.parse(stdout.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = stdout.indexOf('[');
  const arrayEnd = stdout.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd >= arrayStart) {
    return JSON.parse(stdout.slice(arrayStart, arrayEnd + 1));
  }
  throw new WorkerError('ENGINE_INDEX_INVALID', 'GitNexus did not return JSON', { details: { stdout: stdout.slice(-2_000) } });
}

export class GitNexusAdapter {
  constructor(config) {
    this.config = config;
    this.env = {
      GITNEXUS_HOME: config.gitnexusHome,
      GITNEXUS_NO_UPDATE_NOTIFIER: '1',
      GITNEXUS_CONTENT_RETENTION: 'full',
      GITNEXUS_WORKER_POOL_SIZE: String(config.workerPoolSize),
    };
    this.registrationPromises = new Map();
    this.registrationTail = Promise.resolve();
  }

  async version() {
    const result = await runProcess(this.config.gitnexusBin, ['--version'], { env: this.env, timeoutMs: 10_000 });
    const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
    if (!match || match[1] !== this.config.gitnexusVersion) {
      throw new WorkerError('ENGINE_UNAVAILABLE', 'Unexpected GitNexus version', { details: { expected: this.config.gitnexusVersion, actual: match?.[1] } });
    }
    return match[1];
  }

  async analyze(repoPath, alias, force = false) {
    const args = ['analyze', repoPath, '--index-only', '--workers', String(this.config.workerPoolSize), '--name', alias];
    if (force) args.push('--force');
    return runProcess(this.config.gitnexusBin, args, { env: this.env, timeoutMs: this.config.buildTimeoutMs });
  }

  async status(alias) {
    const result = await runProcess(this.config.gitnexusBin, ['status', '-r', alias, '--json'], { env: this.env, timeoutMs: this.config.queryTimeoutMs });
    return parseJsonOutput(result.stdout);
  }

  async registerExisting(repoPath, alias = path.basename(repoPath)) {
    const key = `${repoPath}\0${alias}`;
    if (this.registrationPromises.has(key)) return this.registrationPromises.get(key);
    // GitNexus owns one process-wide registry file. Serialize registration for
    // different repositories so concurrent semantic backfills cannot race its
    // read-modify-write cycle.
    const registration = this.registrationTail.then(() => this.#registerExisting(repoPath, alias)).catch((error) => {
      this.registrationPromises.delete(key);
      throw error;
    });
    this.registrationTail = registration.catch(() => undefined);
    this.registrationPromises.set(key, registration);
    return registration;
  }

  async #registerExisting(repoPath, alias) {
    // The same alias can appear under multiple cache paths when the worker
    // serves different bundles that share a repository logical name. GitNexus
    // refuses to pick one when the registry holds duplicates
    // (RegistryAmbiguousTargetError), so before registering the fresh
    // materialization we drop every existing entry for this alias. Removal is
    // idempotent and targets the alias, not the path.
    // A previous worker process may already have registered this exact cache
    // path. `gitnexus remove` also deletes that path's `.gitnexus` directory,
    // so removing-and-reregistering an exact match destroys the live cache.
    // Reuse it as-is; bundle-scoped aliases make the identity immutable.
    if (await this.#removeAliasIfPresent(alias, repoPath)) return repoPath;
    // The restored .gitnexus directory carries the ORIGINAL build's absolute
    // repoPath/storagePath — but the registry now lives at a different path
    // (a cache location). GitNexus validates storage ownership by checking
    // the recorded paths against the live ones, so an unrestored mismatch
    // makes `gitnexus index` reject the storage as "foreign". Rewrite the
    // storage identity in place before invoking `index` so the restored
    // directory is recognised as its own.
    const storagePath = path.join(repoPath, '.gitnexus');
    for (const fileName of ['meta.json', 'gitnexus.json']) {
      const metadataPath = path.join(storagePath, fileName);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.repoPath = repoPath;
      metadata.storagePath = storagePath;
      // Strip the recorded runner identity so the restored storage is
      // evaluated against the current runner, not the original build's.
      // Without this, GitNexus treats the storage as foreign and refuses
      // to register it.
      if (metadata.runnerIdentity) metadata.runnerIdentity.current = null;
      const temporary = `${metadataPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      await fs.rename(temporary, metadataPath);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(alias)) {
      throw new WorkerError('ENGINE_INDEX_INVALID', 'Registry alias is invalid');
    }
    // The alias may intentionally differ from path.basename(repoPath) when the
    // caller needs a bundle-scoped registry name (multiple bundles sharing a
    // repository logical name must not collide in the GitNexus registry).
    // GitNexus 1.6.12 `index` has no `--name` option and otherwise infers the
    // registry name from origin. Point the isolated working copy at a
    // synthetic local identity whose basename is the job-scoped alias. This
    // never mutates the source repository or performs network I/O.
    // Published graph artifacts intentionally contain only `.gitnexus`, not source or
    // repository history. Create an empty ephemeral Git worktree solely so GitNexus
    // can derive the stable registry identity while re-registering the restored index.
    await runProcess('git', ['-C', repoPath, 'init'], { timeoutMs: this.config.queryTimeoutMs });
    await runProcess('git', ['-C', repoPath, 'config', 'remote.origin.url', `file:///gitnexus-restored/${alias}.git`], {
      timeoutMs: this.config.queryTimeoutMs,
    });
    await runProcess(this.config.gitnexusBin, ['index', '--allow-non-git', repoPath], {
      env: this.env,
      timeoutMs: this.config.queryTimeoutMs,
    });
    return repoPath;
  }

  /**
   * Drops every registry entry bound to `alias`. GitNexus' `remove` command
   * refuses to delete by alias when multiple entries match
   * (RegistryAmbiguousTargetError), so we read the registry file directly,
   * collect every path registered under this alias, and remove each one by
   * its absolute path — which `remove` accepts as a disambiguator.
   */
  async #removeAliasIfPresent(alias, repoPath) {
    const registryPath = path.join(this.config.gitnexusHome, 'registry.json');
    let entries;
    try {
      entries = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    } catch (readError) {
      if (readError.code === 'ENOENT') return false; // registry has never been written
      throw readError;
    }
    if (!Array.isArray(entries)) return false;
    const duplicates = entries.filter((entry) => entry && entry.name === alias && typeof entry.path === 'string');
    const normalizedRepoPath = path.resolve(repoPath);
    if (duplicates.some((entry) => path.resolve(entry.path) === normalizedRepoPath)) {
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(repoPath, '.gitnexus', 'meta.json'), 'utf8'));
        const ownedStorage = path.join(normalizedRepoPath, '.gitnexus');
        if (path.resolve(metadata.repoPath ?? '') === normalizedRepoPath
            && path.resolve(metadata.storagePath ?? '') === ownedStorage) return true;
      } catch { /* stale exact registry entry; clean it below */ }
    }
    if (duplicates.length > 0) {
      // Do not invoke `gitnexus remove`: it deletes the registered path's
      // `.gitnexus` directory, which in this case is our immutable artifact
      // cache. Atomically forget only the stale registry rows; the next
      // `gitnexus index` process will rebuild them from the restored storage.
      const retained = entries.filter((entry) => !(entry && entry.name === alias));
      const temporary = `${registryPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(retained, null, 2), { mode: 0o600 });
      await fs.rename(temporary, registryPath);
    }
    return false;
  }

  async validate(alias, expectedCommit, allowRestoredIdentity = false) {
    const status = await this.status(alias);
    const actualCommit = status.index?.commit ?? status.current?.commit ?? status.lastCommit ?? status.commit ?? status.indexedCommit;
    const runnerIdentityStatus = status.index?.runnerIdentityStatus ?? status.runnerIdentityStatus;
    const restoredCliVersion = status.index?.runnerIdentity?.cliVersion ?? status.runnerIdentity?.cliVersion;
    const incompleteReasons = status.index?.incompleteReasons ?? status.incompleteReasons ?? [];
    const identityAccepted = runnerIdentityStatus === 'current'
      || (allowRestoredIdentity && runnerIdentityStatus === 'stale-or-unknown' && restoredCliVersion === this.config.gitnexusVersion);
    if (actualCommit !== expectedCommit || !identityAccepted || incompleteReasons.length > 0) {
      throw new WorkerError('ENGINE_INDEX_INVALID', 'GitNexus status validation failed', { details: { status, expectedCommit } });
    }
    await this.query(alias, 'main application entry workflow', 1);
    return status;
  }

  async query(alias, query, limit = 20) {
    const result = await runProcess(this.config.gitnexusBin, ['query', '-r', alias, query, '--limit', String(limit)], { env: this.env, timeoutMs: this.config.queryTimeoutMs });
    return parseJsonOutput(result.stdout);
  }

  async cypher(alias, query, limit = 100) {
    const result = await runProcess(this.config.gitnexusBin, ['cypher', '-r', alias, query, '--limit', String(limit)], { env: this.env, timeoutMs: this.config.queryTimeoutMs });
    return parseJsonOutput(result.stdout);
  }

  async context(alias, selector, limit = 20) {
    const args = ['context', '-r', alias, selector.uid ?? selector.name, '--limit', String(limit)];
    if (selector.filePath) args.push('--file', selector.filePath);
    return parseJsonOutput((await runProcess(this.config.gitnexusBin, args, { env: this.env, timeoutMs: this.config.queryTimeoutMs })).stdout);
  }

  async impact(alias, selector, options = {}) {
    const args = ['impact', selector.uid ?? selector.name, '-r', alias, '--direction', (options.direction ?? 'UPSTREAM').toLowerCase(), '--depth', String(options.depth ?? 3), '--limit', String(options.limit ?? 100)];
    if (selector.uid) args.push('--uid', selector.uid);
    if (selector.filePath) args.push('--file', selector.filePath);
    if (selector.kind) args.push('--kind', toEngineKind(selector.kind));
    if (options.includeTests) args.push('--include-tests');
    return parseJsonOutput((await runProcess(this.config.gitnexusBin, args, { env: this.env, timeoutMs: this.config.queryTimeoutMs })).stdout);
  }

  async trace(alias, from, to, options = {}) {
    const args = ['trace', from.name ?? from.uid, to.name ?? to.uid, '-r', alias, '--depth', String(options.maxDepth ?? 10)];
    if (from.uid) args.push('--from-uid', from.uid);
    if (from.filePath) args.push('--from-file', from.filePath);
    if (to.uid) args.push('--to-uid', to.uid);
    if (to.filePath) args.push('--to-file', to.filePath);
    if (options.includeTests) args.push('--include-tests');
    return parseJsonOutput((await runProcess(this.config.gitnexusBin, args, { env: this.env, timeoutMs: this.config.queryTimeoutMs })).stdout);
  }

  async createGroup(name, repositories) {
    await runProcess(this.config.gitnexusBin, ['group', 'create', name, '--force'], { env: this.env, timeoutMs: this.config.queryTimeoutMs });
    for (const repository of repositories) {
      await runProcess(this.config.gitnexusBin, ['group', 'add', name, repository.logicalName, repository.alias], { env: this.env, timeoutMs: this.config.queryTimeoutMs });
    }
    await runProcess(this.config.gitnexusBin, ['group', 'sync', name, '--json'], { env: this.env, timeoutMs: Math.min(this.config.buildTimeoutMs, 600_000) });
    return JSON.parse(await fs.readFile(path.join(this.config.gitnexusHome, 'groups', name, 'contracts.json'), 'utf8'));
  }
}

function toEngineKind(kind) {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}
