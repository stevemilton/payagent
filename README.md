# payagent

Let AI agents pay for APIs. The ArisPay SDK for [x402](https://github.com/coinbase/x402) USDC payments — no private keys ever live in your process.

payagent provisions a delegated-custody agent wallet through [ArisPay](https://arispay.app): Coinbase CDP holds the signing key, ArisPay enforces per-transaction, daily, monthly, and allowed-domain limits server-side, and signs on your agent's behalf when it hits an HTTP 402.

## Install

```bash
npm install payagent
```

Requires Node.js >= 18. You'll also need an [ArisPay](https://arispay.app) developer key from [payagent.arispay.app](https://payagent.arispay.app).

## Quick start

```ts
import { DelegationClient, payFetchDelegated } from 'payagent';

// 1. Provision an agent. ArisPay mints a CDP-managed wallet and returns
//    an agent-scoped API key (returned exactly once — store it).
const client = new DelegationClient('https://api.arispay.app', process.env.ARISPAY_KEY);
const agent = await client.createX402Agent({
  name: 'my-agent',
  maxPerTx: 100,      // cents — $1.00 cap per request
  maxDaily: 1000,     // $10 / day
  maxMonthly: 10000,  // $100 / month
  allowedDomains: ['api.example.com'],
});

// 2. Fund the wallet with USDC on Base, then wait for it to latch.
console.log('Fund this wallet with USDC on Base:', agent.walletAddress);
await client.pollUntilFunded(agent.agentId);

// 3. Make paid requests. HTTP 402s are handled transparently — ArisPay
//    checks the request against your delegation limits, signs via CDP,
//    and payagent retries with the X-PAYMENT header attached.
const fetch402 = payFetchDelegated({
  arispayUrl: 'https://api.arispay.app',
  apiKey: agent.apiKey,
});
const res = await fetch402('https://api.example.com/premium');
const data = await res.json();
```

## How x402 works

The [x402 protocol](https://github.com/coinbase/x402) uses HTTP status code 402 for machine-to-machine API payments:

1. **Server** returns `402 Payment Required` with payment requirements (chain, amount, recipient).
2. **payagent** asks ArisPay to sign an EIP-3009 `transferWithAuthorization` — a gasless USDC transfer authorization.
3. **ArisPay** validates the request against your delegation limits (`maxPerTx`, `maxDaily`, `maxMonthly`, `allowedDomains`), then signs via the CDP-managed wallet.
4. **payagent** retries the request with the signed payment in the `X-PAYMENT` header.
5. **Server's facilitator** submits the authorization on-chain and returns the API response.

Key properties:
- **No private keys in your agent** — the signing key lives in Coinbase CDP, never in your process.
- **Server-enforced limits** — ArisPay rejects requests that breach your delegation before signing.
- **No gas fees for agents** — the seller's facilitator sponsors gas.
- **USDC stablecoins** — amounts are in dollars, no price volatility.

## API

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
  network: 'base',     // default
});
// agent.agentId, agent.walletAddress, agent.apiKey (returned ONCE)

// Wait for the wallet to be funded with USDC.
await client.pollUntilFunded(agent.agentId);

// Or check manually:
const balance = await client.getBalance(agent.agentId);
// { walletAddress, usdcBalance, network, fundedAt }
```

Supported `network` values: `base` (default, mainnet), `base-sepolia`, `ethereum`, `polygon`.

The `apiKey` returned by `createX402Agent` is the credential for this agent only — ArisPay stores only its SHA-256 hash and cannot recover it. Store it securely.

### `payFetchDelegated(config)` — drop-in fetch

```ts
const fetch402 = payFetchDelegated({
  arispayUrl: 'https://api.arispay.app',
  apiKey: agent.apiKey,
});
const res = await fetch402('https://api.example.com/data');
```

Works like native `fetch`. On 402, payagent asks ArisPay to sign via CDP, then retries. If ArisPay rejects (limit breach, disallowed domain, etc.), throws `PaymentRejectedError`.

### `getUSDCBalance(address, chain?, rpcUrl?)` — direct on-chain read

```ts
import { getUSDCBalance, formatUSDC } from 'payagent';

const raw = await getUSDCBalance(agent.walletAddress);           // default chain: 'base'
const raw2 = await getUSDCBalance(agent.walletAddress, 'base');
console.log(formatUSDC(raw), 'USDC');
```

Utility that reads USDC balance directly from any EVM RPC — handy for sanity-checking wallet state independent of ArisPay's balance endpoint.

## Supported chains

| Chain | Network ID | Notes |
|-------|-----------|-------|
| Base | `eip155:8453` | **Default** — mainnet, lowest fees |
| Base Sepolia | `eip155:84532` | Testnet |
| Ethereum | `eip155:1` | Mainnet |
| Polygon | `eip155:137` | Mainnet |

## Errors

```ts
import {
  PaymentRejectedError,     // ArisPay denied signing, or server returned 402 after payment
  InvalidRequirementsError, // Could not parse the 402 response
  PayAgentError,            // Base class
} from 'payagent';
```

## Framework integrations

### Vercel AI SDK

```ts
import { createPayAgentTool } from 'payagent/vercel';
import { generateText } from 'ai';

const payTool = createPayAgentTool({
  arispayUrl: 'https://api.arispay.app',
  apiKey: process.env.ARISPAY_AGENT_KEY,
});

const { text } = await generateText({
  model: yourModel,
  tools: { pay_api: payTool },
  prompt: 'Get the premium forecast from https://weather-api.example.com/forecast',
});
```

Requires peer dependencies: `ai`, `zod`.

### LangChain

```ts
import { createPayAgentTool } from 'payagent/langchain';

const payTool = createPayAgentTool({
  arispayUrl: 'https://api.arispay.app',
  apiKey: process.env.ARISPAY_AGENT_KEY,
});
```

Requires peer dependency: `@langchain/core`.

### MCP server

Use [`@arispay/payagent-mcp`](https://www.npmjs.com/package/@arispay/payagent-mcp) to add payment capabilities to Claude Desktop, Cursor, or any MCP client.

## Migrating from 1.x

v2 removes the self-custody path (`payFetch`, `PayAgent`, raw private-key signing). ArisPay's product is delegated-custody only — keys live in Coinbase CDP with server-enforced limits.

Migration:
- Replace `payFetch({ privateKey })` with `payFetchDelegated({ arispayUrl, apiKey })`.
- Replace `new PayAgent({ privateKey, budget, maxPerRequest })` with `DelegationClient.createX402Agent({ maxPerTx, maxDaily, maxMonthly, ... })` to provision, then `payFetchDelegated` to transact.
- `BudgetExceededError`, `UnsupportedChainError`, and `DomainNotAllowedError` are gone — their equivalents are now server-side rejections surfaced as `PaymentRejectedError`.

## License

MIT
