/**
 * payagent — Error classes.
 */

/** Base class for all payagent errors. */
export class PayAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayAgentError';
  }
}

/** Payment would exceed the configured per-request or total budget. */
export class BudgetExceededError extends PayAgentError {
  public readonly requested: string;
  public readonly limit: string;
  public readonly type: 'per-request' | 'total';

  constructor(requested: string, limit: string, type: 'per-request' | 'total') {
    super(
      type === 'per-request'
        ? `Request costs $${requested} USDC but max per-request is $${limit}`
        : `Request costs $${requested} USDC but only $${limit} budget remaining`,
    );
    this.name = 'BudgetExceededError';
    this.requested = requested;
    this.limit = limit;
    this.type = type;
  }
}

/** The 402 response requires a chain payagent doesn't support or isn't allowed. */
export class UnsupportedChainError extends PayAgentError {
  public readonly network: string;

  constructor(network: string) {
    super(`No supported payment option found. Server requires network: ${network}`);
    this.name = 'UnsupportedChainError';
    this.network = network;
  }
}

/** The domain is not in the allowedDomains list. */
export class DomainNotAllowedError extends PayAgentError {
  public readonly domain: string;

  constructor(domain: string) {
    super(`Domain "${domain}" is not in the allowed domains list`);
    this.name = 'DomainNotAllowedError';
    this.domain = domain;
  }
}

/** The payment was signed and sent but the server still rejected it. */
export class PaymentRejectedError extends PayAgentError {
  public readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Server rejected payment (HTTP ${status})`);
    this.name = 'PaymentRejectedError';
    this.status = status;
  }
}

/** Could not parse 402 response body as valid payment requirements. */
export class InvalidRequirementsError extends PayAgentError {
  constructor(detail?: string) {
    super(`Could not parse 402 payment requirements${detail ? ': ' + detail : ''}`);
    this.name = 'InvalidRequirementsError';
  }
}
