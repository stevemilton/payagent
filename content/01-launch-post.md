---
title: "Introducing payagent: Let AI Agents Pay for APIs"
tags: [ai, web3, agents, typescript]
canonical_url: https://github.com/stevemilton/payagent
published: false
---

# Introducing payagent: Let AI Agents Pay for APIs

There's a gap in the AI agent stack. Agents can browse the web, write code, call APIs — but they can't *pay* for anything. If an agent hits a premium API that costs $0.10 per call, it's stuck.

HTTP status code 402 — "Payment Required" — has existed since 1997. It was reserved for "future use." That future is now.

**payagent** is a drop-in fetch wrapper that handles HTTP 402 payments automatically. Your agent makes a request, gets a 402, and payagent signs a USDC stablecoin payment and retries — all in one line:

```typescript
import { payFetch } from 'payagent';

const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/premium-data');
const data = await res.json();
```

No payment gateway. No API keys. No subscription. Just a wallet with USDC and a URL.

## The Problem: APIs Don't Have a Cash Register

Today, if you want an AI agent to use a paid API, you need to:

1. Create an account on the API provider's platform
2. Add a credit card
3. Get an API key
4. Hardcode that key into your agent
5. Monitor usage and billing separately

This works for developers building products. It doesn't work for autonomous agents that need to discover and pay for APIs on the fly.

What if the agent could just... pay? The same way a browser handles cookies or TLS — transparently, at the protocol level.

## How It Works: The x402 Protocol

The [x402 protocol](https://github.com/coinbase/x402) turns HTTP 402 into a machine-readable payment flow:

**Step 1:** Agent requests an API endpoint
```
GET https://api.example.com/premium-data
```

**Step 2:** Server returns 402 with payment requirements
```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "100000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xMerchantWallet..."
  }]
}
```

This says: "Pay 0.10 USDC on Base to this wallet address."

**Step 3:** Agent signs an EIP-3009 `transferWithAuthorization` — a gasless USDC transfer that doesn't require an on-chain transaction from the agent

**Step 4:** Agent retries the request with the signed payment in the `X-PAYMENT` header

**Step 5:** Server verifies the signature, settles on-chain, returns the data

The agent pays $0 gas. The merchant's facilitator sponsors the transaction. The agent just signs — no private RPC node, no gas tokens, no bridge transactions.

## Why USDC Stablecoins?

- **No volatility** — $0.10 today is $0.10 tomorrow
- **Programmable** — EIP-3009 enables signature-based transfers (no gas needed from the sender)
- **Multi-chain** — Same USDC contract on Base, Ethereum, Polygon
- **Instant settlement** — On-chain finality in seconds, not days

## payagent: Three Ways to Use It

### 1. Drop-in fetch replacement

```typescript
const fetch402 = payFetch({ privateKey: process.env.AGENT_WALLET_KEY });
const res = await fetch402('https://api.example.com/data');
```

### 2. With spending controls

```typescript
const agent = new PayAgent({
  privateKey: process.env.AGENT_WALLET_KEY,
  budget: 100.00,        // $100 session budget
  maxPerRequest: 1.00,   // Max $1 per call
  allowedDomains: ['api.example.com'],
});

const res = await agent.fetch('https://api.example.com/data');
console.log(agent.spent);     // 0.10
console.log(agent.remaining); // 99.90
```

### 3. As an AI tool (Vercel AI SDK / LangChain / MCP)

```typescript
import { createPayAgentTool } from 'payagent/vercel';

const payTool = createPayAgentTool({
  privateKey: process.env.AGENT_WALLET_KEY,
  budget: 10.00,
});

const { text } = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: { pay_api: payTool },
  prompt: 'Get the premium forecast from the weather API',
});
```

Or as an MCP server for Claude Desktop:

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

## Safety: Agents Need Guardrails

Giving an agent a wallet is like giving an intern a corporate credit card. You need limits.

payagent has built-in safety:

- **Per-request limits** — `maxPerRequest: 1.00` caps any single payment
- **Session budgets** — `budget: 100.00` sets total spend ceiling
- **Domain allowlists** — `allowedDomains: ['api.example.com']` restricts where the agent can pay
- **Chain allowlists** — `allowedChains: ['eip155:8453']` restricts which networks
- **Typed errors** — `BudgetExceededError`, `DomainNotAllowedError` for programmatic handling

The agent can't accidentally drain its wallet. It operates within the constraints you define.

## For API Providers: Monetize with One Line

If you're building an API and want to accept agent payments, check out [@agfac/middleware](https://github.com/stevemilton/payagent) — Express and Fastify middleware that adds x402 paywalls to any endpoint:

```typescript
import { agfac402 } from '@agfac/middleware';

app.get('/api/premium-data',
  agfac402({ price: 0.10, facilitatorUrl: '...' }),
  (req, res) => {
    res.json({ data: 'premium content' });
  }
);
```

No Stripe account. No billing page. Agents pay per-call with USDC.

## Get Started

```bash
npm install payagent
```

1. Generate a wallet: `ethers.Wallet.createRandom()`
2. Fund it with USDC on Base
3. Set `AGENT_WALLET_KEY` env var
4. Replace `fetch` with `payFetch`

That's it. Your agent can now pay for APIs.

---

**Links:**
- [payagent on npm](https://www.npmjs.com/package/payagent)
- [payagent on GitHub](https://github.com/stevemilton/payagent)
- [payagent-mcp](https://github.com/stevemilton/payagent-mcp) — MCP server for Claude/Cursor
- [x402 protocol spec](https://github.com/coinbase/x402)
