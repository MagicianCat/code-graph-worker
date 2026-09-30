const KIND_MAP = new Map([
  ['File', 'FILE'], ['Module', 'MODULE'], ['Class', 'CLASS'], ['Interface', 'INTERFACE'],
  ['Enum', 'ENUM'], ['Function', 'FUNCTION'], ['Method', 'METHOD'], ['Constructor', 'CONSTRUCTOR'],
  ['Property', 'PROPERTY'], ['Variable', 'VARIABLE'], ['Route', 'ROUTE'],
]);

function kindFromUid(uid = '') {
  return KIND_MAP.get(uid.split(':', 1)[0]) ?? 'UNKNOWN';
}

export function normalizeSymbol(raw, repository, score = null) {
  const uid = raw.uid ?? raw.id ?? '';
  return {
    uid,
    kind: KIND_MAP.get(raw.kind) ?? kindFromUid(uid),
    name: raw.name ?? uid,
    qualifiedName: raw.qualifiedName ?? null,
    repository,
    filePath: raw.filePath ?? '',
    startLine: raw.startLine ?? null,
    endLine: raw.endLine ?? null,
    score: score ?? raw.score ?? null,
    metadata: Object.fromEntries(Object.entries(raw).filter(([key]) => !['uid', 'id', 'kind', 'name', 'qualifiedName', 'filePath', 'startLine', 'endLine', 'score'].includes(key))),
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
  const relationMap = { imports: 'IMPORTS', accesses: 'ACCESSES', calls: 'CALLS', has_method: 'CONTAINS' };
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
