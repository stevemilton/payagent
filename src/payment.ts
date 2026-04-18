/**
 * payagent — x402 402-response parsing utilities.
 *
 * These are the shared primitives used by `payFetchDelegated` to normalize
 * a seller's 402 body into a usable `accepts` list, independent of whether
 * it's emitted in x402-v2 standard shape or the legacy flat/AgFac shape.
 */
import type {
  X402Accept,
  PaymentRequirementsBody,
  AgfacFlatRequirements,
  X402Requirements,
} from './types.js';
import { InvalidRequirementsError } from './errors.js';

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

const NETWORK_CAIP2_TO_SHORT: Record<string, string> = Object.fromEntries(
  Object.entries(NETWORK_SHORT_TO_CAIP2).map(([s, c]) => [c, s]),
);

/** Convert CAIP-2 back to the short network name x402 sellers emit on the wire. */
export function denormalizeNetwork(network: string): string {
  if (!network.includes(':')) return network; // already short
  return NETWORK_CAIP2_TO_SHORT[network] ?? network;
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
    return body.accepts.map((a) => ({
      ...a,
      network: normalizeNetwork(a.network),
      // Some servers (e.g. ArcticX) use `amount` instead of `maxAmountRequired`
      maxAmountRequired: a.maxAmountRequired ?? (a as any).amount,
    }));
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

export interface ParsedRequirements {
  accepts: X402Accept[];
  /** x402 protocol version advertised by the seller. Defaults to 1. */
  x402Version: number;
}

/** Parse the 402 response body and extract payment requirements. */
export async function parseRequirements(response: Response): Promise<ParsedRequirements> {
  // x402 v2: some servers put requirements in the `payment-required` header (base64 JSON)
  const paymentReqHeader = response.headers.get('payment-required');
  if (paymentReqHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentReqHeader, 'base64').toString()) as Record<string, unknown>;
      const body = (decoded.requirements ?? decoded) as PaymentRequirementsBody;
      const accepts = extractAccepts(body);
      if (accepts.length > 0) {
        return {
          accepts,
          x402Version: typeof decoded.x402Version === 'number' ? decoded.x402Version : 2,
        };
      }
    } catch {
      // fall through to body parsing
    }
  }

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
  // newer draft. Echo whichever version the seller advertised.
  const version = typeof (body as { x402Version?: unknown }).x402Version === 'number'
    ? (body as { x402Version: number }).x402Version
    : 1;

  return {
    accepts: extractAccepts(body),
    x402Version: version,
  };
}
