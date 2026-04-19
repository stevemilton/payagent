# X/Twitter Thread — payagent Launch

---

**1/**
AI agents can browse, code, and call APIs — but they can't pay for anything.

We just shipped payagent: a drop-in fetch wrapper that lets agents pay for APIs automatically.

3 lines of code. USDC stablecoins. Zero gas fees.

npm install payagent

---

**2/**
How it works:

1. Agent calls fetch(url)
2. Server returns HTTP 402 "Payment Required"
3. payagent signs a USDC payment
4. Retries the request with the payment attached
5. Agent gets the response

The entire payment flow is invisible to the agent.

---

**3/**
```typescript
import { payFetch } from 'payagent';

const fetch402 = payFetch({
  privateKey: process.env.AGENT_WALLET_KEY
});

const res = await fetch402('https://api.example.com/data');
```

That's the entire integration. No API keys. No billing dashboard. Just a wallet and a URL.

---

**4/**
Safety matters when agents hold wallets:

- Per-request spending limits
- Session budgets ($100 max, etc.)
- Domain allowlists
- Chain restrictions

Your agent operates within the guardrails you define.

---

**5/**
Works with every major agent framework:

- Vercel AI SDK → `payagent/vercel`
- LangChain → `payagent/langchain`
- Claude Desktop → `payagent-mcp`
- OpenAI function calling → `handlePaymentRequired`

One protocol. Every framework.

---

**6/**
Built on the x402 protocol (@coinaboratory):

- HTTP 402 + EIP-3009 gasless USDC signatures
- Agent signs, facilitator settles on-chain
- Agent pays $0 gas
- Works on Base, Ethereum, Polygon

The internet's native payment layer for machines.

---

**7/**
For API providers: monetize with one line.

```typescript
app.get('/api/data',
  agfac402({ price: 0.10 }),
  handler
);
```

No Stripe. No billing page. Agents pay per-call with USDC.

---

**8/**
Links:

npm: npmjs.com/package/payagent
GitHub: github.com/arispay-inc/payagent
MCP server: github.com/arispay-inc/payagent-mcp

Built by @[your_handle] / Polar Industries

---

# Notes for publishing:
# - Replace @[your_handle] with actual X handle
# - Replace @coinaboratory with correct Coinbase x402 handle if different
# - Add a demo video/GIF of the agent paying for an API call
# - Thread image: terminal showing the 402 → pay → 200 flow
