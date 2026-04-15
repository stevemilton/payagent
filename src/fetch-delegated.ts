/**
 * payagent — Delegated fetch wrapper.
 *
 * Server-side signing variant: instead of holding the private key locally and
 * signing with ethers, call an ArisPay delegated-sign endpoint that signs via
 * the CDP-managed wallet AND enforces per-tx / daily / monthly limits +
 * allowedDomains. This is the path to use with agents created via
 * `DelegationClient.createX402Agent()`.
 *
 * Usage:
 *   const fetch402 = payFetchDelegated({
 *     arispayUrl: 'http://localhost:3001',
 *     apiKey: 'ap_test_...',          // the agent's own key
 *   });
 *   const res = await fetch402('https://api.example.com/premium');
 */
import { parseRequirements } from './payment.js';
import { InvalidRequirementsError, PaymentRejectedError } from './errors.js';

export interface PayFetchDelegatedConfig {
  /** Base URL for the ArisPay API (no trailing slash). */
  arispayUrl: string;
  /** The x402 agent's own API key (returned by DelegationClient.createX402Agent). */
  apiKey: string;
  /** Override for the ArisPay delegated-sign path. Default: /v1/x402/delegated-sign */
  signPath?: string;
  /** Request timeout for the sign call (ms). Default: 15000. */
  signTimeoutMs?: number;
}

export type PayFetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface DelegatedSignResponse {
  paymentHeader: string;
  chain: string;
  status: 'settled' | 'pending' | 'failed';
  walletAddress: string;
  spend: {
    amountCents: number;
    dailySpend: number;
    monthlySpend: number;
    limits: { maxPerTx: number; maxDaily: number; maxMonthly: number };
  };
}

/**
 * Create a fetch wrapper that delegates EIP-3009 signing to ArisPay.
 * No private key lives on the caller's machine; ArisPay enforces the
 * delegation limits before signing and increments spend counters on success.
 */
export function payFetchDelegated(config: PayFetchDelegatedConfig): PayFetchFn {
  if (!config.arispayUrl) throw new Error('arispayUrl is required');
  if (!config.apiKey) throw new Error('apiKey is required');
  const baseUrl = config.arispayUrl.replace(/\/$/, '');
  const signPath = config.signPath ?? '/v1/x402/delegated-sign';
  const timeoutMs = config.signTimeoutMs ?? 15_000;

  return async (url, init) => {
    const urlStr = url.toString();
    const response = await fetch(urlStr, init);
    if (response.status !== 402) return response;

    const { accepts, x402Version } = await parseRequirements(response);
    if (accepts.length === 0) {
      throw new InvalidRequirementsError('no payment options in 402 response');
    }
    // The delegated-sign endpoint only supports eip155 (EVM) variants.
    const accept = accepts.find((a) => a.network.startsWith('eip155:')) ?? accepts[0];
    if (!accept.network.startsWith('eip155:')) {
      throw new InvalidRequirementsError(`delegated-sign requires an eip155 variant, got ${accept.network}`);
    }

    // Derive ArisPay's `chain` label from CAIP-2.
    const chainId = Number.parseInt(accept.network.split(':')[1] ?? '', 10);
    const chainLabel = CHAIN_LABELS[chainId];
    if (!chainLabel) {
      throw new InvalidRequirementsError(`Unsupported chainId for delegated-sign: ${chainId}`);
    }

    // Ask ArisPay to sign.
    const signRes = await fetch(`${baseUrl}${signPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        paymentRequirements: {
          chain: chainLabel,
          tokenAddress: accept.asset,
          payeeAddress: accept.payTo,
          amount: accept.maxAmountRequired,
          extra: accept.extra,
        },
        resourceUrl: urlStr,
        x402Version,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!signRes.ok) {
      const body = (await signRes.json().catch(() => ({}))) as { error?: { message?: string } };
      const msg = body?.error?.message ?? `${signRes.status} ${signRes.statusText}`;
      throw new PaymentRejectedError(signRes.status, `ArisPay delegated-sign rejected: ${msg}`);
    }

    const signed = (await signRes.json()) as DelegatedSignResponse;
    if (signed.status === 'failed' || !signed.paymentHeader) {
      throw new PaymentRejectedError(502, 'ArisPay delegated-sign returned no header');
    }

    // Retry with the X-PAYMENT header.
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('X-PAYMENT', signed.paymentHeader);
    const paid = await fetch(urlStr, { ...init, headers: retryHeaders });
    if (paid.status === 402) {
      throw new PaymentRejectedError(402, 'Server returned 402 after payment was signed and sent');
    }
    return paid;
  };
}

// CAIP-2 chainId → ArisPay provider chain label.
const CHAIN_LABELS: Record<number, string> = {
  1: 'ethereum',
  137: 'polygon',
  8453: 'base',
  84532: 'base-sepolia',
};
