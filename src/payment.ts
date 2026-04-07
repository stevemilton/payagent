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

function isStandardFormat(body: PaymentRequirementsBody): body is X402Requirements {
  return 'accepts' in body && Array.isArray(body.accepts);
}

function isFlatFormat(body: PaymentRequirementsBody): body is AgfacFlatRequirements {
  return 'scheme' in body && 'payTo' in body && !('accepts' in body);
}

/** Normalize both x402 v2 standard and AgFac flat format into accepts array. */
function extractAccepts(body: PaymentRequirementsBody): X402Accept[] {
  if (isStandardFormat(body)) {
    return body.accepts;
  }
  if (isFlatFormat(body)) {
    return [{
      scheme: body.scheme,
      network: body.network,
      maxAmountRequired: body.maxAmountRequired,
      resource: body.resource,
      asset: body.asset,
      payTo: body.payTo,
      extra: { name: 'USDC', version: '2' },
    }];
  }
  throw new InvalidRequirementsError('unrecognized format');
}

/** Parse the 402 response body (may also check X-Payment-Requirements header). */
export async function parseRequirements(response: Response): Promise<X402Accept[]> {
  // Try response body first
  let body: PaymentRequirementsBody;
  try {
    const json = await response.json();
    // Some servers nest requirements under a `requirements` key
    body = json.requirements ?? json;
  } catch {
    throw new InvalidRequirementsError('response body is not valid JSON');
  }

  if (!body || typeof body !== 'object' || body.x402Version !== 2) {
    throw new InvalidRequirementsError('missing x402Version: 2');
  }

  return extractAccepts(body);
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

async function signPayment(accept: X402Accept, wallet: ethers.Wallet): Promise<SignedPayment> {
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
    x402Version: 2,
    payload: { signature, authorization },
    accepted: accept,
    resource: accept.resource,
  };

  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  return { header, accept };
}

// ── Full 402 handling flow ──────────────────────────

export interface HandlePaymentOptions {
  /** Ethereum private key (hex). */
  privateKey: string;
  /** Spending tracker (optional — used internally by PayAgent). */
  tracker?: SpendTracker;
  /** Additional headers to include on the retry request. */
  headers?: Record<string, string>;
  /** Original request init (method, body, etc). */
  requestInit?: RequestInit;
}

/**
 * Handle a 402 Payment Required response:
 * 1. Parse payment requirements
 * 2. Select a supported payment option
 * 3. Check spending limits
 * 4. Sign EIP-3009 transferWithAuthorization
 * 5. Retry the original request with X-PAYMENT header
 */
export async function handlePaymentRequired(
  response: Response,
  url: string,
  options: HandlePaymentOptions,
): Promise<Response> {
  const accepts = await parseRequirements(response);

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
  const { header } = await signPayment(accept, wallet);

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
