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
      details: normalized.details,
    },
  };
}
