import path from 'node:path';

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env = process.env) {
  const dataRoot = path.resolve(env.CODE_GRAPH_DATA_ROOT ?? '/data/code-graph');
  return Object.freeze({
    port: positiveInteger(env.PORT, 8080, 'PORT'),
    dataRoot,
    workRoot: path.resolve(env.CODE_GRAPH_WORK_ROOT ?? path.join(dataRoot, 'work')),
    artifactRoot: path.resolve(env.CODE_GRAPH_ARTIFACT_ROOT ?? path.join(dataRoot, 'artifacts')),
    cacheRoot: path.resolve(env.CODE_GRAPH_CACHE_ROOT ?? path.join(dataRoot, 'cache')),
    gitnexusHome: path.resolve(env.GITNEXUS_HOME ?? path.join(dataRoot, 'gitnexus-home')),
    gitnexusBin: env.GITNEXUS_BIN ?? 'gitnexus',
    gitnexusVersion: env.GITNEXUS_VERSION ?? '1.6.12',
    adapterVersion: env.CODE_GRAPH_ADAPTER_VERSION ?? '0.1.0',
    maxConcurrentBuilds: positiveInteger(env.CODE_GRAPH_MAX_CONCURRENT_BUILDS, 2, 'CODE_GRAPH_MAX_CONCURRENT_BUILDS'),
    maxQueuedBuilds: positiveInteger(env.CODE_GRAPH_MAX_QUEUED_BUILDS, 20, 'CODE_GRAPH_MAX_QUEUED_BUILDS'),
    buildTimeoutMs: positiveInteger(env.CODE_GRAPH_BUILD_TIMEOUT_MS, 1_800_000, 'CODE_GRAPH_BUILD_TIMEOUT_MS'),
    queryTimeoutMs: positiveInteger(env.CODE_GRAPH_QUERY_TIMEOUT_MS, 10_000, 'CODE_GRAPH_QUERY_TIMEOUT_MS'),
    maxConcurrentQueries: positiveInteger(env.CODE_GRAPH_MAX_CONCURRENT_QUERIES, 8, 'CODE_GRAPH_MAX_CONCURRENT_QUERIES'),
    workerPoolSize: positiveInteger(env.GITNEXUS_WORKER_POOL_SIZE, 4, 'GITNEXUS_WORKER_POOL_SIZE'),
    maxSourceBytes: positiveInteger(env.CODE_GRAPH_MAX_SOURCE_BYTES, 1_073_741_824, 'CODE_GRAPH_MAX_SOURCE_BYTES'),
    maxExtractedBytes: positiveInteger(env.CODE_GRAPH_MAX_EXTRACTED_BYTES, 4_294_967_296, 'CODE_GRAPH_MAX_EXTRACTED_BYTES'),
    maxArchiveEntries: positiveInteger(env.CODE_GRAPH_MAX_ARCHIVE_ENTRIES, 200_000, 'CODE_GRAPH_MAX_ARCHIVE_ENTRIES'),
    sourceFileRoots: (env.CODE_GRAPH_SOURCE_FILE_ROOTS ?? '/inputs').split(',').filter(Boolean).map((value) => path.resolve(value)),
    sourceAllowedHosts: new Set((env.CODE_GRAPH_SOURCE_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)),
    cacheTtlMs: positiveInteger(env.CODE_GRAPH_CACHE_TTL_MS, 86_400_000, 'CODE_GRAPH_CACHE_TTL_MS'),
    cacheMaxBytes: positiveInteger(env.CODE_GRAPH_CACHE_MAX_BYTES, 10_737_418_240, 'CODE_GRAPH_CACHE_MAX_BYTES'),
    internalToken: env.CODE_GRAPH_INTERNAL_TOKEN ?? '',
  });
}
