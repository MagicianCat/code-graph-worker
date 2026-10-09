import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitNexusAdapter } from '../src/gitnexus-adapter.js';

async function fakeAdapter() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-gitnexus-'));
  const binary = fileURLToPath(new URL('../fixtures/fake-gitnexus.mjs', import.meta.url));
  await fs.chmod(binary, 0o755);
  return { root, adapter: new GitNexusAdapter({
    gitnexusHome: root, gitnexusBin: binary, gitnexusVersion: '1.6.12', workerPoolSize: 1,
    queryTimeoutMs: 5_000, buildTimeoutMs: 5_000,
  }) };
}

test('validates the nested GitNexus 1.6.12 status shape', async () => {
  const adapter = new GitNexusAdapter({
    gitnexusHome: '/tmp/test', gitnexusBin: 'gitnexus', gitnexusVersion: '1.6.12', workerPoolSize: 1, queryTimeoutMs: 1000,
  });
  adapter.status = async () => ({
    storagePath: '/tmp/repo/.gitnexus',
    index: { commit: 'a'.repeat(40), runnerIdentityStatus: 'current', incompleteReasons: [], contentRetention: 'full' },
    current: { commit: 'a'.repeat(40) },
  });
  adapter.query = async () => ({ definitions: [] });
  const status = await adapter.validate('repo', 'a'.repeat(40));
  assert.equal(status.index.commit, 'a'.repeat(40));
});

test('accepts a restored exact index only when its recorded CLI version matches', async () => {
  const adapter = new GitNexusAdapter({
    gitnexusHome: '/tmp/test', gitnexusBin: 'gitnexus', gitnexusVersion: '1.6.12', workerPoolSize: 1, queryTimeoutMs: 1000,
  });
  adapter.status = async () => ({
    storagePath: '/tmp/repo/.gitnexus',
    index: {
      commit: 'a'.repeat(40), runnerIdentityStatus: 'stale-or-unknown', incompleteReasons: [],
      runnerIdentity: { cliVersion: '1.6.12' },
    },
    current: { commit: 'a'.repeat(40) },
  });
  adapter.query = async () => ({ definitions: [] });
  await assert.rejects(() => adapter.validate('repo', 'a'.repeat(40)), /validation failed/);
  const status = await adapter.validate('repo', 'a'.repeat(40), true);
  assert.equal(status.index.runnerIdentity.cliVersion, '1.6.12');
});

test('executes the pinned adapter operations with argument arrays', async () => {
  const { root, adapter } = await fakeAdapter();
  assert.equal(await adapter.version(), '1.6.12');
  await adapter.analyze('/tmp/repo', 'repo', false);
  await adapter.analyze('/tmp/repo', 'repo', true);
  assert.equal((await adapter.status('repo')).index.commit, 'a'.repeat(40));
  assert.equal((await adapter.query('repo', 'run', 1)).definitions[0].name, 'run');
  assert.equal((await adapter.context('repo', { name: 'A', filePath: 'a' }, 1)).status, 'found');
  assert.equal((await adapter.impact('repo', { name: 'A', kind: 'CLASS', filePath: 'a' }, { direction: 'UPSTREAM', includeTests: true })).risk, 'LOW');
  assert.equal((await adapter.trace('repo', { name: 'a', filePath: 'a' }, { name: 'b', filePath: 'b' }, { includeTests: true })).status, 'ok');
  const registry = await adapter.createGroup('test-group', [{ logicalName: 'backend', alias: 'repo' }]);
  assert.deepEqual(registry.contracts, []);
  await fs.rm(root, { recursive: true, force: true });
});

test('reuses an intact registry entry without removing its live cache storage', async () => {
  const { root, adapter } = await fakeAdapter();
  const repoPath = path.join(root, 'cache', 'bundle-repo');
  await fs.mkdir(path.join(repoPath, '.gitnexus'), { recursive: true });
  const owned = JSON.stringify({ sentinel: true, repoPath, storagePath: path.join(repoPath, '.gitnexus') });
  await fs.writeFile(path.join(repoPath, '.gitnexus', 'meta.json'), owned);
  await fs.writeFile(path.join(repoPath, '.gitnexus', 'gitnexus.json'), owned);
  await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify([{ name: 'bundle-repo', path: repoPath }]));

  assert.equal(await adapter.registerExisting(repoPath, 'bundle-repo'), repoPath);
  assert.equal(JSON.parse(await fs.readFile(path.join(repoPath, '.gitnexus', 'meta.json'))).sentinel, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('drops a foreign exact registry entry without deleting the restored index', async () => {
  const { root, adapter } = await fakeAdapter();
  const repoPath = path.join(root, 'cache', 'bundle-repo');
  await fs.mkdir(path.join(repoPath, '.gitnexus'), { recursive: true });
  const foreign = JSON.stringify({ repoPath: '/old/work/repo', storagePath: '/old/work/repo/.gitnexus' });
  await fs.writeFile(path.join(repoPath, '.gitnexus', 'meta.json'), foreign);
  await fs.writeFile(path.join(repoPath, '.gitnexus', 'gitnexus.json'), foreign);
  await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify([{ name: 'bundle-repo', path: repoPath }]));

  assert.equal(await adapter.registerExisting(repoPath, 'bundle-repo'), repoPath);
  const restored = JSON.parse(await fs.readFile(path.join(repoPath, '.gitnexus', 'meta.json')));
  assert.equal(restored.repoPath, repoPath);
  assert.equal(restored.storagePath, path.join(repoPath, '.gitnexus'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'registry.json'))), []);
  await fs.rm(root, { recursive: true, force: true });
});
