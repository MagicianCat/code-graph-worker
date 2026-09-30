import fs from 'node:fs/promises';
import path from 'node:path';

export class JobStore {
  constructor(root) {
    this.root = root;
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const file of await fs.readdir(this.root)) {
      if (!file.endsWith('.json')) continue;
      const job = JSON.parse(await fs.readFile(path.join(this.root, file), 'utf8'));
      if (job.status === 'RUNNING' || job.status === 'QUEUED') {
        job.status = 'FAILED';
        job.error = { code: 'INTERNAL_ERROR', message: 'Worker restarted during build', retryable: true, details: {} };
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
        await this.save(job);
      }
    }
  }

  async save(job) {
    const target = path.join(this.root, `${job.engineJobId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
    return job;
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async findByIdempotencyKey(key) {
    for (const file of await fs.readdir(this.root)) {
      if (!file.endsWith('.json')) continue;
      const job = JSON.parse(await fs.readFile(path.join(this.root, file), 'utf8'));
      if (job.idempotencyKey === key) return job;
    }
    return null;
  }
}
