# payagent

Let AI agents pay for APIs. Drop-in fetch wrapper that handles HTTP 402 payments with USDC stablecoins via the x402 protocol.

```ts
import { payFetch } from 'payagent';

const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/premium-data');
const data = await res.json();
```

That's it. If the API returns HTTP 402, payagent automatically signs a USDC payment and retries.

## How It Works

1. Your agent calls `fetch402(url)` — a normal HTTP request
2. If the server returns **HTTP 402 Payment Required** with x402 payment requirements, payagent:
   - Parses the payment requirements (amount, chain, recipient)
   - Signs an EIP-3009 `transferWithAuthorization` using your wallet
   - Encodes the signature as an `X-PAYMENT` header
   - Retries the original request with the payment attached
3. The server verifies and settles the payment, then returns the API response
4. Your agent gets the response — no manual payment handling needed

Payments use **USDC stablecoins** on EVM chains. The agent's wallet must hold USDC on the chain the API requires. Gas is typically sponsored by the API's facilitator — agents pay $0 gas.

## Install

```bash
npm install payagent
```

Requires Node.js >= 18.

## API

### `payFetch(config)` — Drop-in fetch replacement

The simplest way to use payagent. Returns a fetch-compatible function that handles 402 automatically.

```ts
import { payFetch } from 'payagent';

const fetch402 = payFetch({
  privateKey: process.env.AGENT_WALLET_KEY,
});

// Use exactly like fetch
const res = await fetch402('https://api.example.com/data');
const res2 = await fetch402('https://api.example.com/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'hello' }),
});
```

### `PayAgent` class — With spending controls

For agents that need budget tracking and spending limits.

```ts
import { PayAgent } from 'payagent';

const agent = new PayAgent({
  privateKey: process.env.AGENT_WALLET_KEY,
  maxPerRequest: 1.00,                      // Max $1.00 USDC per request
  budget: 100.00,                            // $100 total session budget
  allowedDomains: ['api.example.com'],       // Only pay these domains
  allowedChains: ['eip155:8453'],            // Only pay on Base mainnet
});

const res = await agent.fetch('https://api.example.com/data');

console.log(agent.address);    // "0x742d35Cc..." — your wallet address
console.log(agent.spent);      // 0.10 — USDC spent this session
console.log(agent.remaining);  // 99.90 — budget remaining
console.log(agent.payments);   // Array of PaymentReceipt objects
```

### `handlePaymentRequired(response, url, options)` — Manual control

For framework authors or custom integration. Call this when you already have a 402 response.

```ts
import { handlePaymentRequired } from 'payagent';

const response = await fetch(url);

if (response.status === 402) {
  const paidResponse = await handlePaymentRequired(response, url, {
    privateKey: process.env.AGENT_WALLET_KEY,
  });
  console.log(await paidResponse.json());
}
```

## Configuration

```ts
interface PayAgentConfig {
  /** Ethereum private key (hex string, with or without 0x prefix). */
  privateKey: string;

  /** Max USDC per single request. Throws BudgetExceededError if exceeded. */
  maxPerRequest?: number;

  /** Total USDC budget for this session. Throws BudgetExceededError when exhausted. */
  budget?: number;

  /** Only pay for requests to these domains. Throws DomainNotAllowedError otherwise. */
  allowedDomains?: string[];

  /** Only sign payments on these CAIP-2 networks. */
  allowedChains?: string[];
}
```

## Supported Chains

payagent works on any EVM chain with USDC. The chain is determined by the API's 402 response — payagent reads the `network` field and signs for that chain automatically.

| Chain | Network ID | Notes |
|-------|-----------|-------|
| Base | `eip155:8453` | Recommended — lowest fees |
| Base Sepolia | `eip155:84532` | Testnet |
| Ethereum | `eip155:1` | Mainnet |
| Polygon | `eip155:137` | Mainnet |

Your wallet must hold USDC on the chain the API requires. Most x402 APIs use Base for the lowest transaction costs.

## Errors

payagent throws typed errors you can catch and handle:

```ts
import {
  BudgetExceededError,    // Payment would exceed maxPerRequest or budget
  UnsupportedChainError,  // API requires a chain not in allowedChains
  DomainNotAllowedError,  // URL domain not in allowedDomains
  PaymentRejectedError,   // Server returned 402 even after payment was sent
  InvalidRequirementsError, // Could not parse the 402 response
  PayAgentError,          // Base class for all payagent errors
} from 'payagent';

try {
  const res = await agent.fetch(url);
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.log(`Too expensive: ${err.requested} USDC (limit: ${err.limit})`);
  }
}
```

## Framework Integrations

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
  prompt: 'Get the premium weather forecast from https://weather-api.example.com/forecast',
});
```

Requires peer dependencies: `ai`, `zod`

### LangChain

```ts
import { createPayAgentTool } from 'payagent/langchain';

const payTool = createPayAgentTool({
  privateKey: process.env.AGENT_WALLET_KEY,
  budget: 10.00,
});

// Use with any LangChain agent
const agent = createToolCallingAgent({ llm, tools: [payTool], prompt });
```

Requires peer dependency: `@langchain/core`

### MCP Server

Use [payagent-mcp](https://github.com/stevemilton/payagent-mcp) to add payment capabilities to Claude Desktop, Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "payagent": {
      "command": "npx",
      "args": ["payagent-mcp"],
      "env": {
        "PAYAGENT_PRIVATE_KEY": "0x...",
        "PAYAGENT_BUDGET_USDC": "10.00"
      }
    }
  }
}
```

### OpenAI Function Calling

Use `handlePaymentRequired` inside your function implementation:

```ts
const tools = [{
  type: 'function',
  function: {
    name: 'fetch_paid_api',
    description: 'Fetch data from a paid API that requires USDC payment via HTTP 402.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The API URL' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
      },
      required: ['url'],
    },
  },
}];

// In your function handler:
async function fetchPaidApi({ url, method = 'GET' }) {
  const res = await fetch(url, { method });
  if (res.status === 402) {
    const paid = await handlePaymentRequired(res, url, {
      privateKey: process.env.AGENT_WALLET_KEY,
    });
    return await paid.text();
  }
  return await res.text();
}
```

## Wallet Setup

1. **Generate a wallet** (if you don't have one):
   ```ts
   import { ethers } from 'ethers';
   const wallet = ethers.Wallet.createRandom();
   console.log('Address:', wallet.address);
   console.log('Private key:', wallet.privateKey);
   ```

2. **Fund with USDC** on Base (recommended):
   - Send USDC to your wallet address on Base (`eip155:8453`)
   - For testing, use Base Sepolia faucet for testnet USDC

3. **Set as environment variable**:
   ```bash
   export AGENT_WALLET_KEY=0x...your_private_key...
   ```

## How x402 Works

The [x402 protocol](https://github.com/coinbase/x402) uses HTTP status code 402 (Payment Required) for machine-to-machine API payments:

1. **Server** returns HTTP 402 with payment requirements (chain, amount, recipient address)
2. **Agent** signs an EIP-3009 `transferWithAuthorization` — a gasless USDC transfer authorization
3. **Agent** retries the request with the signed payment in the `X-PAYMENT` header
4. **Server** (or its facilitator) submits the authorization on-chain to transfer USDC
5. **Server** returns the API response

Key properties:
- **No gas fees for agents** — the server's facilitator sponsors gas
- **USDC stablecoins** — no price volatility, amounts are in dollars
- **EIP-712 typed signatures** — secure, verifiable, replay-protected
- **Works on any EVM chain** — Base, Ethereum, Polygon, etc.

## License

MIT
