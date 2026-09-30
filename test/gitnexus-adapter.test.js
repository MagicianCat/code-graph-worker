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
