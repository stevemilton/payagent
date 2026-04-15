/**
 * payagent — Core 402 payment flow.
 *
 * Handles: parse 402 response → resolve EIP-712 domain → sign → encode → retry.
 */
import { ethers } from 'ethers';
import type {
  X402Accept,
  PaymentRequirementsBody,
  AgfacFlatRequirements,
  X402Requirements,
  PaymentReceipt,
} from './types.js';
import { AGFAC_FACILITATOR_URL } from './types.js';
import { SpendTracker } from './limits.js';
import {
  InvalidRequirementsError,
  UnsupportedChainError,
  PaymentRejectedError,
} from './errors.js';
import { baseUnitsToUSDC, formatUSDC } from './limits.js';

// ── EIP-712 + EIP-3009 constants (inlined to avoid x402-core dep for v1) ──

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// ── Parse 402 response ──────────────────────────────

// Coinbase's reference x402 middleware emits short network names
// ("base-sepolia"), while the x402 v2 spec and our internal code use CAIP-2
// ("eip155:84532"). Accept either on the way in.
const NETWORK_SHORT_TO_CAIP2: Record<string, string> = {
  ethereum: 'eip155:1',
  polygon: 'eip155:137',
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

export function normalizeNetwork(network: string): string {
  if (network.includes(':')) return network; // already CAIP-2
  return NETWORK_SHORT_TO_CAIP2[network] ?? network;
}

function isStandardFormat(body: PaymentRequirementsBody): body is X402Requirements {
  return 'accepts' in body && Array.isArray(body.accepts);
}

function isFlatFormat(body: PaymentRequirementsBody): body is AgfacFlatRequirements {
  return 'scheme' in body && 'payTo' in body && !('accepts' in body);
}

/** Normalize both x402 v2 standard and AgFac flat format into accepts array. */
function extractAccepts(body: PaymentRequirementsBody): X402Accept[] {
  if (isStandardFormat(body)) {
    return body.accepts.map((a) => ({ ...a, network: normalizeNetwork(a.network) }));
  }
  if (isFlatFormat(body)) {
    return [{
      scheme: body.scheme,
      network: normalizeNetwork(body.network),
      maxAmountRequired: body.maxAmountRequired,
      resource: body.resource,
      asset: body.asset,
      payTo: body.payTo,
      extra: { name: 'USDC', version: '2' },
    }];
  }
  throw new InvalidRequirementsError('unrecognized format');
}

interface ParsedRequirements {
  accepts: X402Accept[];
  /** Facilitator URL from the 402 response body (if provided by the server). */
  facilitatorUrl?: string;
  /** x402 protocol version advertised by the seller. Defaults to 1. */
  x402Version: number;
}

/** Parse the 402 response body and extract payment requirements + facilitator URL. */
export async function parseRequirements(response: Response): Promise<ParsedRequirements> {
  let json: Record<string, unknown>;
  try {
    json = await response.json();
  } catch {
    throw new InvalidRequirementsError('response body is not valid JSON');
  }

  // Some servers nest requirements under a `requirements` key
  const body = (json.requirements ?? json) as PaymentRequirementsBody;

  if (!body || typeof body !== 'object') {
    throw new InvalidRequirementsError('invalid 402 response body');
  }
  // x402Version 1 is what the Coinbase reference middleware emits; v2 is the
  // newer draft. Accept both — we echo whichever version the seller advertised
  // in the signed payload so their facilitator doesn't reject the mismatch.
  const version = typeof (body as { x402Version?: unknown }).x402Version === 'number'
    ? (body as { x402Version: number }).x402Version
    : 1;

  return {
    accepts: extractAccepts(body),
    facilitatorUrl: typeof json.facilitator === 'string' ? json.facilitator : undefined,
    x402Version: version,
  };
}

// ── Resolve EIP-712 domain from 402 response ────────

/** Parse CAIP-2 network ID to integer chainId. e.g. "eip155:84532" → 84532 */
function chainIdFromNetwork(network: string): number {
  const parts = network.split(':');
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new UnsupportedChainError(network);
  }
  const id = parseInt(parts[1], 10);
  if (isNaN(id)) throw new UnsupportedChainError(network);
  return id;
}

/**
 * Build the EIP-712 domain directly from the 402 response.
 * USDC uses name="USD Coin", version="2" on all chains.
 * chainId and verifyingContract come from the accept option.
 */
function buildEIP712Domain(accept: X402Accept) {
  return {
    name: accept.extra?.name === 'USDC' ? 'USD Coin' : (accept.extra?.name ?? 'USD Coin'),
    version: accept.extra?.version ?? '2',
    chainId: chainIdFromNetwork(accept.network),
    verifyingContract: accept.asset,
  };
}

// ── Sign payment ────────────────────────────────────

interface SignedPayment {
  header: string;
  accept: X402Accept;
}

async function signPayment(accept: X402Accept, wallet: ethers.Wallet, x402Version = 1): Promise<SignedPayment> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 480; // 8-minute window
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const authorization = {
    from: wallet.address,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const domain = buildEIP712Domain(accept);
  const domainForSigning = {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: ethers.getAddress(domain.verifyingContract),
  };

  const signature = await wallet.signTypedData(
    domainForSigning,
    { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization] },
    {
      from: ethers.getAddress(authorization.from),
      to: ethers.getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  );

  const payload = {
    x402Version,
    payload: { signature, authorization },
    accepted: accept,
    resource: accept.resource,
  };

  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  return { header, accept };
}

// ── Facilitator pre-flight verification ─────────────

/**
 * Resolve the facilitator URL to use:
 * 1. If the 402 response included a `facilitator` field, prefer that
 * 2. Otherwise, use the configured facilitatorUrl
 * 3. Fall back to AgFac production
 */
function resolveFacilitatorUrl(
  responseUrl: string | undefined,
  configUrl: string | false | undefined,
): string | null {
  if (configUrl === false) return null; // explicitly disabled
  if (responseUrl) return responseUrl;
  if (configUrl) return configUrl;
  return AGFAC_FACILITATOR_URL;
}

/**
 * Call the facilitator's /verify endpoint to pre-check a signed payment.
 * Catches issues (insufficient balance, bad signature, nonce reuse) before
 * the agent retries the original request.
 */
async function verifyWithFacilitator(
  facilitatorUrl: string,
  paymentHeader: string,
  accept: X402Accept,
): Promise<void> {
  try {
    const payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    const res = await fetch(`${facilitatorUrl}/facilitator/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: accept,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const reason = (body.error ?? body.errorReason ?? 'verification failed') as string;
      throw new PaymentRejectedError(res.status, `Facilitator verification failed: ${reason}`);
    }

    const result = await res.json() as { valid: boolean; error?: string };
    if (!result.valid) {
      throw new PaymentRejectedError(402, `Payment invalid: ${result.error ?? 'unknown reason'}`);
    }
  } catch (err) {
    // If the facilitator is unreachable, proceed anyway — the server will settle
    if (err instanceof PaymentRejectedError) throw err;
    // Network errors are non-fatal: skip verification, let the server handle it
  }
}

// ── Full 402 handling flow ──────────────────────────

export interface HandlePaymentOptions {
  /** Ethereum private key (hex). */
  privateKey: string;
  /**
   * Facilitator URL for pre-flight verification.
   * Default: AgFac (https://agfac-production.up.railway.app).
   * Set to `false` to skip verification.
   */
  facilitatorUrl?: string | false;
  /** Spending tracker (optional — used internally by PayAgent). */
  tracker?: SpendTracker;
  /** Additional headers to include on the retry request. */
  headers?: Record<string, string>;
  /** Original request init (method, body, etc). */
  requestInit?: RequestInit;
}

/**
 * Handle a 402 Payment Required response:
 * 1. Parse payment requirements (+ extract facilitator URL from response)
 * 2. Select a supported payment option
 * 3. Check spending limits
 * 4. Sign EIP-3009 transferWithAuthorization
 * 5. Pre-verify with facilitator (catches bad signatures / insufficient balance)
 * 6. Retry the original request with X-PAYMENT header
 */
export async function handlePaymentRequired(
  response: Response,
  url: string,
  options: HandlePaymentOptions,
): Promise<Response> {
  const { accepts, facilitatorUrl: responseFacilitator, x402Version } = await parseRequirements(response);

  if (accepts.length === 0) {
    throw new InvalidRequirementsError('no payment options in 402 response');
  }

  // Filter to allowed chains if tracker has chain restrictions
  const eligible = options.tracker
    ? accepts.filter((a) => options.tracker!.isChainAllowed(a.network))
    : accepts;

  if (eligible.length === 0) {
    throw new UnsupportedChainError(accepts.map((a) => a.network).join(', '));
  }

  const accept = eligible[0];

  // Check spending limits
  if (options.tracker) {
    options.tracker.checkPayment(accept.maxAmountRequired, url, accept.network);
  }

  // Sign
  const wallet = new ethers.Wallet(options.privateKey);
  const { header } = await signPayment(accept, wallet, x402Version);

  // Pre-verify with facilitator (non-blocking on network errors)
  const facilitator = resolveFacilitatorUrl(responseFacilitator, options.facilitatorUrl);
  if (facilitator) {
    await verifyWithFacilitator(facilitator, header, accept);
  }

  // Retry with payment header
  const retryHeaders = new Headers(options.requestInit?.headers);
  retryHeaders.set('X-PAYMENT', header);
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      retryHeaders.set(k, v);
    }
  }

  const retryInit: RequestInit = {
    ...options.requestInit,
    headers: retryHeaders,
  };

  const paidResponse = await fetch(url, retryInit);

  // Record the payment if we have a tracker
  if (options.tracker && paidResponse.ok) {
    const receipt: PaymentReceipt = {
      url,
      amount: formatUSDC(baseUnitsToUSDC(accept.maxAmountRequired)),
      amountBaseUnits: accept.maxAmountRequired,
      network: accept.network,
      payTo: accept.payTo,
      timestamp: new Date().toISOString(),
    };
    options.tracker.recordPayment(receipt);
  }

  // If server still returns 402 after payment, something went wrong
  if (paidResponse.status === 402) {
    throw new PaymentRejectedError(402, 'Server returned 402 after payment was signed and sent');
  }

  return paidResponse;
}
