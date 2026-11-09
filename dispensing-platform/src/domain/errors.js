export class DomainError extends Error {
  constructor(message, { status = 400, code = 'DOMAIN_ERROR', details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what, id) =>
  new DomainError(`${what} ${id ?? ''} not found`.trim(), { status: 404, code: 'NOT_FOUND' });

export const forbidden = (message) => new DomainError(message, { status: 403, code: 'FORBIDDEN' });

export const conflict = (message, details) =>
  new DomainError(message, { status: 409, code: 'CONFLICT', details });
