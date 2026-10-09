import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerError } from './errors.js';
import { validateGraphRequest } from './validation.js';

/**
 * Labels we treat as "symbols" for the semantic sidecar. GitNexus 1.6.12's
 * LadybugDB dialect does not support multi-label MATCH, `WHERE n:Label`,
 * `labels(n)`, or post-UNION ORDER BY/SKIP — so the SYMBOL export expands
 * to one query per label and stitches results across queries via a keyset
 * cursor (lastNodeUid) rather than an offset.
 *
 * Per-label field selection is required because GitNexus node types have
 * heterogeneous schemas: Class/Method share a common shape, but Community
 * uses label/keywords/cohesion instead of name/filePath. Projecting a
 * non-existent property fails the whole query with "Binder exception".
 */
const SYMBOL_LABELS = ['Function', 'Class', 'Interface', 'Method', 'CodeElement', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Variable', 'Property', 'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module', 'Tool'];

// Common shape for code symbols (Class/Method/Function/etc.).
const CODE_FIELDS = 'n.id AS nodeUid, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.description AS summary';
// Community nodes carry a different shape; name/summary come from label/description.
const COMMUNITY_FIELDS = 'n.id AS nodeUid, n.label AS name, n.description AS summary, n.keywords AS keywords, n.symbolCount AS symbolCount';

const TYPE_ORDER = Object.freeze(['SYMBOL', 'API', 'PROCESS', 'COMMUNITY']);
const TYPE_LABELS = Object.freeze({
  SYMBOL: SYMBOL_LABELS,
  API: ['Route'],
  PROCESS: ['Process'],
  COMMUNITY: ['Community'],
});
const TYPE_FIELDS = Object.freeze({
  SYMBOL: CODE_FIELDS,
  API: CODE_FIELDS,
  PROCESS: CODE_FIELDS,
  COMMUNITY: COMMUNITY_FIELDS,
});

const MAX_SUMMARY = 1000;
const MAX_REPOSITORY = 128;
const MAX_FILE_PATH = 500;

export class SemanticExportService {
  constructor(adapter, artifactStore, metadataResolver = readMetadata) {
    this.adapter = adapter;
    this.artifactStore = artifactStore;
    this.metadataResolver = metadataResolver;
  }

  async export(request) {
    validateRequest(request);
    const nodeTypes = normalizeTypes(request.nodeTypes);
    const selector = selectorKey(request, nodeTypes);
    const cursor = decodeCursor(request.cursor, selector, nodeTypes);
    console.log('[semantic-export] artifactUri=', request.graph?.bundleArtifactUri, 'sha=', request.graph?.bundleSha256);
    const root = await this.artifactStore.materialize(request.graph.bundleArtifactUri, request.graph.bundleSha256);
    const metadata = await this.metadataResolver(root);
    if (!metadata.repositories?.some((entry) => entry.logicalName === request.repository)) {
      throw new WorkerError('SNAPSHOT_NOT_FOUND', `Repository ${request.repository} is not in the bundle`, { status: 404 });
    }
    const repoPath = path.join(root, 'repositories', request.repository);
    // Use a bundle-scoped registry alias so multiple bundles that share a
    // repository logical name (e.g. two snapshots of "backend" from different
    // commits) coexist in the GitNexus registry without aliasing conflicts.
    // The alias is deterministic per (bundle, repository), derived from the
    // bundle artifact sha — which is what `root` ultimately derives from.
    const bundleScope = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, '');
    const alias = `${bundleScope}-${request.repository}`;
    await this.adapter.registerExisting(repoPath, alias);

    // Walk (typeIndex, labelIndex, lastUid) forward until we fill `limit` rows
    // or run out of labels. Keyset pagination is required because LadybugDB
    // does not honor SKIP on this query shape.
    const items = [];
    let { typeIndex, labelIndex, lastUid } = cursor;
    let exhausted = false;
    outer: while (typeIndex < nodeTypes.length) {
      const type = nodeTypes[typeIndex];
      const labels = TYPE_LABELS[type];
      while (labelIndex < labels.length) {
        const label = labels[labelIndex];
        const remaining = request.limit - items.length;
        if (remaining <= 0) break outer;
        const cypher = buildLabelQuery(type, label, lastUid, remaining);
        let result;
        try {
          result = await this.adapter.cypher(alias, cypher, remaining);
        } catch (cypherFailure) {
          // A label that is absent from this repository (e.g. Route in a Java
          // backend repo) makes LadybugDB fail at prepare time with a binder
          // exception. Tolerate that by treating the label as empty and moving
          // to the next one — otherwise a single missing label stalls the
          // entire export even when other labels have data.
          if (isMissingLabelError(cypherFailure)) {
            labelIndex += 1;
            lastUid = '';
            continue;
          }
          throw cypherFailure;
        }
        const rows = rowsOf(result);
        for (const row of rows) {
          const normalized = normalizeNode(row, type, request.repository);
          if (normalized) {
            items.push(normalized);
            lastUid = normalized.nodeUid;
            if (items.length >= request.limit) break;
          }
        }
        if (rows.length < remaining) {
          // Label exhausted — advance to the next label and reset the keyset.
          labelIndex += 1;
          lastUid = '';
        } else {
          // More rows may remain in this label.
          break outer;
        }
        if (items.length >= request.limit) break outer;
      }
      if (labelIndex >= TYPE_LABELS[nodeTypes[typeIndex]].length) {
        typeIndex += 1;
        labelIndex = 0;
        lastUid = '';
      }
    }
    if (typeIndex >= nodeTypes.length) exhausted = true;

    const hasMore = !exhausted && items.length >= request.limit && items.length > 0;
    return {
      schemaVersion: 1,
      repository: request.repository,
      nodeTypes,
      items: items.slice(0, request.limit),
      hasMore,
      nextCursor: hasMore ? encodeCursor({ version: 1, selector, typeIndex, labelIndex, lastUid }) : null,
    };
  }
}

/** Builds a single-label keyset-paginated query. LastUid is SQL-escaped. */
function buildLabelQuery(type, label, lastUid, limit) {
  const where = lastUid ? ` WHERE n.id > '${escapeCypherString(lastUid)}'` : '';
  return `MATCH (n:${label})${where} RETURN ${TYPE_FIELDS[type]} ORDER BY nodeUid LIMIT ${limit}`;
}

/**
 * Detects whether a cypher failure is the "label does not exist in this
 * repository's schema" case. LadybugDB validates property projections at
 * prepare time, so a missing label surfaces as a binder/parse error rather
 * than an empty result. We match on the error body because the worker wraps
 * the engine's exit-1 stderr into a generic WorkerError.
 */
function isMissingLabelError(error) {
  const text = `${error?.message ?? ''} ${JSON.stringify(error?.details ?? {})}`;
  return /Cannot find property|Binder exception|Parser exception|Unknown label|does not exist/i.test(text);
}

function escapeCypherString(value) {
  // The fixed query is a constant — only the cursor uid crosses into it. Refuse
  // anything that is not a conservative identifier-shape string.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:#/\-()[\]~+ ]+$/.test(value)) {
    throw new WorkerError('INVALID_REQUEST', 'cursor uid is invalid', { status: 400 });
  }
  return value.replace(/'/g, "''");
}

function validateRequest(request) {
  validateGraphRequest(request);
  if (typeof request.repository !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.repository)) {
    throw new WorkerError('INVALID_REQUEST', 'repository is required', { status: 400 });
  }
  if (request.cypher !== undefined || request.query !== undefined) throw new WorkerError('INVALID_REQUEST', 'Arbitrary Cypher is not supported', { status: 400 });
  const limit = request.limit === undefined ? 100 : Number(request.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new WorkerError('INVALID_REQUEST', 'limit is out of range', { status: 400 });
  request.limit = limit;
}

function normalizeTypes(value) {
  const types = value === undefined ? [...TYPE_ORDER] : value;
  const aliases = { Symbol: 'SYMBOL', Symbols: 'SYMBOL', Route: 'API', Routes: 'API', Api: 'API', Process: 'PROCESS', Processes: 'PROCESS', Community: 'COMMUNITY', Communities: 'COMMUNITY' };
  const normalized = Array.isArray(types) ? types.map((type) => aliases[type] ?? type) : types;
  if (!Array.isArray(normalized) || normalized.length < 1 || normalized.length > TYPE_ORDER.length || normalized.some((type) => !TYPE_ORDER.includes(type))) {
    throw new WorkerError('INVALID_REQUEST', 'nodeTypes must be a non-empty allowlist', { status: 400 });
  }
  return [...new Set(normalized)];
}

function selectorKey(request, nodeTypes) {
  return crypto.createHash('sha256').update(JSON.stringify({ graph: request.graph, repository: request.repository, nodeTypes })).digest('hex');
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value, selector, nodeTypes) {
  const empty = { typeIndex: 0, labelIndex: 0, lastUid: '' };
  if (!value) return empty;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed?.version !== 1 || parsed.selector !== selector) throw new Error('invalid');
    const { typeIndex, labelIndex, lastUid } = parsed;
    if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex >= nodeTypes.length) throw new Error('invalid');
    const type = nodeTypes[typeIndex];
    const labelCount = TYPE_LABELS[type].length;
    if (!Number.isInteger(labelIndex) || labelIndex < 0 || labelIndex > labelCount) throw new Error('invalid');
    if (typeof lastUid !== 'string') throw new Error('invalid');
    return { typeIndex, labelIndex, lastUid };
  } catch {
    throw new WorkerError('INVALID_REQUEST', 'cursor is invalid for this selector', { status: 400 });
  }
}

function normalizeNode(row, nodeType, repository) {
  const nodeUid = stringValue(row.nodeUid ?? row.uid ?? row.id);
  if (!nodeUid) return null;
  return {
    nodeUid,
    nodeType,
    repository,
    name: stringValue(row.name),
    qualifiedName: stringValue(row.qualifiedName),
    filePath: sanitizePath(row.filePath),
    language: stringValue(row.language),
    summary: stringValue(row.summary ?? row.description ?? row.text ?? row.content).slice(0, MAX_SUMMARY),
    startLine: integerValue(row.startLine),
    endLine: integerValue(row.endLine),
  };
}

function sanitizePath(value) {
  if (typeof value !== 'string' || !value) return '';
  let normalized = value.replaceAll('\\', '/').replace(/^([A-Za-z]:)?\/+/, '').replace(/^\.\//, '');
  normalized = path.posix.normalize(normalized).replace(/^\.\.(?:\/|$)/g, '');
  // Prefer the conventional source-root markers so Agent prompts stay concise.
  const marker = normalized.match(/(?:^|\/)(src|app|lib|packages|test|tests)\/(.*)$/);
  const chosen = marker ? `${marker[1]}/${marker[2]}` : normalized;
  // Never collapse to the bare filename — callers rely on filePath being
  // distinguishable across directories (e.g. multiple README.md files).
  // Cap length so a maliciously deep path cannot blow up the payload.
  return chosen.length > MAX_FILE_PATH ? chosen.slice(-MAX_FILE_PATH) : chosen;
}

function stringValue(value) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
function integerValue(value) {
  if (Number.isInteger(value)) return value;
  // Markdown-table cells arrive as strings; coerce numeric text to integer.
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/**
 * Normalizes GitNexus cypher output into a row array.
 *
 * GitNexus 1.6.12 returns cypher results as `{ markdown: "| col | ...", row_count: N }`
 * (a GitHub-flavored markdown table) — there is no structured JSON mode for cypher.
 * Older adapters returned `rows` / `results` arrays; we accept those for forward compat.
 */
function rowsOf(result) {
  if (result == null) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.results)) return result.results;
  if (typeof result.markdown === 'string') return parseMarkdownTable(result.markdown);
  return [];
}

/** Parses `| c1 | c2 |\n| --- | --- |\n| v1 | v2 |` into `[{c1:v1, c2:v2}, ...]`. */
function parseMarkdownTable(markdown) {
  const lines = markdown.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  // line[1] is the `| --- | --- |` separator — skip it.
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length !== headers.length) continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = cells[c];
    rows.push(row);
  }
  return rows;
}

function splitRow(line) {
  // Strip leading and trailing `|` then split on `|`; markdown tables we emit
  // never contain escaped pipes inside cells.
  return line.slice(1, -1).split('|').map((cell) => cell.trim());
}

async function readMetadata(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'metadata.json'), 'utf8')); } catch { throw new WorkerError('ENGINE_INDEX_INVALID', 'Graph artifact metadata is invalid', { status: 422 }); }
}
