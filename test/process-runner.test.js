import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/process-runner.js';

test('passes metacharacters as inert arguments without a shell', async () => {
  const marker = '/tmp/code-graph-worker-shell-injection-marker';
  const payload = `$(touch ${marker})`;
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload]);
  assert.equal(result.stdout, payload);
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(marker)));
});

test('maps non-zero exits and timeouts to stable worker errors', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)']), (error) => error.code === 'ENGINE_ANALYZE_FAILED');
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 1000)'], { timeoutMs: 10 }), (error) => error.code === 'QUERY_TIMEOUT');
});
