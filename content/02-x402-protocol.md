---
title: "How the x402 Protocol Works: HTTP 402 + USDC Stablecoins"
tags: [web3, protocol, api, payments]
published: false
---

# How the x402 Protocol Works: HTTP 402 + USDC Stablecoins

HTTP 402 — "Payment Required" — was defined in RFC 2616 in 1999 and reserved for future use. The [x402 protocol](https://github.com/coinbase/x402) gives it a concrete implementation: machine-readable payment negotiation over HTTP using USDC stablecoins.

This post explains the full protocol flow, the cryptographic primitives it uses, and why it matters for AI agents.

## The Flow

### 1. Client Requests a Resource

```
GET /api/premium-data HTTP/1.1
Host: api.example.com
```

### 2. Server Returns 402 with Payment Requirements

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "maxAmountRequired": "100000",
      "resource": "https://api.example.com/api/premium-data",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xMerchantWalletAddress",
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ]
}
```

Key fields:
- **`network`**: CAIP-2 chain identifier. `eip155:8453` = Base mainnet. `eip155:1` = Ethereum. `eip155:137` = Polygon.
- **`maxAmountRequired`**: USDC amount in base units (6 decimals). `100000` = $0.10.
- **`asset`**: The USDC contract address on that chain.
- **`payTo`**: The wallet that receives payment.
- **`extra`**: EIP-712 metadata for the USDC token (name + version).

### 3. Client Signs an EIP-3009 Transfer Authorization

Instead of sending an on-chain transaction, the client signs an off-chain authorization using [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) (`transferWithAuthorization`). This is a gasless signature that authorizes a third party to transfer USDC on the signer's behalf.

The signed message follows [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data format:

```
Domain:
  name: "USD Coin"
  version: "2"
  chainId: 8453
  verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

Type: TransferWithAuthorization
  from: address      (client wallet)
  to: address        (payTo from 402 response)
  value: uint256     (maxAmountRequired)
  validAfter: uint256  (unix timestamp - 60s)
  validBefore: uint256 (unix timestamp + 480s)
  nonce: bytes32     (random, for replay protection)
```

The client signs this with their private key using `eth_signTypedData_v4`.

### 4. Client Retries with X-PAYMENT Header

The signed payload is base64-encoded and sent as the `X-PAYMENT` header:

```
GET /api/premium-data HTTP/1.1
Host: api.example.com
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6ey...
```

The decoded `X-PAYMENT` header contains:

```json
{
  "x402Version": 2,
  "payload": {
    "signature": "0xabcd...1234",
    "authorization": {
      "from": "0xClientWallet",
      "to": "0xMerchantWallet",
      "value": "100000",
      "validAfter": "1748764800",
      "validBefore": "1748765280",
      "nonce": "0x7a8b9c..."
    }
  },
  "accepted": { ... },
  "resource": "https://api.example.com/api/premium-data"
}

```

### 5. Server Verifies and Settles

The server (or its facilitator) does three things:

1. **Verify the signature** — recover the signer address using `ecrecover` on the EIP-712 typed data hash. Confirm it matches `authorization.from`.

2. **Check validity window** — ensure `validAfter < now < validBefore`.

3. **Submit on-chain** — call `transferWithAuthorization()` on the USDC contract with the signature components (v, r, s). This transfers USDC from the client to the merchant.

The facilitator sponsors the gas for step 3. The client pays $0 gas — they only signed a message.

### 6. Server Returns the Response

```
HTTP/1.1 200 OK
Content-Type: application/json

{ "data": "premium content here" }
```

## Why EIP-3009?

Traditional ERC-20 transfers require two transactions: `approve()` then `transferFrom()`. Both cost gas.

EIP-3009 (`transferWithAuthorization`) collapses this into a single off-chain signature + one on-chain transaction. The signer never touches the chain — a third party (the facilitator) submits the authorization.

This is critical for AI agents because:
- Agents don't need ETH/gas tokens
- Agents don't need an RPC connection
- Agents just sign and send — the facilitator handles the rest
- Replay protection via random nonces (not sequential nonces that require state)

## Why USDC?

- **6 decimal places** — `100000` base units = $0.10. Clean micropayment amounts.
- **Stable** — pegged to USD. $0.10 today = $0.10 tomorrow.
- **EIP-3009 support** — USDC is one of the few tokens that implements `transferWithAuthorization`.
- **Multi-chain** — same interface on Base, Ethereum, Polygon, Arbitrum, etc.
- **Institutional trust** — issued by Circle, regulated, redeemable 1:1 for USD.

## Chain Selection

The 402 response tells the client which chain to pay on via the `network` field (CAIP-2 format):

| Chain | Network ID | USDC Address | Gas Cost |
|-------|-----------|--------------|----------|
| Base | `eip155:8453` | `0x8335...` | ~$0.001 |
| Ethereum | `eip155:1` | `0xA0b8...` | ~$0.50 |
| Polygon | `eip155:137` | `0x3c49...` | ~$0.01 |

Base is recommended for micropayments due to low gas costs. The facilitator pays this gas, not the agent.

## Facilitator Model

A facilitator is a service that:
1. Receives signed payment authorizations from the server
2. Submits them on-chain (paying gas)
3. Returns the settlement result (txHash)

The facilitator earns a fee (typically 1% with a $0.01 minimum) for sponsoring gas. This means:
- **Agents pay $0 gas** — only USDC for the API call
- **Merchants don't run blockchain infrastructure** — the facilitator handles settlement
- **Settlement is atomic** — if the on-chain transfer fails, the API returns an error

## Security Properties

- **Replay protection**: Random `bytes32` nonce per payment. Used nonces are tracked to prevent double-spending.
- **Time-bounded**: `validAfter` and `validBefore` create an 8-minute payment window. Expired signatures are rejected.
- **Amount-exact**: `value` is fixed at signing time. The merchant can't charge more than agreed.
- **Chain-specific**: The EIP-712 domain includes `chainId`, preventing cross-chain replay.
- **Non-custodial**: The agent holds its own private key. No intermediary holds funds.

## Implementation

For agents (payers), use [payagent](https://github.com/arispay-inc/payagent):

```typescript
import { payFetch } from 'payagent';

const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/data');
```

For API providers (payees), use [@agfac/middleware](https://github.com/arispay-inc/payagent):

```typescript
app.get('/api/data', agfac402({ price: 0.10 }), handler);
```

---

**References:**
- [x402 protocol (Coinbase)](https://github.com/coinbase/x402)
- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [EIP-712: Typed Structured Data Hashing and Signing](https://eips.ethereum.org/EIPS/eip-712)
- [CAIP-2: Blockchain ID Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
