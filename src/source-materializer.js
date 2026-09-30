import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WorkerError } from './errors.js';
import { runProcess } from './process-runner.js';

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function assertSafeTarEntries(listing) {
  for (const raw of listing.split('\n')) {
    const entry = raw.trim();
    if (!entry) continue;
    const normalized = path.posix.normalize(entry);
    if (path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../')) {
      throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source archive contains an unsafe path', {
        status: 400,
        details: { entry },
      });
    }
  }
}

function isInsideAllowedRoot(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

async function download(uri, target, options) {
  const parsed = new URL(uri);
  if (parsed.protocol === 'file:') {
    const source = await fsp.realpath(path.resolve(decodeURIComponent(parsed.pathname)));
    const roots = await Promise.all(options.sourceFileRoots.map((root) => fsp.realpath(root)));
    if (!isInsideAllowedRoot(source, roots)) {
      throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source file is outside configured input roots', { status: 400 });
    }
    const stat = await fsp.stat(source);
    if (!stat.isFile() || stat.size > options.maxSourceBytes) throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source artifact is too large or not a file', { status: 400 });
    await fsp.copyFile(source, target);
    return;
  }
  throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'M1 accepts source artifacts only from mounted file roots', { status: 400 });
}

export async function materializeRepository(repository, destination, options) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = path.join(path.dirname(destination), `${repository.logicalName}.source.tar`);
  await download(repository.sourceArtifactUri, archive, options);
  const actualSha = await sha256File(archive);
  if (actualSha !== repository.sourceSha256) {
    throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source artifact checksum mismatch', {
      status: 400,
      details: { expected: repository.sourceSha256, actual: actualSha },
    });
  }
  const { stdout: listing } = await runProcess('tar', ['-tf', archive], { timeoutMs: 60_000 });
  assertSafeTarEntries(listing);
  const { stdout: verboseListing } = await runProcess('tar', ['-tvf', archive], { timeoutMs: 60_000 });
  const entries = verboseListing.split('\n').filter(Boolean);
  let extractedBytes = 0;
  if (entries.length > options.maxArchiveEntries) throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source archive contains too many entries', { status: 400 });
  for (const line of entries) {
    if (!line.startsWith('-') && !line.startsWith('d')) throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source archive contains an unsupported entry type', { status: 400 });
    const size = Number(line.trim().split(/\s+/)[2] ?? 0);
    if (Number.isFinite(size)) extractedBytes += size;
  }
  if (extractedBytes > options.maxExtractedBytes) throw new WorkerError('SOURCE_ARTIFACT_INVALID', 'Source archive expands beyond configured limit', { status: 400 });
  await runProcess('tar', ['--no-same-owner', '-xf', archive, '-C', destination], { timeoutMs: 120_000 });
  const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
    runProcess('git', ['-C', destination, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 }),
    runProcess('git', ['-C', destination, 'rev-parse', 'HEAD^{tree}'], { timeoutMs: 10_000 }),
  ]);
  if (commit.trim() !== repository.commitSha || tree.trim() !== repository.treeSha) {
    throw new WorkerError('SOURCE_COMMIT_MISMATCH', 'Materialized source does not match the frozen commit', {
      status: 400,
      details: { expectedCommit: repository.commitSha, actualCommit: commit.trim(), expectedTree: repository.treeSha, actualTree: tree.trim() },
    });
  }
  await fsp.rm(archive, { force: true });
  return destination;
}
