#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const print = (value) => console.log(`Fake GitNexus\n${JSON.stringify(value)}`);
if (args[0] === '--version') console.log('gitnexus 1.6.12');
else if (args[0] === 'status') print({ storagePath: '/tmp/repo/.gitnexus', index: { commit: 'a'.repeat(40), runnerIdentityStatus: 'current', incompleteReasons: [] } });
else if (args[0] === 'query') print({ definitions: [{ id: 'Method:a:A.run', name: 'run', filePath: 'a' }] });
else if (args[0] === 'cypher') print({ rows: [{ nodeUid: 'Method:a:A.run', name: 'run', filePath: '/private/work/src/a.ts', description: 'fake symbol' }] });
else if (args[0] === 'context') print({ status: 'found', symbol: { uid: 'Class:a:A', name: 'A', kind: 'Class', filePath: 'a' }, incoming: {}, outgoing: {} });
else if (args[0] === 'impact') print({ target: { id: 'Class:a:A', name: 'A', filePath: 'a' }, risk: 'LOW', byDepth: {} });
else if (args[0] === 'trace') print({ status: 'ok', hops: [], edges: [] });
else if (args[0] === 'group' && args[1] === 'create') {
  const name = args[2];
  const directory = path.join(process.env.GITNEXUS_HOME, 'groups', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'group.yaml'), `version: 1\nname: ${name}\nrepos: {}\nlinks: []\n`);
} else if (args[0] === 'group' && args[1] === 'sync') {
  const name = args[2];
  const directory = path.join(process.env.GITNEXUS_HOME, 'groups', name);
  fs.writeFileSync(path.join(directory, 'contracts.json'), JSON.stringify({ contracts: [], crossLinks: [] }));
  print({ ok: true });
} else if (args[0] === 'analyze' || args[0] === 'index' || (args[0] === 'group' && args[1] === 'add')) {
  console.log('ok');
} else {
  console.error(`unsupported: ${args.join(' ')}`);
  process.exit(2);
}
