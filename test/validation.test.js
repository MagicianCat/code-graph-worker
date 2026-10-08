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

test('accepts a mixed reuse plan with exact, incremental and full repository decisions', () => {
  const value = request();
  value.buildMode = 'MIXED';
  value.baseBundleArtifactUri = 'file:///data/code-graph/artifacts/base.tar.zst';
  value.baseBundleSha256 = 'd'.repeat(64);
  value.reusePlan = { repositories: { backend: { mode: 'EXACT', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) } } };
  assert.equal(validateBuildRequest(value).buildMode, 'MIXED');
});

test('rejects incremental reuse without a base bundle and ancestor identity', () => {
  const value = request();
  value.buildMode = 'INCREMENTAL';
  value.reusePlan = { repositories: { backend: { mode: 'INCREMENTAL' } } };
  assert.throws(() => validateBuildRequest(value), /base bundle|baseCommitSha/);
});

test('rejects reuse plan entries for repositories not in the request', () => {
  const value = request();
  value.buildMode = 'MIXED';
  value.baseBundleArtifactUri = 'file:///data/code-graph/artifacts/base.tar.zst';
  value.baseBundleSha256 = 'd'.repeat(64);
  value.reusePlan = { repositories: { missing: { mode: 'EXACT', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) } } };
  assert.throws(() => validateBuildRequest(value), /unknown repository/);
});

test('accepts per-repository base artifacts from different historical bundles', () => {
  const value = request();
  value.repositories.push({ ...value.repositories[0], logicalName: 'frontend', repositoryKey: 'frontend', commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) });
  value.buildMode = 'MIXED';
  value.reusePlan = { repositories: {
    backend: { mode: 'EXACT', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40), baseArtifactUri: 'file:///data/a.tar.zst', baseArtifactSha256: 'd'.repeat(64), baseArtifactRepositoryAlias: 'backend-old' },
    frontend: { mode: 'INCREMENTAL', baseCommitSha: 'c'.repeat(40), baseTreeSha: 'd'.repeat(40), baseArtifactUri: 'file:///data/b.tar.zst', baseArtifactSha256: 'e'.repeat(64), baseArtifactRepositoryAlias: 'frontend-old' },
  } };
  assert.equal(validateBuildRequest(value).reusePlan.repositories.frontend.baseArtifactRepositoryAlias, 'frontend-old');
});

test('accepts a subset whose historical artifact alias differs from current logical name', () => {
  const value = request();
  value.buildMode = 'INCREMENTAL';
  value.reusePlan = { repositories: {
    backend: { mode: 'INCREMENTAL', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40), baseArtifactUri: 'file:///data/group-abc.tar.zst', baseArtifactSha256: 'd'.repeat(64), baseArtifactRepositoryAlias: 'api-service' },
  } };
  assert.equal(validateBuildRequest(value).reusePlan.repositories.backend.baseArtifactRepositoryAlias, 'api-service');
});
