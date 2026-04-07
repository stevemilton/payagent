/**
 * payagent/vercel — Vercel AI SDK tool integration.
 *
 * @example
 * ```ts
 * import { createPayAgentTool } from 'payagent/vercel';
 * import { generateText } from 'ai';
 *
 * const payTool = createPayAgentTool({
 *   privateKey: process.env.AGENT_WALLET_KEY,
 *   budget: 10.00,
 * });
 *
 * const { text } = await generateText({
 *   model: yourModel,
 *   tools: { pay_api: payTool },
 *   prompt: 'Fetch the premium weather data from ...',
 * });
 * ```
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod/v4';
import { PayAgent } from './agent.js';
import type { PayAgentConfig } from './types.js';

const inputSchema = z.object({
  url: z.string().describe('The full URL of the API endpoint to call'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    .default('GET')
    .describe('HTTP method'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Additional HTTP headers to include'),
  body: z
    .string()
    .optional()
    .describe('Request body (for POST/PUT/PATCH)'),
  maxPaymentUSDC: z
    .number()
    .default(1.0)
    .describe('Maximum USDC to pay for this single request'),
});

type Input = z.infer<typeof inputSchema>;

interface PayApiResult {
  status: number;
  body: string;
  spent: number;
  remaining: number;
}

/**
 * Create a Vercel AI SDK tool that lets an AI agent make paid API calls.
 * Handles HTTP 402 payment challenges automatically using USDC.
 */
export function createPayAgentTool(config: PayAgentConfig): Tool<Input, PayApiResult> {
  const agent = new PayAgent(config);

  return tool<Input, PayApiResult>({
    description:
      'Make an HTTP request to a paid API. Automatically handles HTTP 402 payment ' +
      'challenges by signing USDC payments via the x402 protocol. Use this instead of ' +
      'regular fetch when you expect the API might require payment.',
    inputSchema,
    execute: async ({ url, method, headers, body }) => {
      const response = await agent.fetch(url, {
        method,
        headers: headers as Record<string, string> | undefined,
        body,
      });

      const responseBody = await response.text();

      return {
        status: response.status,
        body: responseBody,
        spent: agent.spent,
        remaining: agent.remaining,
      };
    },
  });
}
