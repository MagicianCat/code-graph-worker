import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { normalizeContext, normalizeImpact, normalizeOverview, normalizeQuery, normalizeRouteMap, normalizeTrace } from './dto-normalizer.js';
import { validateGraphRequest } from './validation.js';

export class QueryService {
  constructor(adapter, artifactStore, maxConcurrentQueries = 8) {
    this.adapter = adapter;
    this.artifactStore = artifactStore;
    this.maxConcurrentQueries = maxConcurrentQueries;
    this.activeQueries = 0;
  }

  metrics() {
    return { running: this.activeQueries, maxConcurrent: this.maxConcurrentQueries };
  }

  async run(operation, request) {
    if (!['overview', 'query', 'context', 'impact', 'trace', 'route-map'].includes(operation)) throw new WorkerError('INVALID_REQUEST', 'Unsupported query operation', { status: 400 });
    if (this.activeQueries >= this.maxConcurrentQueries) throw new WorkerError('BUILD_CAPACITY_EXCEEDED', 'Query capacity is full', { status: 429, retryable: true });
    this.activeQueries += 1;
    try {
      return await this[operation === 'route-map' ? 'routeMap' : operation](request);
    } finally {
      this.activeQueries -= 1;
    }
  }

  async #resolve(request, repository) {
    validateGraphRequest(request);
    const root = await this.artifactStore.materialize(request.graph.bundleArtifactUri, request.graph.bundleSha256);
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(root, 'metadata.json'), 'utf8')); } catch {
      throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact metadata is invalid', { status: 422 });
    }
    if (!Array.isArray(metadata.repositories)) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact metadata has no repositories', { status: 422 });
    const firstRequested = request.graph.repositories?.[0];
    const selected = repository ?? (typeof firstRequested === 'string' ? firstRequested : firstRequested?.logicalName)
      ?? metadata.repositories?.[0]?.logicalName;
    if (!metadata.repositories?.some((entry) => entry.logicalName === selected)) {
      throw new WorkerError('SNAPSHOT_NOT_FOUND', `Repository ${selected} is not in the bundle`, { status: 404 });
    }
    const repoPath = path.join(root, 'repositories', selected);
    await this.adapter.registerExisting(repoPath);
    return { repository: selected, repoPath, metadata };
  }

  async overview(request) {
    const { metadata, root } = await this.#resolveMetadata(request);
    // Older bundles (including bundles produced before M7) did not copy the
    // GitNexus statistics into metadata.json.  The stats are still part of
    // each immutable repository index, so enrich the public overview from the
    // co-located .gitnexus/meta.json instead of reporting an empty graph.
    const repositories = await Promise.all((metadata.repositories ?? []).map(async (repository) => {
      try {
        const indexMetadata = JSON.parse(await fs.readFile(path.join(root, 'repositories', repository.logicalName, '.gitnexus', 'meta.json'), 'utf8'));
        const stats = indexMetadata.stats ?? {};
        return { ...repository,
          nodeCount: Number.isFinite(repository.nodeCount) ? repository.nodeCount : (Number.isFinite(stats.nodes) ? stats.nodes : null),
          edgeCount: Number.isFinite(repository.edgeCount) ? repository.edgeCount : (Number.isFinite(stats.edges) ? stats.edges : null),
          fileCount: Number.isFinite(repository.fileCount) ? repository.fileCount : (Number.isFinite(stats.files) ? stats.files : null),
        };
      } catch { return repository; }
    }));
    return normalizeOverview({ ...metadata, repositories });
  }

  async routeMap(request) {
    const limit = boundedInteger(request.limit, 500, 1, 500, 'limit');
    const repository = request.repository;
    if (repository !== undefined && (typeof repository !== 'string' || repository.length > 128)) {
      throw new WorkerError('INVALID_REQUEST', 'repository is invalid', { status: 400 });
    }
    const { metadata } = await this.#resolveMetadata(request);
    const filtered = repository === undefined ? metadata : {
      ...metadata,
      routeNormalization: {
        ...(metadata.routeNormalization ?? {}),
        associations: (metadata.routeNormalization?.associations ?? []).filter((association) =>
          association.consumer?.repository === repository || association.provider?.repository === repository),
      },
    };
    return normalizeRouteMap(filtered, limit);
  }

  async #resolveMetadata(request) {
    validateGraphRequest(request);
    const root = await this.artifactStore.materialize(request.graph.bundleArtifactUri, request.graph.bundleSha256);
    try {
      return { root, metadata: JSON.parse(await fs.readFile(path.join(root, 'metadata.json'), 'utf8')) };
    } catch {
      throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact metadata is invalid', { status: 422 });
    }
  }

  async query(request) {
    if (typeof request.query !== 'string' || !request.query.trim()) throw new WorkerError('INVALID_REQUEST', 'query is required', { status: 400 });
    boundedString(request.query, 2_000, 'query');
    const selected = await this.#resolve(request, request.repository);
    const limit = boundedInteger(request.limit, 20, 1, 100, 'limit');
    return normalizeQuery(await this.adapter.query(selected.repoPath, request.query.trim(), limit), selected.repository, limit);
  }

  async context(request) {
    validateTarget(request.target);
    const selected = await this.#resolve(request, request.target?.repository);
    const raw = await this.adapter.context(selected.repoPath, request.target, boundedInteger(request.limit, 20, 1, 100, 'limit'));
    if (raw.status !== 'found') throw new WorkerError('SYMBOL_NOT_FOUND', 'Symbol not found', { status: 404 });
    return normalizeContext(raw, selected.repository);
  }

  async impact(request) {
    validateTarget(request.target);
    if (!['UPSTREAM', 'DOWNSTREAM'].includes(request.direction)) throw new WorkerError('INVALID_REQUEST', 'target and direction are required', { status: 400 });
    request.depth = boundedInteger(request.depth, 3, 1, 10, 'depth');
    request.limit = boundedInteger(request.limit, 100, 1, 500, 'limit');
    const selected = await this.#resolve(request, request.target?.repository);
    return normalizeImpact(await this.adapter.impact(selected.repoPath, request.target, request), selected.repository, request.direction);
  }

  async trace(request) {
    validateTarget(request.from, 'from');
    validateTarget(request.to, 'to');
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

function boundedString(value, maximum, field) {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new WorkerError('INVALID_REQUEST', `${field} exceeds maximum length`, { status: 400 });
  }
  return value;
}

function validateTarget(target, field = 'target') {
  if (!target || typeof target !== 'object' || Array.isArray(target) || (!target.uid && !target.name)) {
    throw new WorkerError('INVALID_REQUEST', `${field} is required`, { status: 400 });
  }
  for (const key of ['uid', 'name', 'filePath', 'repository', 'kind']) {
    if (target[key] !== undefined) boundedString(target[key], 512, `${field}.${key}`);
  }
}
