/**
 * payagent — DelegationClient.
 *
 * Thin client for the ArisPay delegation API. Lets an integration
 * provision an x402 payer agent (wallet + API key + spend limits),
 * then poll until the wallet is funded before attempting payments.
 *
 * ArisPay returns the API key exactly once at creation — store it
 * securely; the server only stores its SHA-256 hash.
 *
 * @example
 * ```ts
 * const client = new DelegationClient('https://api.arispay.com', process.env.ARISPAY_API_KEY);
 * const agent = await client.createX402Agent({
 *   name: 'hermes-prod',
 *   agentType: 'hermes',
 *   maxPerTx: 100,       // cents
 *   maxDaily: 1000,
 *   maxMonthly: 10000,
 *   allowedDomains: ['api.arcticx.ai'],
 * });
 * console.log('Fund this wallet:', agent.walletAddress);
 * await client.pollUntilFunded(agent.agentId);
 * ```
 */

export interface X402AgentConfig {
  name: string;
  agentType?: string;
  /** Per-transaction cap in cents. */
  maxPerTx: number;
  /** Daily cap in cents. */
  maxDaily: number;
  /** Monthly cap in cents. */
  maxMonthly: number;
  /** Domains the agent is allowed to pay. Empty = unrestricted on ArisPay side. */
  allowedDomains?: string[];
  description?: string;
  /** EVM network label: 'base-sepolia' (default) | 'base' | 'ethereum' | 'polygon'. */
  network?: 'base-sepolia' | 'base' | 'ethereum' | 'polygon';
}

export interface CreateX402AgentResponse {
  agentId: string;
  walletAddress: string;
  /** API key for this agent — returned ONCE. Store it. */
  apiKey: string;
  status: 'pending_funding' | 'active';
  limits: { maxPerTx: number; maxDaily: number; maxMonthly: number };
  allowedDomains: string[];
  custody?: 'delegated' | 'self';
  network?: string;
}

export interface BalanceResponse {
  walletAddress: string;
  /** USDC balance in 6-decimal base units, as a string. */
  usdcBalance: string;
  /** CAIP-2 network identifier. */
  network: string;
  /** ISO timestamp when the wallet first received funds; null until funded. */
  fundedAt: string | null;
}

export class DelegationClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    if (!baseUrl) throw new Error('DelegationClient: baseUrl is required');
    if (!authToken) throw new Error('DelegationClient: authToken is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  /** Create an x402 payer agent. Returns wallet address + one-time API key. */
  async createX402Agent(config: X402AgentConfig): Promise<CreateX402AgentResponse> {
    return this.request<CreateX402AgentResponse>('POST', '/v1/agents/x402', config);
  }

  /** Fetch the on-chain USDC balance for a delegation's wallet. */
  async getBalance(agentId: string): Promise<BalanceResponse> {
    return this.request<BalanceResponse>('GET', `/v1/agents/${encodeURIComponent(agentId)}/x402-balance`);
  }

  /**
   * Poll `getBalance` until the wallet shows non-zero USDC (i.e. `fundedAt` latches).
   *
   * @param agentId The agent ID returned from createX402Agent.
   * @param options.intervalMs Poll interval (default 5000).
   * @param options.timeoutMs Give up after this many ms (default 10 minutes). Pass 0 for no timeout.
   */
  async pollUntilFunded(
    agentId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<BalanceResponse> {
    const interval = options.intervalMs ?? 5000;
    const timeout = options.timeoutMs ?? 10 * 60 * 1000;
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity;

    while (true) {
      const balance = await this.getBalance(agentId);
      if (balance.fundedAt || BigInt(balance.usdcBalance || '0') > 0n) {
        return balance;
      }
      if (Date.now() + interval > deadline) {
        throw new Error(`pollUntilFunded: timed out after ${timeout}ms waiting for funding of ${agentId}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'error' in parsed &&
          (parsed as { error?: { message?: string } }).error?.message) ||
        (typeof parsed === 'string' ? parsed : res.statusText);
      throw new Error(`ArisPay ${method} ${path} failed (${res.status}): ${message}`);
    }

    return parsed as T;
  }
}
