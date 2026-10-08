import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { runProcess } from './process-runner.js';

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new WorkerError('ENGINE_INDEX_INVALID', 'GitNexus did not return JSON', { details: { stdout: stdout.slice(-2_000) } });
  return JSON.parse(stdout.slice(start, end + 1));
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
    const registration = this.#registerExisting(repoPath, alias).catch((error) => {
      this.registrationPromises.delete(key);
      throw error;
    });
    this.registrationPromises.set(key, registration);
    return registration;
  }

  async #registerExisting(repoPath, alias) {
    const storagePath = path.join(repoPath, '.gitnexus');
    for (const fileName of ['meta.json', 'gitnexus.json']) {
      const metadataPath = path.join(storagePath, fileName);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.repoPath = repoPath;
      metadata.storagePath = storagePath;
      const temporary = `${metadataPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      await fs.rename(temporary, metadataPath);
    }
    if (path.basename(repoPath) !== alias) {
      throw new WorkerError('ENGINE_INDEX_INVALID', 'Restored GitNexus repository path does not match its registry alias');
    }
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
