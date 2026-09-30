import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { errorBody, WorkerError } from './errors.js';
import { GitNexusAdapter } from './gitnexus-adapter.js';
import { ArtifactStore } from './artifact-store.js';
import { JobStore } from './job-store.js';
import { BuildService } from './build-service.js';
import { QueryService } from './query-service.js';

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new WorkerError('INVALID_REQUEST', 'Request body too large', { status: 400 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw new WorkerError('INVALID_REQUEST', 'Malformed JSON body', { status: 400 }); }
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function createApplication(config = loadConfig()) {
  if (!config.internalToken) throw new Error('CODE_GRAPH_INTERNAL_TOKEN is required');
  await Promise.all([config.workRoot, config.artifactRoot, config.cacheRoot, config.gitnexusHome].map(async (directory) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }));
  const adapter = new GitNexusAdapter(config);
  await adapter.version();
  const artifactStore = new ArtifactStore(config);
  const jobStore = new JobStore(path.join(config.dataRoot, 'jobs'));
  await jobStore.initialize();
  const buildService = new BuildService(config, adapter, artifactStore, jobStore);
  const queryService = new QueryService(adapter, artifactStore, config.maxConcurrentQueries);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://worker.internal');
      if (request.method === 'GET' && url.pathname === '/internal/code-graph/health') {
        return send(response, 200, { status: 'UP', workerVersion: '0.1.0', engine: 'GITNEXUS', engineVersion: config.gitnexusVersion });
      }
      if (request.headers.authorization !== `Bearer ${config.internalToken}`) throw new WorkerError('UNAUTHORIZED', 'Unauthorized', { status: 401 });
      if (request.method === 'POST' && url.pathname === '/internal/code-graph/build') {
        const job = await buildService.submit(await readJson(request), request.headers['idempotency-key']);
        return send(response, 202, { schemaVersion: 1, engineJobId: job.engineJobId, status: job.status, acceptedAt: job.createdAt });
      }
      const jobMatch = request.method === 'GET' && url.pathname.match(/^\/internal\/code-graph\/jobs\/([0-9a-f-]+)$/);
      if (jobMatch) return send(response, 200, await buildService.get(jobMatch[1]));
      const queryRoutes = new Map([
        ['/internal/code-graph/query', 'query'], ['/internal/code-graph/context', 'context'],
        ['/internal/code-graph/impact', 'impact'], ['/internal/code-graph/trace', 'trace'],
      ]);
      if (request.method === 'POST' && queryRoutes.has(url.pathname)) {
        return send(response, 200, await queryService.run(queryRoutes.get(url.pathname), await readJson(request)));
      }
      throw new WorkerError('JOB_NOT_FOUND', 'Endpoint not found', { status: 404 });
    } catch (error) {
      const status = error instanceof WorkerError ? error.status : 500;
      if (!(error instanceof WorkerError)) console.error(error);
      send(response, status, errorBody(error));
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const server = await createApplication(config);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.listen(config.port, '0.0.0.0', () => console.log(`code-graph-worker listening on ${config.port}`));
}
