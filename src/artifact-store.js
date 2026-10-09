import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WorkerError } from './errors.js';
import { runProcess } from './process-runner.js';
import { sha256File } from './source-materializer.js';

export class ArtifactStore {
  constructor(config) {
    this.config = config;
    this.materializations = new Map();
  }

  async publish(bundleKey, engineJobId, stagingRoot, metadata) {
    const directory = path.join(this.config.artifactRoot, bundleKey);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stagingRoot, 'metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
    const temporaryTar = path.join(directory, `.${engineJobId}.tar`);
    const temporaryArchive = `${temporaryTar}.zst`;
    const finalArchive = path.join(directory, `${engineJobId}.tar.zst`);
    await runProcess('tar', ['-cf', temporaryTar, '-C', stagingRoot, '.'], { timeoutMs: this.config.buildTimeoutMs });
    await runProcess('zstd', ['-q', '-f', temporaryTar, '-o', temporaryArchive], { timeoutMs: this.config.buildTimeoutMs });
    await fs.rm(temporaryTar, { force: true });
    await fs.rename(temporaryArchive, finalArchive);
    return { artifactUri: pathToFileURL(finalArchive).href, sha256: await sha256File(finalArchive) };
  }

  async materialize(uri, expectedSha) {
    if (this.materializations.has(expectedSha)) return this.materializations.get(expectedSha);
    const pending = this.#materialize(uri, expectedSha).finally(() => this.materializations.delete(expectedSha));
    this.materializations.set(expectedSha, pending);
    return pending;
  }

  async #materialize(uri, expectedSha) {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') throw new WorkerError('SNAPSHOT_NOT_FOUND', 'Only local artifacts are supported in M1', { status: 404 });
    const archive = await fs.realpath(fileURLToPath(parsed));
    const artifactRoot = await fs.realpath(this.config.artifactRoot);
    if (archive !== artifactRoot && !archive.startsWith(`${artifactRoot}${path.sep}`)) throw new WorkerError('SNAPSHOT_NOT_FOUND', 'Artifact is outside the managed artifact root', { status: 404 });
    if (await sha256File(archive) !== expectedSha) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact checksum mismatch');
    const cacheKey = expectedSha.slice(0, 24);
    const target = path.join(this.config.cacheRoot, cacheKey);
    try {
      await fs.access(path.join(target, 'metadata.json'));
      // A previous crash between the top-level extraction step and a repo's
      // .gitnexus payload write can leave the cache directory half-populated:
      // metadata.json exists but repositories/<name>/.gitnexus is missing.
      // Verify per-repo integrity before declaring the cache hit, otherwise
      // downstream consumers fail with an opaque ENOENT in #registerExisting.
      const metadata = JSON.parse(await fs.readFile(path.join(target, 'metadata.json'), 'utf8'));
      const repos = Array.isArray(metadata.repositories) ? metadata.repositories : [];
      let intact = true;
      for (const repo of repos) {
        const name = repo?.logicalName;
        if (!name) { intact = false; break; }
        try {
          await fs.access(path.join(target, 'repositories', name, '.gitnexus', 'meta.json'));
        } catch {
          intact = false;
          break;
        }
      }
      if (intact) {
        const now = new Date();
        await fs.utimes(target, now, now);
        return target;
      }
      console.log('[artifact-store] cache INCOMPLETE, re-extracting:', target, 'missing repo:', repos.find(r => r?.logicalName && !intact)?.logicalName);
      // Half-populated cache — fall through and re-extract from the archive.
    } catch {}
    await this.#evictCache();
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
    const { stdout: listing } = await runProcess('tar', ['--use-compress-program=zstd', '-tf', archive], { timeoutMs: this.config.buildTimeoutMs });
    const entries = listing.split('\n').filter(Boolean);
    if (entries.length > this.config.maxArchiveEntries) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact contains too many entries');
    for (const entry of entries) {
      const normalized = path.posix.normalize(entry);
      if (path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../')) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact contains an unsafe path');
      if (normalized.split('/').length > 100) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact directory depth exceeds limit');
    }
    const { stdout: verbose } = await runProcess('tar', ['--use-compress-program=zstd', '-tvf', archive], { timeoutMs: this.config.buildTimeoutMs });
    let extractedBytes = 0;
    for (const line of verbose.split('\n').filter(Boolean)) {
      if (!line.startsWith('-') && !line.startsWith('d')) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact contains an unsupported entry type');
      const size = Number(line.trim().split(/\s+/)[2] ?? 0);
      if (Number.isFinite(size)) extractedBytes += size;
    }
    if (extractedBytes > this.config.maxExtractedBytes) throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact expands beyond configured limit');
    await runProcess('tar', ['--use-compress-program=zstd', '--no-same-owner', '-xf', archive, '-C', temporary], { timeoutMs: this.config.buildTimeoutMs });
    // `rename` refuses to replace a non-empty directory on Linux, so an
    // existing (half-populated) cache directory makes the atomic swap fail
    // with ENOTEMPTY/EEXIST. Remove the stale target before retrying once —
    // the archive is the source of truth and we just verified its checksum.
    await fs.rename(temporary, target).catch(async (error) => {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(temporary, target);
    });
    return target;
  }

  async #evictCache() {
    await fs.mkdir(this.config.cacheRoot, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const entries = [];
    for (const name of await fs.readdir(this.config.cacheRoot)) {
      const candidate = path.join(this.config.cacheRoot, name);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isDirectory()) continue;
      let size = 0;
      const pending = [candidate];
      while (pending.length) {
        const current = pending.pop();
        for (const child of await fs.readdir(current, { withFileTypes: true })) {
          const childPath = path.join(current, child.name);
          if (child.isDirectory()) pending.push(childPath);
          else size += (await fs.stat(childPath)).size;
        }
      }
      entries.push({ candidate, mtimeMs: stat.mtimeMs, size });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (now - entry.mtimeMs <= this.config.cacheTtlMs && total <= this.config.cacheMaxBytes) continue;
      await fs.rm(entry.candidate, { recursive: true, force: true });
      total -= entry.size;
    }
  }
}
