export class WorkerError extends Error {
  constructor(code, message, { status = 500, retryable = false, details = {} } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function errorBody(error) {
  const normalized = error instanceof WorkerError
    ? error
    : new WorkerError('INTERNAL_ERROR', 'Internal worker error');
  return {
    schemaVersion: 1,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: sanitizeDetails(normalized.details),
    },
  };
}

function sanitizeDetails(value, key = '') {
  if (value == null) return value;
  if (key.toLowerCase().includes('path') || key.toLowerCase().includes('artifacturi')) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replaceAll(/file:\/\/[^\s"']+/g, '[redacted-artifact]')
      .replaceAll(/(?:^|[\s(])\/(?:[^\s"')]+\/)+[^\s"')]+/g, '$1[redacted-path]');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDetails(item, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeDetails(childValue, childKey)]));
  return value;
}
