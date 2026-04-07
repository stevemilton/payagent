/**
 * payagent/langchain — LangChain tool integration.
 *
 * @example
 * ```ts
 * import { createPayAgentTool } from 'payagent/langchain';
 *
 * const payTool = createPayAgentTool({
 *   privateKey: process.env.AGENT_WALLET_KEY,
 *   budget: 10.00,
 * });
 *
 * // Use in a LangChain agent
 * const agent = createToolCallingAgent({ llm, tools: [payTool], prompt });
 * ```
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod/v3';
import { PayAgent } from './agent.js';
import type { PayAgentConfig } from './types.js';

/**
 * Create a LangChain tool that lets an AI agent make paid API calls.
 * Handles HTTP 402 payment challenges automatically using USDC.
 */
export function createPayAgentTool(config: PayAgentConfig) {
  const agent = new PayAgent(config);

  const schema = z.object({
    url: z.string().describe('The full URL of the API endpoint to call'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .default('GET')
      .describe('HTTP method'),
    headers: z
      .record(z.string())
      .optional()
      .describe('Additional HTTP headers to include'),
    body: z
      .string()
      .optional()
      .describe('Request body (for POST/PUT/PATCH)'),
  });

  return new DynamicStructuredTool({
    name: 'pay_api',
    description:
      'Make an HTTP request to a paid API. Automatically handles HTTP 402 payment ' +
      'challenges by signing USDC payments via the x402 protocol. Use this instead of ' +
      'regular fetch when you expect the API might require payment.',
    schema,
    func: async ({ url, method, headers, body }) => {
      const response = await agent.fetch(url, {
        method,
        headers,
        body,
      });

      const responseBody = await response.text();

      return JSON.stringify({
        status: response.status,
        body: responseBody,
        spent: agent.spent,
        remaining: agent.remaining,
      });
    },
  });
}
