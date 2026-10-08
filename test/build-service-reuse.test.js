import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BuildService } from '../src/build-service.js';

const sha = (letter) => letter.repeat(40);
const checksum = (letter) => letter.repeat(64);

function repository(logicalName, commit = 'a', tree = 'b') {
  return {
    repositoryKey: logicalName,
    logicalName,
    commitSha: sha(commit),
    treeSha: sha(tree),
    sourceArtifactUri: `file:///inputs/${logicalName}.tar`,
    sourceSha256: checksum('c'),
  };
}

function request(repositories, reusePlan = null) {
  return {
    schemaVersion: 1, requestId: crypto.randomUUID(), bundleKey: `bundle-${Math.random().toString(36).slice(2, 8)}`,
    buildMode: reusePlan ? 'MIXED' : 'FULL', repositories, ...(reusePlan ? { reusePlan } : {}),
  };
}

async function fixture({ roots = {}, failAnalyze = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-build-test-'));
  const config = { workRoot: path.join(root, 'work'), maxConcurrentBuilds: 1 };
  const calls = { analyze: [], register: [], validate: [], materialize: [], publish: 0, group: 0, process: [] };
  const storage = path.join(root, 'engine-index');
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, 'index.db'), 'fake');
  const adapter = {
    async analyze(repoPath, alias, force) { calls.analyze.push({ repoPath, alias, force }); if (failAnalyze) throw new Error('analysis failed'); },
    async registerExisting(repoPath, alias) { calls.register.push({ repoPath, alias }); },
    async validate(alias, commitSha) { calls.validate.push({ alias, commitSha }); return { storagePath: storage, nodeCount: 1, edgeCount: 2 }; },
    async createGroup() { calls.group += 1; return { contracts: [], crossLinks: [] }; },
  };
  const artifactStore = {
    async materialize(uri, artifactSha) { calls.materialize.push({ uri, artifactSha }); return roots[uri]; },
    async publish() { calls.publish += 1; return { artifactUri: 'file:///artifact.tar.zst', sha256: checksum('e') }; },
  };
  const jobs = new Map();
  const jobStore = {
    async findByIdempotencyKey(key) { return [...jobs.values()].find((job) => job.idempotencyKey === key) ?? null; },
    async save(job) { jobs.set(job.engineJobId, job); return job; },
    async get(id) { return jobs.get(id) ?? null; },
  };
  const materialize = async (_repository, destination) => fs.mkdir(destination, { recursive: true });
  const processRunner = async (...args) => { calls.process.push(args); return { stdout: '', stderr: '', exitCode: 0 }; };
  return { root, calls, jobs, service: new BuildService(config, adapter, artifactStore, jobStore, materialize, processRunner), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function waitFor(jobs, id) {
  for (let i = 0; i < 100; i += 1) {
    const job = jobs.get(id);
    if (['SUCCEEDED', 'FAILED'].includes(job?.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not finish');
}

test('EXACT restores an alias without invoking analyze', async () => {
  const baseUri = 'file:///base/exact.tar.zst';
  const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'base-exact-'));
  await fs.mkdir(path.join(baseRoot, 'repositories', 'api-service', '.gitnexus'), { recursive: true });
  const f = await fixture({ roots: { [baseUri]: baseRoot } });
  try {
    const job = await f.service.submit(request([repository('backend')], { repositories: {
      backend: { mode: 'EXACT', baseCommitSha: sha('a'), baseTreeSha: sha('b'), baseArtifactUri: baseUri, baseArtifactSha256: checksum('d'), baseArtifactRepositoryAlias: 'api-service' },
    } }), 'idempotency-exact-12345');
    const done = await waitFor(f.jobs, job.engineJobId);
    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(f.calls.analyze.length, 0);
    assert.deepEqual(f.calls.register.map((call) => call.alias), [`job-${job.engineJobId}-backend`]);
    assert.deepEqual(f.calls.materialize, [{ uri: baseUri, artifactSha: checksum('d') }]);
    assert.equal(f.calls.publish, 1);
  } finally { await f.cleanup(); await fs.rm(baseRoot, { recursive: true, force: true }); }
});

test('INCREMENTAL restores, checks ancestry and invokes analyze', async () => {
  const baseUri = 'file:///base/incremental.tar.zst';
  const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'base-incremental-'));
  await fs.mkdir(path.join(baseRoot, 'repositories', 'backend', '.gitnexus'), { recursive: true });
  const f = await fixture({ roots: { [baseUri]: baseRoot } });
  try {
    const job = await f.service.submit(request([repository('backend', 'd', 'e')], { repositories: {
      backend: { mode: 'INCREMENTAL', baseCommitSha: sha('a'), baseTreeSha: sha('b'), baseArtifactUri: baseUri, baseArtifactSha256: checksum('d'), baseArtifactRepositoryAlias: 'backend' },
    } }), 'idempotency-incremental-123');
    const done = await waitFor(f.jobs, job.engineJobId);
    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(f.calls.register.length, 1);
    assert.equal(f.calls.analyze.length, 1);
    assert.equal(f.calls.process[0][1][4], sha('a'));
    assert.equal(f.calls.publish, 1);
  } finally { await f.cleanup(); await fs.rm(baseRoot, { recursive: true, force: true }); }
});

test('multiple reused repositories materialize separate artifacts and group only after all validate', async () => {
  const firstUri = 'file:///base/one.tar.zst';
  const secondUri = 'file:///base/two.tar.zst';
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'base-one-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'base-two-'));
  await fs.mkdir(path.join(firstRoot, 'repositories', 'api-old', '.gitnexus'), { recursive: true });
  await fs.mkdir(path.join(secondRoot, 'repositories', 'web-old', '.gitnexus'), { recursive: true });
  const f = await fixture({ roots: { [firstUri]: firstRoot, [secondUri]: secondRoot } });
  try {
    const job = await f.service.submit(request([repository('backend'), repository('frontend', 'd', 'e')], { repositories: {
      backend: { mode: 'EXACT', baseCommitSha: sha('a'), baseTreeSha: sha('b'), baseArtifactUri: firstUri, baseArtifactSha256: checksum('1'), baseArtifactRepositoryAlias: 'api-old' },
      frontend: { mode: 'EXACT', baseCommitSha: sha('d'), baseTreeSha: sha('e'), baseArtifactUri: secondUri, baseArtifactSha256: checksum('2'), baseArtifactRepositoryAlias: 'web-old' },
    } }), 'idempotency-two-artifacts-123');
    const done = await waitFor(f.jobs, job.engineJobId);
    assert.equal(done.status, 'SUCCEEDED');
    assert.deepEqual(f.calls.materialize.map((call) => call.uri), [firstUri, secondUri]);
    assert.equal(f.calls.group, 1);
    assert.equal(f.calls.publish, 1);
  } finally { await f.cleanup(); await fs.rm(firstRoot, { recursive: true, force: true }); await fs.rm(secondRoot, { recursive: true, force: true }); }
});

test('FULL does not materialize a base and a repository failure prevents group and publish', async () => {
  const f = await fixture({ failAnalyze: true });
  try {
    const job = await f.service.submit(request([repository('backend')]), 'idempotency-full-failure');
    const done = await waitFor(f.jobs, job.engineJobId);
    assert.equal(done.status, 'FAILED');
    assert.equal(f.calls.materialize.length, 0);
    assert.equal(f.calls.group, 0);
    assert.equal(f.calls.publish, 0);
  } finally { await f.cleanup(); }
});
