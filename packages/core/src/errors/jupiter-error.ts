import type { ErrorCategory } from '@jupiter/contracts';

export type JupiterErrorOptions = {
  code: string;
  category: ErrorCategory;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  userAction: string;
  sanitizedDetails?: string;
};

export class JupiterError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly userAction: string;
  readonly sanitizedDetails: string | undefined;

  constructor(options: JupiterErrorOptions) {
    super(options.message);
    this.name = 'JupiterError';
    this.code = options.code;
    this.category = options.category;
    this.recoverable = options.recoverable;
    this.retryable = options.retryable;
    this.userAction = options.userAction;
    this.sanitizedDetails = options.sanitizedDetails;
  }
}
