/**
 * payagent — Drop-in fetch wrapper.
 *
 * Usage:
 *   const fetch402 = payFetch({ privateKey: '0x...' });
 *   const res = await fetch402('https://api.example.com/data');
 */
import type { PayAgentConfig } from './types.js';
import { SpendTracker } from './limits.js';
import { handlePaymentRequired } from './payment.js';

/** A fetch-compatible function that handles 402 payments automatically. */
export type PayFetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Create a fetch wrapper that automatically handles HTTP 402 responses
 * by signing USDC payments via the x402 protocol.
 *
 * @example
 * ```ts
 * import { payFetch } from 'payagent';
 *
 * const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
 * const res = await fetch402('https://api.example.com/premium-data');
 * const data = await res.json();
 * ```
 */
export function payFetch(config: PayAgentConfig): PayFetchFn {
  const tracker = new SpendTracker(config);

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    const response = await fetch(urlStr, init);

    if (response.status !== 402) {
      return response;
    }

    return handlePaymentRequired(response, urlStr, {
      privateKey: config.privateKey,
      facilitatorUrl: config.facilitatorUrl,
      tracker,
      requestInit: init,
    });
  };
}
