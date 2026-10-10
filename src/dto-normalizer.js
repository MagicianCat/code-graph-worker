const KIND_MAP = new Map([
  ['File', 'FILE'], ['Module', 'MODULE'], ['Class', 'CLASS'], ['Interface', 'INTERFACE'],
  ['Enum', 'ENUM'], ['Function', 'FUNCTION'], ['Method', 'METHOD'], ['Constructor', 'CONSTRUCTOR'],
  ['Property', 'PROPERTY'], ['Variable', 'VARIABLE'], ['Route', 'ROUTE'],
]);

function kindFromUid(uid = '') {
  return KIND_MAP.get(uid.split(':', 1)[0]) ?? 'UNKNOWN';
}

// Engine paths are only useful to callers as repository-relative locations.
// Never let an absolute path (or a traversal segment emitted by an engine)
// cross the worker boundary.
function safeFilePath(value) {
  if (value == null || value === '') return '';
  const raw = String(value).replaceAll('\\', '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return '';
  const normalized = raw.split('/').filter(Boolean).join('/');
  if (!normalized || normalized.split('/').includes('..')) return '';
  return normalized;
}

export function normalizeSymbol(raw, repository, score = null) {
  const uid = raw.uid ?? raw.id ?? '';
  return {
    uid,
    kind: KIND_MAP.get(raw.kind) ?? kindFromUid(uid),
    name: raw.name ?? uid,
    qualifiedName: raw.qualifiedName ?? null,
    repository,
    filePath: safeFilePath(raw.filePath),
    startLine: raw.startLine ?? null,
    endLine: raw.endLine ?? null,
    score: score ?? raw.score ?? null,
    metadata: safeSymbolMetadata(raw),
  };
}

function safeSymbolMetadata(raw) {
  // Engine output is untrusted at this boundary. Keep only stable scalar fields that
  // cannot disclose worker paths, index locations or nested engine internals.
  const allowed = ['language', 'visibility', 'signature', 'returnType', 'deprecated', 'abstract', 'static'];
  return Object.fromEntries(allowed
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof raw[key]))
    .map((key) => [key, raw[key]]));
}

export function normalizeOverview(metadata) {
  const repositories = (metadata.repositories ?? []).map((repository) => ({
    logicalName: repository.logicalName,
    repositoryKey: repository.repositoryKey,
    commitSha: repository.commitSha,
    treeSha: repository.treeSha,
    buildMode: repository.buildMode ?? 'FULL',
    baseCommitSha: repository.baseCommitSha ?? null,
    fileCount: Number.isFinite(repository.fileCount) ? repository.fileCount : null,
    nodeCount: Number.isFinite(repository.nodeCount) ? repository.nodeCount : null,
    edgeCount: Number.isFinite(repository.edgeCount) ? repository.edgeCount : null,
  }));
  return {
    schemaVersion: 1,
    engine: metadata.engine,
    engineVersion: metadata.engineVersion,
    adapterVersion: metadata.adapterVersion,
    repositoryCount: repositories.length,
    repositories,
    group: metadata.group ? {
      engineCrossLinkCount: Number.isFinite(metadata.group.engineCrossLinkCount) ? metadata.group.engineCrossLinkCount : 0,
      workspaceCrossLinkCount: Number.isFinite(metadata.group.workspaceCrossLinkCount) ? metadata.group.workspaceCrossLinkCount : 0,
      repositoryDependencyCount: Number.isFinite(metadata.group.repositoryDependencyCount) ? metadata.group.repositoryDependencyCount : 0,
      repositoryDependencies: (metadata.group.repositoryDependencies ?? []).map((dependency) => ({
        from: dependency.from ?? null,
        to: dependency.to ?? null,
        type: dependency.type ?? 'DEPENDS_ON',
        source: dependency.source ?? 'GITNEXUS_WORKSPACE',
        evidenceCount: dependency.evidenceCount ?? 0,
        evidence: (dependency.evidence ?? []).map((link) => ({
          id: link.id ?? null,
          from: link.from ?? null,
          to: link.to ?? null,
          type: link.type ?? null,
          matchType: link.matchType ?? null,
          contractId: link.contractId ?? null,
          confidence: link.confidence ?? null,
        })),
      })),
    } : null,
    counts: {
      repositories: repositories.length,
      files: repositories.reduce((sum, repository) => sum + (repository.fileCount ?? 0), 0),
      symbols: repositories.reduce((sum, repository) => sum + (repository.nodeCount ?? 0), 0),
      relations: repositories.reduce((sum, repository) => sum + (repository.edgeCount ?? 0), 0),
    },
    routeNormalization: metadata.routeNormalization ? {
      version: metadata.routeNormalization.version ?? 1,
      explicitLinkCount: metadata.routeNormalization.explicitLinkCount ?? 0,
      resolvedLinkCount: metadata.routeNormalization.resolvedLinkCount ?? 0,
    } : null,
  };
}

export function normalizeRouteMap(metadata, limit = 500) {
  const associations = metadata.routeNormalization?.associations ?? [];
  const routes = associations.slice(0, limit).map((association) => ({
    originalContractId: association.originalContractId ?? null,
    normalizedContractId: association.normalizedContractId ?? null,
    consumer: normalizeRouteEndpoint(association.consumer),
    provider: normalizeRouteEndpoint(association.provider),
    status: association.status === 'RESOLVED' ? 'RESOLVED' : 'UNRESOLVED',
    confidence: typeof association.confidence === 'number' ? association.confidence : 0,
  }));
  return { schemaVersion: 1, routes, truncated: associations.length > routes.length };
}

function normalizeRouteEndpoint(endpoint) {
  if (!endpoint) return null;
  return {
    repository: endpoint.repository ?? null,
    symbolUid: endpoint.symbolUid ?? null,
    symbolRef: endpoint.symbolRef ? {
      name: endpoint.symbolRef.name ?? null,
      filePath: safeFilePath(endpoint.symbolRef.filePath),
      startLine: endpoint.symbolRef.startLine ?? null,
      endLine: endpoint.symbolRef.endLine ?? null,
    } : null,
  };
}

export function normalizeQuery(raw, repository, limit) {
  const candidates = [...(raw.definitions ?? []), ...(raw.process_symbols ?? [])];
  const seen = new Set();
  const symbols = [];
  for (const candidate of candidates) {
    const uid = candidate.uid ?? candidate.id;
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    symbols.push(normalizeSymbol(candidate, repository));
    if (symbols.length >= limit) break;
  }
  return { schemaVersion: 1, symbols, truncated: candidates.length > symbols.length };
}

export function normalizeContext(raw, repository) {
  const target = normalizeSymbol(raw.symbol, repository);
  const symbols = [];
  const relations = [];
  const relationMap = {
    imports: 'IMPORTS', accesses: 'ACCESSES', calls: 'CALLS', contains: 'CONTAINS',
    has_method: 'HAS_METHOD', has_property: 'HAS_PROPERTY',
  };
  for (const [direction, groups] of [['incoming', raw.incoming ?? {}], ['outgoing', raw.outgoing ?? {}]]) {
    for (const [engineType, values] of Object.entries(groups)) {
      const type = relationMap[engineType] ?? 'UNKNOWN';
      for (const value of values ?? []) {
        const symbol = normalizeSymbol(value, repository);
        symbols.push(symbol);
        relations.push(direction === 'incoming'
          ? { fromUid: symbol.uid, toUid: target.uid, type, confidence: 1 }
          : { fromUid: target.uid, toUid: symbol.uid, type, confidence: 1 });
      }
    }
  }
  return { schemaVersion: 1, target, symbols, relations, truncated: raw.epistemic === 'lower-bound' };
}

export function normalizeImpact(raw, repository, direction) {
  const symbols = [];
  const relations = [];
  for (const entries of Object.values(raw.byDepth ?? {})) {
    for (const entry of entries) {
      const entryUid = entry.uid ?? entry.id ?? '';
      symbols.push(normalizeSymbol(entry, repository));
      relations.push({
        fromUid: direction === 'UPSTREAM' ? entryUid : (raw.target.uid ?? raw.target.id),
        toUid: direction === 'UPSTREAM' ? (raw.target.uid ?? raw.target.id) : entryUid,
        type: String(entry.relationType ?? 'UNKNOWN').toUpperCase(),
        confidence: entry.confidence ?? 1,
      });
    }
  }
  return {
    schemaVersion: 1,
    target: normalizeSymbol(raw.target, repository),
    direction,
    risk: raw.risk ?? 'UNKNOWN',
    symbols,
    relations,
    truncated: raw.epistemic === 'lower-bound' || raw.truncated === true,
    truncationReason: raw.truncationReason ? String(raw.truncationReason).replaceAll('-', '_').toUpperCase() : null,
  };
}

export function normalizeTrace(raw, repository) {
  const path = raw.hops ?? raw.path ?? raw.symbols ?? [];
  const symbols = path.map((entry) => {
    const value = entry.symbol ?? entry;
    return normalizeSymbol({ ...value, uid: value.uid ?? value.id ?? `Trace:${value.filePath}:${value.startLine ?? 0}:${value.name}` }, repository);
  });
  const relations = raw.edges?.map((edge, index) => ({
    fromUid: edge.fromUid ?? edge.from ?? symbols[index]?.uid ?? '',
    toUid: edge.toUid ?? edge.to ?? symbols[index + 1]?.uid ?? '',
    type: String(edge.type ?? edge.relType ?? edge.relationType ?? 'UNKNOWN').toUpperCase(),
    confidence: edge.confidence ?? 1,
  })) ?? [];
  return { schemaVersion: 1, status: raw.status === 'no_path' ? 'NO_PATH' : 'FOUND', symbols, relations };
}
