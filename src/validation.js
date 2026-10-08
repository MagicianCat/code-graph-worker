import { WorkerError } from './errors.js';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateBuildRequest(request) {
  if (request?.schemaVersion !== 1 || !request.requestId || !SAFE_NAME.test(request.bundleKey ?? '') || !['FULL', 'INCREMENTAL', 'MIXED'].includes(request.buildMode)) {
    throw new WorkerError('INVALID_REQUEST', 'Invalid build request', { status: 400 });
  }
  if (!Array.isArray(request.repositories) || request.repositories.length < 1 || request.repositories.length > 20) {
    throw new WorkerError('INVALID_REQUEST', 'repositories must contain 1 to 20 entries', { status: 400 });
  }
  const names = new Set();
  for (const repository of request.repositories) {
    if (!repository.repositoryKey || !SAFE_NAME.test(repository.logicalName ?? '') || !SHA1.test(repository.commitSha ?? '') || !SHA1.test(repository.treeSha ?? '') || !SHA256.test(repository.sourceSha256 ?? '')) {
      throw new WorkerError('INVALID_REQUEST', 'Invalid repository descriptor', { status: 400, details: { logicalName: repository.logicalName } });
    }
    try { new URL(repository.sourceArtifactUri); } catch { throw new WorkerError('INVALID_REQUEST', 'Invalid sourceArtifactUri', { status: 400 }); }
    if (names.has(repository.logicalName)) throw new WorkerError('INVALID_REQUEST', 'Duplicate repository logicalName', { status: 400 });
    names.add(repository.logicalName);
  }
  validateReusePlan(request, names);
  const routePrefixes = request.options?.httpRoutePrefixes ?? {};
  for (const logicalName of Object.keys(routePrefixes)) {
    if (!names.has(logicalName)) throw new WorkerError('INVALID_REQUEST', 'Route prefix references an unknown repository', { status: 400 });
  }
  for (const link of request.options?.httpRouteLinks ?? []) {
    if (!names.has(link.consumerRepository) || !names.has(link.providerRepository) || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(link.method ?? '') || !link.path?.startsWith('/')) {
      throw new WorkerError('INVALID_REQUEST', 'Invalid HTTP route link', { status: 400 });
    }
  }
  return request;
}

function validateReusePlan(request, names) {
  const plan = request.reusePlan;
  if (plan == null) {
    if (request.buildMode !== 'FULL') throw new WorkerError('INVALID_REQUEST', 'Incremental or mixed builds require a reusePlan and base bundle', { status: 400 });
    return;
  }
  if (typeof plan !== 'object' || Array.isArray(plan)) throw new WorkerError('INVALID_REQUEST', 'reusePlan must be an object', { status: 400 });
  const entries = plan.repositories;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new WorkerError('INVALID_REQUEST', 'reusePlan.repositories must be an object', { status: 400 });
  const entryNames = Object.keys(entries);
  const requestAliases = request.baseBundleRepositoryAliases ?? {};
  if (typeof requestAliases !== 'object' || Array.isArray(requestAliases)) throw new WorkerError('INVALID_REQUEST', 'baseBundleRepositoryAliases must be an object', { status: 400 });
  for (const [name, alias] of Object.entries(requestAliases)) {
    if (!names.has(name) || !SAFE_NAME.test(alias ?? '')) throw new WorkerError('INVALID_REQUEST', 'Invalid base bundle repository alias', { status: 400, details: { logicalName: name } });
  }
  for (const name of entryNames) {
    if (!names.has(name)) throw new WorkerError('INVALID_REQUEST', 'reusePlan references an unknown repository', { status: 400, details: { logicalName: name } });
    const item = entries[name];
    if (!item || !['EXACT', 'INCREMENTAL', 'FULL'].includes(item.mode)) throw new WorkerError('INVALID_REQUEST', 'Invalid repository reuse mode', { status: 400, details: { logicalName: name } });
    if (item.mode !== 'FULL') {
      if (!SHA1.test(item.baseCommitSha ?? '') || !SHA1.test(item.baseTreeSha ?? '')) throw new WorkerError('INVALID_REQUEST', 'baseCommitSha and baseTreeSha are required for reuse', { status: 400, details: { logicalName: name } });
      validateRepositoryBaseArtifact(item, request, name);
    }
  }
  if (entryNames.length !== names.size) throw new WorkerError('INVALID_REQUEST', 'reusePlan must contain one decision per repository', { status: 400 });
  const needsBase = entryNames.some((name) => entries[name].mode !== 'FULL');
  if (needsBase && hasRequestBaseArtifact(request) && !validFileUri(request.baseBundleArtifactUri)) throw new WorkerError('INVALID_REQUEST', 'baseBundleArtifactUri must be a valid file URI', { status: 400 });
  if (request.buildMode === 'FULL' && needsBase) throw new WorkerError('INVALID_REQUEST', 'FULL build cannot contain repository reuse decisions', { status: 400 });
  if (request.buildMode === 'INCREMENTAL' && entryNames.some((name) => entries[name].mode === 'FULL')) throw new WorkerError('INVALID_REQUEST', 'INCREMENTAL build cannot contain FULL repository decisions', { status: 400 });
}

function validateRepositoryBaseArtifact(item, request, logicalName) {
  const fields = [item.baseArtifactUri, item.baseArtifactSha256, item.baseArtifactRepositoryAlias];
  const hasItemFields = fields.some((value) => value != null);
  if (hasItemFields) {
    if (!validFileUri(item.baseArtifactUri) || !SHA256.test(item.baseArtifactSha256 ?? '') || !SAFE_NAME.test(item.baseArtifactRepositoryAlias ?? '')) {
      throw new WorkerError('INVALID_REQUEST', 'Each reused repository must provide a valid baseArtifactUri, baseArtifactSha256 and baseArtifactRepositoryAlias', { status: 400, details: { logicalName } });
    }
    return;
  }
  if (!hasRequestBaseArtifact(request) || !SHA256.test(request.baseBundleSha256 ?? '') || !validFileUri(request.baseBundleArtifactUri)) {
    throw new WorkerError('INVALID_REQUEST', 'A valid per-repository or request-level base bundle is required for reuse', { status: 400, details: { logicalName } });
  }
}

function hasRequestBaseArtifact(request) {
  return request.baseBundleArtifactUri != null || request.baseBundleSha256 != null;
}

function validFileUri(value) {
  try { return new URL(value).protocol === 'file:'; } catch { return false; }
}

export function validateGraphRequest(request) {
  if (request?.schemaVersion !== 1 || !request.graph?.bundleArtifactUri || !SHA256.test(request.graph.bundleSha256 ?? '')) {
    throw new WorkerError('INVALID_REQUEST', 'Invalid graph selector', { status: 400 });
  }
  return request;
}
