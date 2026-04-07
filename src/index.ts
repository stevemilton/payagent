/**
 * payagent — Let AI agents pay for APIs.
 *
 * Drop-in fetch wrapper that handles HTTP 402 payments
 * with USDC stablecoins via the x402 protocol.
 *
 * @example
 * ```ts
 * // Simplest usage — drop-in fetch replacement
 * import { payFetch } from 'payagent';
 *
 * const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
 * const res = await fetch402('https://api.example.com/premium-data');
 *
 * // With spending controls
 * import { PayAgent } from 'payagent';
 *
 * const agent = new PayAgent({
 *   privateKey: process.env.AGENT_WALLET_KEY,
 *   budget: 10.00,
 *   maxPerRequest: 1.00,
 * });
 * const res = await agent.fetch('https://api.example.com/data');
 * ```
 */

// Primary API
export { payFetch } from './fetch.js';
export type { PayFetchFn } from './fetch.js';
export { PayAgent } from './agent.js';
export { handlePaymentRequired } from './payment.js';
export type { HandlePaymentOptions } from './payment.js';

// Constants
export { AGFAC_FACILITATOR_URL } from './types.js';

// Types
export type {
  PayAgentConfig,
  PaymentReceipt,
  X402Requirements,
  X402Accept,
  AgfacFlatRequirements,
  PaymentRequirementsBody,
} from './types.js';

// Errors
export {
  PayAgentError,
  BudgetExceededError,
  UnsupportedChainError,
  DomainNotAllowedError,
  PaymentRejectedError,
  InvalidRequirementsError,
} from './errors.js';
