import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { normalizeContext, normalizeImpact, normalizeQuery, normalizeTrace } from './dto-normalizer.js';
import { validateGraphRequest } from './validation.js';

export class QueryService {
  constructor(adapter, artifactStore, maxConcurrentQueries = 8) {
    this.adapter = adapter;
    this.artifactStore = artifactStore;
    this.maxConcurrentQueries = maxConcurrentQueries;
    this.activeQueries = 0;
  }

  async run(operation, request) {
    if (!['query', 'context', 'impact', 'trace'].includes(operation)) throw new WorkerError('INVALID_REQUEST', 'Unsupported query operation', { status: 400 });
    if (this.activeQueries >= this.maxConcurrentQueries) throw new WorkerError('BUILD_CAPACITY_EXCEEDED', 'Query capacity is full', { status: 429, retryable: true });
    this.activeQueries += 1;
    try {
      return await this[operation](request);
    } finally {
      this.activeQueries -= 1;
    }
  }

  async #resolve(request, repository) {
    validateGraphRequest(request);
    const root = await this.artifactStore.materialize(request.graph.bundleArtifactUri, request.graph.bundleSha256);
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'metadata.json'), 'utf8'));
    const selected = repository ?? request.graph.repositories?.[0] ?? metadata.repositories?.[0]?.logicalName;
    if (!metadata.repositories?.some((entry) => entry.logicalName === selected)) {
      throw new WorkerError('SNAPSHOT_NOT_FOUND', `Repository ${selected} is not in the bundle`, { status: 404 });
    }
    const repoPath = path.join(root, 'repositories', selected);
    await this.adapter.registerExisting(repoPath);
    return { repository: selected, repoPath };
  }

  async query(request) {
    if (typeof request.query !== 'string' || !request.query.trim()) throw new WorkerError('INVALID_REQUEST', 'query is required', { status: 400 });
    const selected = await this.#resolve(request, request.repository);
    const limit = boundedInteger(request.limit, 20, 1, 100, 'limit');
    return normalizeQuery(await this.adapter.query(selected.repoPath, request.query.trim(), limit), selected.repository, limit);
  }

  async context(request) {
    if (!request.target || (!request.target.uid && !request.target.name)) throw new WorkerError('INVALID_REQUEST', 'target is required', { status: 400 });
    const selected = await this.#resolve(request, request.target?.repository);
    const raw = await this.adapter.context(selected.repoPath, request.target, boundedInteger(request.limit, 20, 1, 100, 'limit'));
    if (raw.status !== 'found') throw new WorkerError('SYMBOL_NOT_FOUND', 'Symbol not found', { status: 404 });
    return normalizeContext(raw, selected.repository);
  }

  async impact(request) {
    if (!request.target || !['UPSTREAM', 'DOWNSTREAM'].includes(request.direction)) throw new WorkerError('INVALID_REQUEST', 'target and direction are required', { status: 400 });
    request.depth = boundedInteger(request.depth, 3, 1, 10, 'depth');
    request.limit = boundedInteger(request.limit, 100, 1, 500, 'limit');
    const selected = await this.#resolve(request, request.target?.repository);
    return normalizeImpact(await this.adapter.impact(selected.repoPath, request.target, request), selected.repository, request.direction);
  }

  async trace(request) {
    if (!request.from || !request.to) throw new WorkerError('INVALID_REQUEST', 'from and to are required', { status: 400 });
    request.maxDepth = boundedInteger(request.maxDepth, 10, 1, 20, 'maxDepth');
    const repository = request.from?.repository ?? request.to?.repository;
    if (request.from?.repository && request.to?.repository && request.from.repository !== request.to.repository) {
      throw new WorkerError('INVALID_REQUEST', 'M1 trace supports one repository per request', { status: 400 });
    }
    const selected = await this.#resolve(request, repository);
    return normalizeTrace(await this.adapter.trace(selected.repoPath, request.from, request.to, request), selected.repository);
  }
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new WorkerError('INVALID_REQUEST', `${field} is out of range`, { status: 400 });
  return parsed;
}
