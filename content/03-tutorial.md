---
title: "Build an AI Agent That Pays for APIs in 5 Minutes"
tags: [ai, tutorial, typescript, agents]
published: false
---

# Build an AI Agent That Pays for APIs in 5 Minutes

Let's build an AI agent that can autonomously pay for premium API calls using USDC stablecoins. We'll use the Vercel AI SDK and payagent.

By the end, you'll have an agent that:
- Takes natural language requests
- Calls paid APIs when needed
- Handles HTTP 402 payment challenges automatically
- Tracks its spending

## Prerequisites

- Node.js 18+
- An Anthropic API key (or any Vercel AI SDK-compatible provider)
- A funded USDC wallet (we'll use Base Sepolia testnet)

## Step 1: Set Up the Project

```bash
mkdir paying-agent && cd paying-agent
npm init -y
npm install ai @ai-sdk/anthropic payagent zod
```

## Step 2: Generate a Wallet

Create a quick script to generate a test wallet:

```typescript
// generate-wallet.ts
import { ethers } from 'ethers';

const wallet = ethers.Wallet.createRandom();
console.log('Address:', wallet.address);
console.log('Private Key:', wallet.privateKey);
console.log('\nFund this address with USDC on Base Sepolia for testing.');
```

Run it:

```bash
npx tsx generate-wallet.ts
```

Save the private key — you'll need it in a moment.

For testnet: get Base Sepolia USDC from a faucet. For mainnet: send USDC to the address on Base.

## Step 3: Create the Agent

```typescript
// agent.ts
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { createPayAgentTool } from 'payagent/vercel';

// Create the payment tool with a $5 budget
const payTool = createPayAgentTool({
  privateKey: process.env.AGENT_WALLET_KEY!,
  budget: 5.00,
  maxPerRequest: 1.00,
});

async function main() {
  const prompt = process.argv.slice(2).join(' ')
    || 'Get me a random joke from the premium joke API';

  console.log(`Agent prompt: "${prompt}"\n`);

  const { text, toolCalls, toolResults } = await generateText({
    model: anthropic('claude-sonnet-4-20250514'),
    tools: { pay_api: payTool },
    maxSteps: 5,
    system: `You are a helpful assistant with the ability to call paid APIs.
When you need data from an API that requires payment, use the pay_api tool.
The tool handles payment automatically — just provide the URL.
Always tell the user how much was spent.`,
    prompt,
  });

  console.log('Agent response:', text);

  if (toolResults.length > 0) {
    for (const result of toolResults) {
      const r = result.result as { spent: number; remaining: number };
      console.log(`\nSpent: $${r.spent.toFixed(2)} USDC`);
      console.log(`Remaining budget: $${r.remaining.toFixed(2)} USDC`);
    }
  }
}

main().catch(console.error);
```

## Step 4: Run It

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export AGENT_WALLET_KEY=0x...

npx tsx agent.ts "Get me a joke from https://agfac-production.up.railway.app/demo/joke"
```

Here's what happens under the hood:

1. Claude receives the prompt and decides to call `pay_api` with the URL
2. payagent makes a GET request to the URL
3. The server returns HTTP 402 with payment requirements ($0.10 USDC on Base Sepolia)
4. payagent signs an EIP-3009 transfer authorization with your wallet
5. payagent retries the request with the `X-PAYMENT` header
6. The server verifies, settles, and returns the joke
7. Claude formats the response for you

## Step 5: Add More APIs

The agent can pay for any x402-enabled API. Try:

```bash
# Get a quote
npx tsx agent.ts "Get an inspirational quote from https://agfac-production.up.railway.app/demo/quote"

# Get weather
npx tsx agent.ts "What's the weather like? Check https://agfac-production.up.railway.app/demo/weather?city=London"
```

## Using the MCP Server Instead

If you prefer to use payagent with Claude Desktop directly (no code needed), install the MCP server:

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "payagent": {
      "command": "npx",
      "args": ["payagent-mcp"],
      "env": {
        "PAYAGENT_PRIVATE_KEY": "0x...",
        "PAYAGENT_BUDGET_USDC": "5.00"
      }
    }
  }
}
```

Now Claude can pay for APIs directly in conversation:

> "Use pay_api to get a joke from https://agfac-production.up.railway.app/demo/joke"

## What's Next?

- **Monetize your own API**: Add x402 paywalls with `@agfac/middleware` ([docs](https://github.com/arispay-inc/payagent))
- **Build autonomous agents**: Combine payagent with LangChain or CrewAI for multi-step agent workflows
- **Production wallets**: Use a hardware wallet or HSM for production agent keys

---

**Links:**
- [payagent](https://github.com/arispay-inc/payagent) — npm package
- [payagent-mcp](https://github.com/arispay-inc/payagent-mcp) — MCP server
- [x402 protocol](https://github.com/coinbase/x402) — protocol spec
