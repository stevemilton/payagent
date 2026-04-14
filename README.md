# payagent

Let AI agents pay for APIs. Drop-in fetch wrapper that handles HTTP 402 payments with USDC stablecoins via the [x402 protocol](https://github.com/coinbase/x402).

payagent works in two modes. Pick the one that matches how your agent manages keys:

| Mode | Who holds the signing key | Use when |
|---|---|---|
| **Self-custody** (`payFetch`) | Your agent process, via a local private key | You already manage a wallet and want a zero-infrastructure x402 client |
| **Delegated** (`payFetchDelegated`) | No one in your process — [ArisPay](https://arispay.app) uses Coinbase CDP | You want spend limits enforced server-side and no keys on the agent host |

Both modes speak the same x402 protocol. Both can target the same APIs. The choice is about where the key lives.

---

## Quick start — self-custody

```ts
import { payFetch } from 'payagent';

const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/premium-data');
const data = await res.json();
```

If the API returns HTTP 402, payagent signs a USDC payment with your key and retries.

## Quick start — delegated (via ArisPay)

```ts
import { DelegationClient, payFetchDelegated } from 'payagent';

// One-time: provision an agent. ArisPay mints a CDP wallet and returns an agent API key.
const client = new DelegationClient('https://api.arispay.app', process.env.ARISPAY_KEY);
const agent = await client.createX402Agent({
  name: 'my-agent',
  maxPerTx: 100,      // cents — $1.00 per request
  maxDaily: 1000,     // $10/day
  maxMonthly: 10000,  // $100/month
  allowedDomains: ['api.example.com'],
});

console.log('Fund this wallet with USDC on Base Sepolia:', agent.walletAddress);
await client.pollUntilFunded(agent.agentId);

// Use the agent's API key to make paid requests.
const fetch402 = payFetchDelegated({
  arispayUrl: 'https://api.arispay.app',
  apiKey: agent.apiKey, // returned ONCE by createX402Agent — store it
});
const res = await fetch402('https://api.example.com/premium-data');
```

No private key ever touches your process. ArisPay enforces `maxPerTx` / `maxDaily` / `maxMonthly` / `allowedDomains` before asking CDP to sign.

## Install

```bash
npm install payagent
```

Requires Node.js >= 18.

---

## How x402 works

The [x402 protocol](https://github.com/coinbase/x402) uses HTTP status code 402 for machine-to-machine API payments:

1. **Server** returns `402 Payment Required` with payment requirements (chain, amount, recipient).
2. **Agent** signs an EIP-3009 `transferWithAuthorization` — a gasless USDC transfer authorization.
3. **Agent** retries the request with the signed payment in the `X-PAYMENT` header.
4. **Server** (or its facilitator) submits the authorization on-chain and returns the API response.

Key properties:
- **No gas fees for agents** — the server's facilitator sponsors gas.
- **USDC stablecoins** — amounts are in dollars, no price volatility.
- **EIP-712 typed signatures** — secure, replay-protected.
- **Works on any EVM chain** — Base, Ethereum, Polygon.

---

## Self-custody API

You hold the key. payagent signs locally. No third-party infrastructure.

### `payFetch(config)` — drop-in fetch replacement

```ts
const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/data');
```

### `PayAgent` class — with spending controls

For agents that need budget tracking on the client side.

```ts
import { PayAgent } from 'payagent';

const agent = new PayAgent({
  privateKey: process.env.AGENT_WALLET_KEY,
  maxPerRequest: 1.00,                   // Max $1.00 per request
  budget: 100.00,                        // $100 session budget
  allowedDomains: ['api.example.com'],
  allowedChains: ['eip155:8453'],        // Base mainnet only
});

const res = await agent.fetch('https://api.example.com/data');
console.log(agent.address, agent.spent, agent.remaining);
```

Limits are enforced in-process. Since you hold the key, nothing stops you from bypassing them — use delegated mode if you need server-enforced caps.

### `handlePaymentRequired(response, url, options)` — manual control

For custom integrations where you already have a 402 response in hand.

### Pre-flight verification

Before retrying, self-custody mode verifies the signed payment with an x402 facilitator (default: [AgFac](https://agfac-production.up.railway.app)) to catch bad signatures, insufficient balance, or nonce reuse early.

```ts
// Custom facilitator
payFetch({ privateKey, facilitatorUrl: 'https://my-facilitator.example.com' });
// Skip verification
payFetch({ privateKey, facilitatorUrl: false });
```

### Wallet setup (self-custody only)

1. Generate a wallet:
   ```ts
   import { ethers } from 'ethers';
   const wallet = ethers.Wallet.createRandom();
   ```
2. Fund it with USDC on your chosen chain (Base recommended for low fees; Base Sepolia for testing).
3. Export:
   ```bash
   export AGENT_WALLET_KEY=0x...
   ```

---

## Delegated API (ArisPay)

No private key lives on the agent host. ArisPay holds a Coinbase CDP-managed wallet, enforces spend limits and allowed domains server-side, and signs on the agent's behalf.

You'll need an [ArisPay](https://arispay.app) developer key to provision agents. Agents created this way get their own scoped API key.

### `DelegationClient` — provision and monitor agents

```ts
const client = new DelegationClient('https://api.arispay.app', process.env.ARISPAY_KEY);

const agent = await client.createX402Agent({
  name: 'hermes-prod',
  agentType: 'hermes',
  maxPerTx: 100,       // cents
  maxDaily: 1000,
  maxMonthly: 10000,
  allowedDomains: ['api.example.com'],
  network: 'base-sepolia',
});
// agent.agentId, agent.walletAddress, agent.apiKey (returned ONCE)

// Wait for the wallet to be funded with USDC.
await client.pollUntilFunded(agent.agentId);

// Or check manually:
const balance = await client.getBalance(agent.agentId);
// { walletAddress, usdcBalance, network, fundedAt }
```

Supported `network` values: `base-sepolia` (default), `base`, `ethereum`, `polygon`.

The `apiKey` returned by `createX402Agent` is the credential for this agent only — ArisPay stores only its SHA-256 hash and cannot recover it. Store it securely.

### `payFetchDelegated(config)` — drop-in fetch, server-signed

```ts
const fetch402 = payFetchDelegated({
  arispayUrl: 'https://api.arispay.app',
  apiKey: agent.apiKey,
});
const res = await fetch402('https://api.example.com/data');
```

When the server returns 402, payagent asks ArisPay to sign via CDP. ArisPay checks `maxPerTx` / `maxDaily` / `maxMonthly` / `allowedDomains` before signing; failures surface as `PaymentRejectedError`.

### `getUSDCBalance(address, chain?, rpcUrl?)` — direct on-chain read

Utility that reads USDC balance directly from any EVM RPC — works in either mode for sanity-checking wallet state.

---

## Supported chains

| Chain | Network ID | Notes |
|-------|-----------|-------|
| Base | `eip155:8453` | Recommended — lowest fees |
| Base Sepolia | `eip155:84532` | Testnet |
| Ethereum | `eip155:1` | Mainnet |
| Polygon | `eip155:137` | Mainnet |

Your wallet must hold USDC on the chain the API requires.

---

## Errors

```ts
import {
  BudgetExceededError,      // Payment would exceed maxPerRequest or budget (self-custody)
  UnsupportedChainError,    // API requires a chain not in allowedChains
  DomainNotAllowedError,    // URL domain not in allowedDomains
  PaymentRejectedError,     // Server returned 402 even after payment; or ArisPay denied signing
  InvalidRequirementsError, // Could not parse the 402 response
  PayAgentError,            // Base class
} from 'payagent';
```

---

## Framework integrations

The Vercel AI SDK and LangChain helpers use self-custody mode. For delegated mode inside those frameworks, wrap `payFetchDelegated` yourself.

### Vercel AI SDK

```ts
import { createPayAgentTool } from 'payagent/vercel';
import { generateText } from 'ai';

const payTool = createPayAgentTool({
  privateKey: process.env.AGENT_WALLET_KEY,
  budget: 10.00,
});

const { text } = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: { pay_api: payTool },
  prompt: 'Get the premium forecast from https://weather-api.example.com/forecast',
});
```

Requires peer dependencies: `ai`, `zod`.

### LangChain

```ts
import { createPayAgentTool } from 'payagent/langchain';

const payTool = createPayAgentTool({
  privateKey: process.env.AGENT_WALLET_KEY,
  budget: 10.00,
});
```

Requires peer dependency: `@langchain/core`.

### MCP server

Use [payagent-mcp](https://github.com/stevemilton/payagent-mcp) to add payment capabilities to Claude Desktop, Cursor, or any MCP client.

---

## License

MIT
