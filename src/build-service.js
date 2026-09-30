import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { materializeRepository } from './source-materializer.js';
import { resolveRouteAssociations } from './route-normalizer.js';
import { validateBuildRequest } from './validation.js';

export class BuildService {
  constructor(config, adapter, artifactStore, jobStore) {
    this.config = config;
    this.adapter = adapter;
    this.artifactStore = artifactStore;
    this.jobStore = jobStore;
    this.queue = [];
    this.running = 0;
    this.submitLock = Promise.resolve();
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
      for (let index = 0; index < request.repositories.length; index += 1) {
        const repository = request.repositories[index];
        const repoPath = path.join(workspace, 'repositories', repository.logicalName);
        await materializeRepository(repository, repoPath, this.config);
        await this.#update(job, { currentStep: 'ANALYZE', progress: 10 + Math.round(index / request.repositories.length * 45) });
        const alias = `job-${job.engineJobId}-${repository.logicalName}`;
        try {
          await this.adapter.analyze(repoPath, alias, false);
        } catch (firstError) {
          await this.#update(job, { attempts: 2 });
          await this.adapter.analyze(repoPath, alias, true);
        }
        await this.#update(job, { currentStep: 'VALIDATE', progress: 55 + Math.round(index / request.repositories.length * 15) });
        const status = await this.adapter.validate(alias, repository.commitSha);
        const storagePath = status.storagePath;
        if (!storagePath) throw new WorkerError('ENGINE_INDEX_INVALID', 'GitNexus status did not expose storagePath');
        const artifactRepositoryPath = path.join(artifactStaging, 'repositories', repository.logicalName);
        await fs.mkdir(artifactRepositoryPath, { recursive: true, mode: 0o700 });
        await fs.cp(storagePath, path.join(artifactRepositoryPath, '.gitnexus'), { recursive: true, force: true });
        builtRepositories.push({ ...repository, alias, repoPath, status });
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
        repositories: builtRepositories.map(({ logicalName, repositoryKey, commitSha, treeSha, status }) => ({
          logicalName, repositoryKey, commitSha, treeSha, nodeCount: status.nodeCount ?? null, edgeCount: status.edgeCount ?? null,
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
}
