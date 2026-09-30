import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildRequest, validateGraphRequest } from '../src/validation.js';

function request() {
  return {
    schemaVersion: 1,
    requestId: 'a5bd7c3f-bab6-493e-b3e5-8bc3a3db83b9',
    bundleKey: 'test-bundle',
    buildMode: 'FULL',
    repositories: [{
      repositoryKey: 'backend', logicalName: 'backend', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
      sourceArtifactUri: 'file:///tmp/backend.tar', sourceSha256: 'c'.repeat(64),
    }],
  };
}

test('accepts a frozen repository source descriptor', () => {
  assert.equal(validateBuildRequest(request()).repositories[0].logicalName, 'backend');
});

test('rejects dynamic or malformed commit identifiers', () => {
  const value = request();
  value.repositories[0].commitSha = 'main';
  assert.throws(() => validateBuildRequest(value), /Invalid repository descriptor/);
});

test('rejects duplicate logical names', () => {
  const value = request();
  value.repositories.push({ ...value.repositories[0], repositoryKey: 'another' });
  assert.throws(() => validateBuildRequest(value), /Duplicate repository logicalName/);
});

test('validates graph selectors and route references', () => {
  assert.equal(validateGraphRequest({ schemaVersion: 1, graph: { bundleArtifactUri: 'file:///x', bundleSha256: 'a'.repeat(64) } }).schemaVersion, 1);
  assert.throws(() => validateGraphRequest({ schemaVersion: 1, graph: {} }), /Invalid graph selector/);
  const value = request();
  value.options = { httpRoutePrefixes: { missing: '/api' } };
  assert.throws(() => validateBuildRequest(value), /unknown repository/);
});
