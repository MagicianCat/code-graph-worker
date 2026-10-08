import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery, normalizeContext, normalizeImpact, normalizeOverview, normalizeRouteMap, normalizeTrace } from '../src/dto-normalizer.js';

test('normalizes GitNexus definitions and de-duplicates symbols', () => {
  const raw = {
    definitions: [{ id: 'Method:a.java:A.run#0', name: 'run', filePath: 'a.java', startLine: 2, endLine: 4 }],
    process_symbols: [{ id: 'Method:a.java:A.run#0', name: 'run', filePath: 'a.java' }],
  };
  const result = normalizeQuery(raw, 'backend', 20);
  assert.equal(result.symbols.length, 1);
  assert.equal(result.symbols[0].kind, 'METHOD');
  assert.equal(result.symbols[0].repository, 'backend');
});

test('normalizes trace hops and edge endpoints', () => {
  const result = normalizeTrace({ status: 'ok', hops: [
    { name: 'start', filePath: 'Controller.java', startLine: 10 },
    { name: 'start', filePath: 'Service.java', startLine: 20 },
  ], edges: [{ relType: 'CALLS', confidence: 0.85 }] }, 'backend');
  assert.equal(result.symbols.length, 2);
  assert.equal(result.relations[0].fromUid, result.symbols[0].uid);
  assert.equal(result.relations[0].toUid, result.symbols[1].uid);
});

test('normalizes impact depth, risk, and lower-bound reason', () => {
  const result = normalizeImpact({
    target: { id: 'Class:a:A', name: 'A', filePath: 'a' }, risk: 'HIGH', epistemic: 'lower-bound', truncationReason: 'incomplete-sync',
    byDepth: { 1: [{ id: 'Method:b:B.run', name: 'run', filePath: 'b', relationType: 'CALLS', confidence: 0.8 }] },
  }, 'backend', 'UPSTREAM');
  assert.equal(result.risk, 'HIGH');
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'INCOMPLETE_SYNC');
  assert.equal(result.relations[0].type, 'CALLS');
});

test('normalizes context directions into relations', () => {
  const result = normalizeContext({
    symbol: { uid: 'Class:a.java:A', kind: 'Class', name: 'A', filePath: 'a.java' },
    incoming: { imports: [{ uid: 'File:b.java', name: 'b.java', filePath: 'b.java' }] },
    outgoing: { has_method: [{ uid: 'Method:a.java:A.run#0', name: 'run', filePath: 'a.java' }] },
  }, 'backend');
  assert.deepEqual(result.relations.map((item) => item.type), ['IMPORTS', 'CONTAINS']);
  assert.equal(result.relations[0].toUid, 'Class:a.java:A');
});

test('normalizes overview and redacts absolute engine paths in route map', () => {
  const overview = normalizeOverview({ engine: 'GITNEXUS', engineVersion: '1.6.12', adapterVersion: '0.1.0', repositories: [{ logicalName: 'backend', repositoryKey: 'b', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), nodeCount: 3, edgeCount: 4 }] });
  assert.equal(overview.repositoryCount, 1);
  const routes = normalizeRouteMap({ routeNormalization: { associations: [{ originalContractId: 'http::GET::/x', normalizedContractId: 'http::GET::/x', consumer: { repository: 'frontend', symbolUid: 'Function:x', symbolRef: { filePath: '/private/tmp/source/a.ts', name: 'x' } }, provider: null, status: 'UNRESOLVED', confidence: 0 }] } });
  assert.equal(routes.routes[0].consumer.symbolRef.filePath, '');
});
