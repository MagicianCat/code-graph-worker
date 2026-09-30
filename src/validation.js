import { WorkerError } from './errors.js';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateBuildRequest(request) {
  if (request?.schemaVersion !== 1 || !request.requestId || !SAFE_NAME.test(request.bundleKey ?? '') || request.buildMode !== 'FULL') {
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

export function validateGraphRequest(request) {
  if (request?.schemaVersion !== 1 || !request.graph?.bundleArtifactUri || !SHA256.test(request.graph.bundleSha256 ?? '')) {
    throw new WorkerError('INVALID_REQUEST', 'Invalid graph selector', { status: 400 });
  }
  return request;
}
