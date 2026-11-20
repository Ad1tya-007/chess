/**
 * Base class for expected application errors. `message` must be safe to show to MCP clients:
 * no stack traces, SQL, credentials, or raw upstream response bodies.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type ChessComErrorKind =
  | 'invalid_input'
  | 'not_found'
  | 'gone'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'upstream_error'
  | 'invalid_response';

const RETRYABLE_KINDS: ReadonlySet<ChessComErrorKind> = new Set([
  'rate_limited',
  'timeout',
  'network',
  'upstream_error',
]);

export interface ChessComErrorDetails {
  /** PubAPI path, e.g. /pub/player/erik/stats. Public information, safe to log. */
  path?: string;
  status?: number;
  retryAfterSeconds?: number;
  attempts?: number;
  /** False for upstream errors that retrying cannot fix (e.g. an unexpected 4xx). */
  retryable?: boolean;
}

export class ChessComApiError extends AppError {
  readonly details: ChessComErrorDetails;

  constructor(
    readonly kind: ChessComErrorKind,
    message: string,
    details: ChessComErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(`chesscom_${kind}`, message, options);
    this.details = details;
  }

  get retryable(): boolean {
    return this.details.retryable ?? RETRYABLE_KINDS.has(this.kind);
  }

  withDetails(details: ChessComErrorDetails): ChessComApiError {
    return new ChessComApiError(
      this.kind,
      this.message,
      { ...this.details, ...details },
      { cause: this.cause },
    );
  }
}
