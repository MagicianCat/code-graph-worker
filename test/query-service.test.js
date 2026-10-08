import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryService } from '../src/query-service.js';

const graph = { schemaVersion: 1, graph: { bundleArtifactUri: 'file:///managed/bundle.tar.zst', bundleSha256: 'a'.repeat(64) } };
const metadata = {
  engine: 'GITNEXUS', engineVersion: '1.6.12', adapterVersion: '0.1.0',
  repositories: [{ logicalName: 'backend', repositoryKey: 'backend', commitSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), buildMode: 'FULL', nodeCount: 2, edgeCount: 1 }],
  routeNormalization: { version: 1, explicitLinkCount: 1, resolvedLinkCount: 1, associations: [{
    originalContractId: 'http::GET::/users', normalizedContractId: 'http::GET::/api/users',
    consumer: { repository: 'backend', symbolUid: 'Function:users', symbolRef: { filePath: 'src/users.ts', name: 'users' } },
    provider: null, status: 'UNRESOLVED', confidence: 0,
  }] },
};

function service() {
  const calls = [];
  const adapter = {
    async registerExisting(path, alias) { calls.push(['register', path, alias]); },
    async query() { return { definitions: [] }; },
  };
  const artifactStore = { async materialize() { return '/private/worker/cache'; } };
  const value = new QueryService(adapter, artifactStore, 2);
  value.__calls = calls;
  // Avoid filesystem dependence while preserving the metadata validation path.
  value.__metadata = metadata;
  return value;
}

test('overview and route-map return standard DTOs without registering an engine repository', async () => {
  const value = service();
  value.__resolveMetadata = undefined;
  // The service reads metadata from the materialized artifact. Stub fs-backed resolution
  // at the artifact store boundary by using a temporary module-independent override.
  const original = value.artifactStore.materialize;
  value.artifactStore.materialize = async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-query-'));
    await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata));
    return root;
  };
  try {
    const overview = await value.run('overview', graph);
    assert.equal(overview.repositoryCount, 1);
    const routeMap = await value.run('route-map', { ...graph, repository: 'backend', limit: 10 });
    assert.equal(routeMap.schemaVersion, 1);
    assert.equal(routeMap.routes.length, 1);
    assert.equal(value.__calls.length, 0);
  } finally {
    value.artifactStore.materialize = original;
  }
});

test('rejects oversized query and invalid limits before invoking the engine', async () => {
  const value = service();
  await assert.rejects(value.run('query', { ...graph, query: 'x'.repeat(2_001) }), /maximum length/);
  await assert.rejects(value.run('route-map', { ...graph, limit: 501 }), /out of range/);
});

test('uses the first structured graph repository when repository is omitted', async () => {
  const value = service();
  value.artifactStore.materialize = async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-default-repo-'));
    await fs.mkdir(path.join(root, 'repositories', 'backend'), { recursive: true });
    await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata));
    return root;
  };
  const result = await value.run('query', { ...graph, graph: { ...graph.graph, repositories: [{ logicalName: 'backend', alias: 'backend' }] }, query: 'workflow' });
  assert.equal(result.schemaVersion, 1);
  assert.match(value.__calls[0][1], /repositories\/backend$/);
});
