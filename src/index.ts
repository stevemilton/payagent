/**
 * payagent — Let AI agents pay for APIs.
 *
 * Drop-in fetch wrapper that handles HTTP 402 payments with USDC stablecoins
 * via the x402 protocol, using ArisPay's delegated-custody model. No private
 * key ever lives in your process — ArisPay holds a Coinbase CDP-managed
 * wallet and enforces spend limits server-side.
 *
 * @example
 * ```ts
 * import { DelegationClient, payFetchDelegated } from 'payagent';
 *
 * // 1. Provision an agent once. ArisPay mints a CDP wallet and returns an
 * //    agent-scoped API key (returned exactly once).
 * const client = new DelegationClient('https://api.arispay.app', process.env.ARISPAY_KEY);
 * const agent = await client.createX402Agent({
 *   name: 'my-agent',
 *   maxPerTx: 100,      // cents — $1.00 cap per request
 *   maxDaily: 1000,     // $10 / day
 *   maxMonthly: 10000,  // $100 / month
 *   allowedDomains: ['api.example.com'],
 * });
 *
 * // 2. Fund the wallet address with USDC on Base, then wait for it to latch.
 * await client.pollUntilFunded(agent.agentId);
 *
 * // 3. Make paid requests. 402s are handled transparently.
 * const fetch402 = payFetchDelegated({
 *   arispayUrl: 'https://api.arispay.app',
 *   apiKey: agent.apiKey,
 * });
 * const res = await fetch402('https://api.example.com/premium');
 * ```
 */

// Primary API — delegated signing via ArisPay
export { payFetchDelegated } from './fetch-delegated.js';
export type { PayFetchDelegatedConfig, PayFetchFn } from './fetch-delegated.js';
export { DelegationClient } from './delegation.js';
export type {
  X402AgentConfig,
  CreateX402AgentResponse,
  BalanceResponse,
} from './delegation.js';

// On-chain balance helper
export { getUSDCBalance, formatUSDC, USDC_CONTRACTS } from './balance.js';

// Types
export type {
  PaymentReceipt,
  X402Requirements,
  X402Accept,
  AgfacFlatRequirements,
  PaymentRequirementsBody,
} from './types.js';

// Errors
export {
  PayAgentError,
  PaymentRejectedError,
  InvalidRequirementsError,
} from './errors.js';
