import { WorkerError } from './errors.js';

function normalizePrefix(value) {
  if (!value) return '';
  const clean = `/${value}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (clean.includes('..') || clean.includes('?') || clean.includes('#')) {
    throw new WorkerError('INVALID_REQUEST', 'Invalid HTTP route prefix', { status: 400 });
  }
  return clean;
}

export function normalizeConsumerRoute(route, prefix) {
  if (!route.startsWith('/')) throw new WorkerError('INVALID_REQUEST', 'HTTP route must start with /', { status: 400 });
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix || route === normalizedPrefix || route.startsWith(`${normalizedPrefix}/`)) return route;
  return `${normalizedPrefix}${route}`.replace(/\/{2,}/g, '/');
}

export function resolveRouteAssociations(links, prefixes, contracts) {
  return links.map((link) => {
    const method = link.method.toUpperCase();
    const consumerId = `http::${method}::${link.path}`;
    const normalizedPath = normalizeConsumerRoute(link.path, prefixes[link.consumerRepository]);
    const providerId = `http::${method}::${normalizedPath}`;
    const consumer = contracts.find((item) => item.repo === link.consumerRepository && item.role === 'consumer' && item.contractId === consumerId);
    const provider = contracts.find((item) => item.repo === link.providerRepository && item.role === 'provider' && item.contractId === providerId);
    return {
      originalContractId: consumerId,
      normalizedContractId: providerId,
      consumer: consumer ? { repository: consumer.repo, symbolUid: consumer.symbolUid, symbolRef: consumer.symbolRef } : null,
      provider: provider ? { repository: provider.repo, symbolUid: provider.symbolUid, symbolRef: provider.symbolRef } : null,
      status: consumer && provider ? 'RESOLVED' : 'UNRESOLVED',
      confidence: consumer && provider ? Math.min(consumer.confidence ?? 1, provider.confidence ?? 1) : 0,
    };
  });
}
