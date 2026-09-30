import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConsumerRoute, resolveRouteAssociations } from '../src/route-normalizer.js';

test('adds a configured axios base path exactly once', () => {
  assert.equal(normalizeConsumerRoute('/workflow-runs/{param}', '/api/v1'), '/api/v1/workflow-runs/{param}');
  assert.equal(normalizeConsumerRoute('/api/v1/workflow-runs/{param}', '/api/v1'), '/api/v1/workflow-runs/{param}');
});

test('rejects unsafe prefixes', () => {
  assert.throws(() => normalizeConsumerRoute('/x', '/../admin'), /Invalid HTTP route prefix/);
});

test('associates real consumer and provider symbols after prefix normalization', () => {
  const links = [{ consumerRepository: 'frontend', providerRepository: 'backend', method: 'POST', path: '/workflow-runs/{param}/interventions' }];
  const contracts = [
    { repo: 'frontend', role: 'consumer', contractId: 'http::POST::/workflow-runs/{param}/interventions', symbolUid: 'Function:sendIntervention', symbolRef: { filePath: 'api.ts', name: 'sendIntervention' }, confidence: 0.7 },
    { repo: 'backend', role: 'provider', contractId: 'http::POST::/api/v1/workflow-runs/{param}/interventions', symbolUid: 'Method:intervention', symbolRef: { filePath: 'Controller.java', name: 'intervention' }, confidence: 0.9 },
  ];
  const [result] = resolveRouteAssociations(links, { frontend: '/api/v1' }, contracts);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.consumer.symbolUid, 'Function:sendIntervention');
  assert.equal(result.provider.symbolUid, 'Method:intervention');
  assert.equal(result.confidence, 0.7);
});
