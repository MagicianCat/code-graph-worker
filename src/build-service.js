import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { materializeRepository } from './source-materializer.js';
import { resolveRouteAssociations } from './route-normalizer.js';
import { validateBuildRequest } from './validation.js';
import { runProcess } from './process-runner.js';

export class BuildService {
  constructor(config, adapter, artifactStore, jobStore, materialize = materializeRepository, processRunner = runProcess) {
    this.config = config;
    this.adapter = adapter;
    this.artifactStore = artifactStore;
    this.jobStore = jobStore;
    this.materialize = materialize;
    this.processRunner = processRunner;
    this.queue = [];
    this.running = 0;
    this.submitLock = Promise.resolve();
  }

  metrics() {
    return { running: this.running, queued: this.queue.length, maxConcurrent: this.config.maxConcurrentBuilds, maxQueued: this.config.maxQueuedBuilds };
  }

  async submit(request, idempotencyKey) {
    const previous = this.submitLock;
    let release;
    this.submitLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#submitLocked(request, idempotencyKey);
    } finally {
      release();
    }
  }

  async #submitLocked(request, idempotencyKey) {
    validateBuildRequest(request);
    if (!idempotencyKey) throw new WorkerError('INVALID_REQUEST', 'Idempotency-Key is required', { status: 400 });
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = await this.jobStore.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new WorkerError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request', { status: 409 });
      return existing;
    }
    if (this.queue.length >= this.config.maxQueuedBuilds) throw new WorkerError('BUILD_CAPACITY_EXCEEDED', 'Build queue is full', { status: 429, retryable: true });
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      engineJobId: crypto.randomUUID(),
      requestId: request.requestId,
      bundleKey: request.bundleKey,
      status: 'QUEUED',
      progress: 0,
      currentStep: null,
      attempts: 0,
      artifact: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      idempotencyKey,
      requestHash,
    };
    await this.jobStore.save(job);
    this.queue.push({ job, request });
    this.#drain();
    return job;
  }

  async get(id) {
    const job = await this.jobStore.get(id);
    if (!job) throw new WorkerError('JOB_NOT_FOUND', 'Build job not found', { status: 404 });
    return job;
  }

  #drain() {
    while (this.running < this.config.maxConcurrentBuilds && this.queue.length) {
      const item = this.queue.shift();
      this.running += 1;
      this.#execute(item).finally(() => {
        this.running -= 1;
        this.#drain();
      });
    }
  }

  async #update(job, values) {
    Object.assign(job, values, { updatedAt: new Date().toISOString() });
    await this.jobStore.save(job);
  }

  async #execute({ job, request }) {
    const workspace = path.join(this.config.workRoot, job.engineJobId);
    const artifactStaging = path.join(workspace, 'artifact');
    try {
      await fs.mkdir(path.join(workspace, 'repositories'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(artifactStaging, 'repositories'), { recursive: true, mode: 0o700 });
      await this.#update(job, { status: 'RUNNING', startedAt: new Date().toISOString(), currentStep: 'MATERIALIZE_SOURCE', progress: 5, attempts: 1 });
      const builtRepositories = [];
      const baseArtifactRoots = new Map();
      for (let index = 0; index < request.repositories.length; index += 1) {
        const repository = request.repositories[index];
        const reuse = request.reusePlan?.repositories?.[repository.logicalName] ?? { mode: 'FULL' };
        // GitNexus 1.6.x `index` registers an existing index under the
        // directory basename and does not accept analyze's `--name` option.
        // Keep the basename job-scoped so restored indexes remain isolated
        // from concurrent builds in the shared registry.
        const alias = `job-${job.engineJobId}-${repository.logicalName}`;
        const repoPath = path.join(workspace, 'repositories', alias);
        await this.materialize(repository, repoPath, this.config);
        await this.#update(job, { currentStep: 'ANALYZE', progress: 10 + Math.round(index / request.repositories.length * 45) });
        if (reuse.mode !== 'FULL') {
          const baseArtifactUri = reuse.baseArtifactUri ?? request.baseBundleArtifactUri;
          const baseArtifactSha256 = reuse.baseArtifactSha256 ?? request.baseBundleSha256;
          const baseArtifactAlias = reuse.baseArtifactRepositoryAlias
            ?? request.baseBundleRepositoryAliases?.[repository.logicalName]
            ?? repository.logicalName;
          const artifactCacheKey = `${baseArtifactUri}\0${baseArtifactSha256}`;
          let baseArtifactRoot = baseArtifactRoots.get(artifactCacheKey);
          if (!baseArtifactRoot) {
            baseArtifactRoot = await this.artifactStore.materialize(baseArtifactUri, baseArtifactSha256);
            baseArtifactRoots.set(artifactCacheKey, baseArtifactRoot);
          }
          const baseIndex = path.join(baseArtifactRoot, 'repositories', baseArtifactAlias, '.gitnexus');
          try {
            await fs.access(baseIndex);
          } catch {
            throw new WorkerError('SNAPSHOT_NOT_FOUND', 'Base snapshot does not contain the requested repository alias', { status: 404, details: { logicalName: repository.logicalName, baseArtifactRepositoryAlias: baseArtifactAlias } });
          }
          await fs.cp(baseIndex, path.join(repoPath, '.gitnexus'), { recursive: true, force: true });
          if (reuse.mode === 'EXACT' && (reuse.baseCommitSha !== repository.commitSha || reuse.baseTreeSha !== repository.treeSha)) {
            throw new WorkerError('SNAPSHOT_NOT_COMPATIBLE', 'Exact snapshot identity does not match target repository', { status: 409, details: { logicalName: repository.logicalName } });
          }
          if (reuse.mode === 'INCREMENTAL') await this.#assertAncestor(repoPath, reuse.baseCommitSha, repository.commitSha);
          await this.adapter.registerExisting(repoPath, alias);
          if (reuse.mode === 'INCREMENTAL') await this.#analyzeWithRecovery(job, repoPath, alias);
        } else {
          await this.#analyzeWithRecovery(job, repoPath, alias);
        }
        await this.#update(job, { currentStep: 'VALIDATE', progress: 55 + Math.round(index / request.repositories.length * 15) });
        const status = await this.adapter.validate(alias, repository.commitSha, reuse.mode === 'EXACT');
        const storagePath = status.storagePath;
        if (!storagePath) throw new WorkerError('ENGINE_INDEX_INVALID', 'GitNexus status did not expose storagePath');
        const artifactRepositoryPath = path.join(artifactStaging, 'repositories', repository.logicalName);
        await fs.mkdir(artifactRepositoryPath, { recursive: true, mode: 0o700 });
        await fs.cp(storagePath, path.join(artifactRepositoryPath, '.gitnexus'), { recursive: true, force: true });
        builtRepositories.push({ ...repository, alias, repoPath, reuseMode: reuse.mode, baseCommitSha: reuse.baseCommitSha ?? null, status });
      }

      let group = null;
      let routeAssociations = [];
      if (builtRepositories.length > 1) {
        await this.#update(job, { currentStep: 'GROUP_SYNC', progress: 75 });
        const prefixes = request.options?.httpRoutePrefixes ?? {};
        group = await this.adapter.createGroup(`group-${job.engineJobId}`, builtRepositories);
        routeAssociations = resolveRouteAssociations(request.options?.httpRouteLinks ?? [], prefixes, group.contracts ?? []);
      }

      const metadata = {
        schemaVersion: 1,
        engine: 'GITNEXUS',
        engineVersion: this.config.gitnexusVersion,
        adapterVersion: this.config.adapterVersion,
        buildMode: request.buildMode,
        bundleKey: request.bundleKey,
        repositories: builtRepositories.map(({ logicalName, repositoryKey, commitSha, treeSha, reuseMode, baseCommitSha, status }) => ({
          logicalName, repositoryKey, commitSha, treeSha, buildMode: reuseMode, baseCommitSha, nodeCount: status.nodeCount ?? null, edgeCount: status.edgeCount ?? null,
        })),
        routeNormalization: {
          version: 1,
          prefixes: request.options?.httpRoutePrefixes ?? {},
          explicitLinkCount: request.options?.httpRouteLinks?.length ?? 0,
          resolvedLinkCount: routeAssociations.filter((link) => link.status === 'RESOLVED').length,
          associations: routeAssociations,
        },
        group: group ? { engineCrossLinkCount: group.crossLinks?.length ?? 0 } : null,
        createdAt: new Date().toISOString(),
      };
      await this.#update(job, { currentStep: 'ARCHIVE', progress: 85 });
      const published = await this.artifactStore.publish(request.bundleKey, job.engineJobId, artifactStaging, metadata);
      await this.#update(job, {
        status: 'SUCCEEDED', currentStep: 'PUBLISH', progress: 100, completedAt: new Date().toISOString(),
        artifact: { ...published, engine: 'GITNEXUS', engineVersion: this.config.gitnexusVersion, adapterVersion: this.config.adapterVersion, contentRetention: 'FULL' },
      });
    } catch (error) {
      const normalized = error instanceof WorkerError ? error : new WorkerError('INTERNAL_ERROR', error.message, { retryable: false });
      await this.#update(job, {
        status: 'FAILED', completedAt: new Date().toISOString(),
        error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable, details: normalized.details },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  async #analyzeWithRecovery(job, repoPath, alias) {
    try {
      await this.adapter.analyze(repoPath, alias, false);
    } catch (firstError) {
      await this.#update(job, { attempts: 2 });
      await this.adapter.analyze(repoPath, alias, true);
    }
  }

  async #assertAncestor(repoPath, baseCommitSha, targetCommitSha) {
    try {
      await this.processRunner('git', ['-C', repoPath, 'merge-base', '--is-ancestor', baseCommitSha, targetCommitSha], { timeoutMs: 30_000 });
    } catch {
      throw new WorkerError('SNAPSHOT_NOT_ANCESTOR', 'Base snapshot commit is not an ancestor of target commit', { status: 409, retryable: false, details: { baseCommitSha, targetCommitSha } });
    }
  }
}
