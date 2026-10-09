import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticExportService } from '../src/semantic-export.js';

const graph = { bundleArtifactUri: 'file:///managed/bundle.tar.zst', bundleSha256: 'a'.repeat(64) };

/**
 * Builds a service whose stub adapter returns canned rows keyed by Cypher MATCH label.
 * `rowsByLabel` maps e.g. `{ Class: [...rows], Method: [...rows] }` — the adapter
 * extracts the label from the `MATCH (n:<Label>)` clause in the query.
 */
function service(rowsByLabel = {}) {
  const calls = [];
  const adapter = {
    async registerExisting() {},
    async cypher(repoPath, query, limit) {
      calls.push({ repoPath, query, limit });
      const label = /MATCH \(n:(\w+)\)/.exec(query)?.[1];
      const rows = [...(rowsByLabel[label] ?? [])];
      // Apply the same WHERE / ORDER BY / LIMIT semantics we expect GitNexus to honor.
      const afterMatch = /WHERE n\.id > '([^']+)'/.exec(query);
      const filtered = afterMatch ? rows.filter((row) => String(row.id) > afterMatch[1]) : rows;
      const limitMatch = /LIMIT (\d+)/.exec(query);
      const limited = limitMatch ? filtered.slice(0, Number(limitMatch[1])) : filtered;
      return { rows: limited };
    },
    calls,
  };
  const artifactStore = { async materialize() { return '/tmp/worker-artifact'; } };
  const metadata = { repositories: [{ logicalName: 'backend', repositoryKey: 'repo-1' }] };
  return { value: new SemanticExportService(adapter, artifactStore, async () => metadata), adapter };
}

test('rejects arbitrary cypher and unsupported graph selectors', async () => {
  const { value } = service();
  await assert.rejects(value.export({ schemaVersion: 1, graph, repository: 'backend', cypher: 'MATCH (n) RETURN n' }), /Cypher|selector/);
  await assert.rejects(value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['FILE'] }), /nodeTypes/);
});

test('exports symbols across multiple labels with keyset pagination', async () => {
  // Class exhausts after 2 rows; the service must advance to Method and pull 1
  // more row to fill the requested limit of 3.
  const { value, adapter } = service({
    Class: [
      { id: 'Class:src/A.java:A', name: 'A', filePath: '/private/work/src/A.java', language: 'Java', description: 'x'.repeat(2_000) },
      { id: 'Class:src/B.java:B', name: 'B' },
    ],
    Method: [
      { id: 'Method:src/B.java:B.m', name: 'm' },
    ],
  });
  const first = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 3 });
  assert.equal(first.items.length, 3);
  assert.equal(first.items[0].filePath, 'src/A.java'); // src marker stripped
  assert.ok(first.items[0].summary.length <= 1000);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  assert.match(adapter.calls[0].query, /^MATCH \(n:(Function|Class)/);
});

test('uses keyset pagination: lastUid of a page becomes the next WHERE', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `Class:src/F.java:F${i}`, name: `F${i}` }));
  const { value, adapter } = service({ Class: rows });
  const first = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 2 });
  assert.deepEqual(first.items.map((it) => it.nodeUid), ['Class:src/F.java:F0', 'Class:src/F.java:F1']);
  const second = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((it) => it.nodeUid), ['Class:src/F.java:F2', 'Class:src/F.java:F3']);
  // The WHERE clause in the second call must reference F1 (the last uid of page 1).
  const secondQuery = adapter.calls.at(-1).query;
  assert.match(secondQuery, /WHERE n\.id > 'Class:src\/F\.java:F1'/);
});

test('cursor is bound to selector and invalid uid chars are rejected', async () => {
  const { value } = service({ Class: [{ id: 'Class:1', name: 'a' }] });
  const first = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 1 });
  await assert.rejects(value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['PROCESS'], limit: 1, cursor: first.nextCursor }), /cursor/);
});

test('preserves full relative path when no src/app/lib marker matches', async () => {
  const { value } = service({
    Class: [
      { id: 'Class:Readme1', name: 'ReadmeA', filePath: '/work/docs/guide/README.md' },
      { id: 'Class:Readme2', name: 'ReadmeB', filePath: '/work/docs/api/README.md' },
    ],
  });
  const result = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 10 });
  const paths = result.items.map((item) => item.filePath);
  assert.deepEqual(paths, ['work/docs/guide/README.md', 'work/docs/api/README.md']);
  assert.ok(paths.every((p) => p !== 'README.md'));
});

test('caps filePath length to protect payload size', async () => {
  const longPath = '/work/' + 'a/'.repeat(400) + 'File.java';
  const { value } = service({ Class: [{ id: 'Class:F', name: 'F', filePath: longPath }] });
  const result = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 10 });
  assert.ok(result.items[0].filePath.length <= 500);
});

test('parses GitNexus markdown table output', async () => {
  // GitNexus 1.6.12 returns cypher results as { markdown: "| col | ...", row_count: N }.
  // Simulate a single-label repository: only the first matching label returns rows;
  // the others return empty markdown so the loop terminates.
  const markdown = '| nodeUid | name | startLine |\n' +
      '| --- | --- | --- |\n' +
      '| Class:src/A.java:A | A | 12 |\n' +
      '| Class:src/B.java:B | B | 34 |';
  const empty = { markdown: '| nodeUid | name | startLine |\n| --- | --- | --- |', row_count: 0 };
  const adapter = {
    async registerExisting() {},
    async cypher(alias, query) {
      // Only Class queries return rows; others are empty.
      return /MATCH \(n:Class\)/.test(query) ? { markdown, row_count: 2 } : empty;
    },
  };
  const artifactStore = { async materialize() { return '/tmp/worker-artifact'; } };
  const metadata = { repositories: [{ logicalName: 'backend', repositoryKey: 'repo-1' }] };
  const value = new SemanticExportService(adapter, artifactStore, async () => metadata);

  const result = await value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 10 });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].nodeUid, 'Class:src/A.java:A');
  assert.equal(result.items[0].name, 'A');
  assert.equal(result.items[0].startLine, 12); // coerced from string
  assert.equal(result.items[1].startLine, 34);
});

test('allows only bounded limits', async () => {
  const { value } = service({ Class: [{ id: 'Class:1', name: 'a' }] });
  await assert.rejects(value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 0 }), /limit/);
  await assert.rejects(value.export({ schemaVersion: 1, graph, repository: 'backend', nodeTypes: ['SYMBOL'], limit: 501 }), /limit/);
});
