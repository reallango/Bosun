/** A self-update or rollback that cannot start, with the HTTP status and machine-readable code the API returns. */
export class UpdateError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'UPDATE_NOT_READY') { super(message); }
}
