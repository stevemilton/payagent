/**
 * payagent — PayAgent class with stateful budget tracking.
 *
 * Usage:
 *   const agent = new PayAgent({
 *     privateKey: '0x...',
 *     budget: 10.00,
 *     maxPerRequest: 1.00,
 *   });
 *   const res = await agent.fetch('https://api.example.com/data');
 *   console.log(agent.spent);     // 0.10
 *   console.log(agent.remaining); // 9.90
 */
import { ethers } from 'ethers';
import type { PayAgentConfig, PaymentReceipt } from './types.js';
import { SpendTracker } from './limits.js';
import { handlePaymentRequired } from './payment.js';

export class PayAgent {
  private readonly config: PayAgentConfig;
  private readonly tracker: SpendTracker;
  public readonly address: string;

  constructor(config: PayAgentConfig) {
    this.config = config;
    this.tracker = new SpendTracker(config);

    // Derive the wallet address so agents can check their identity
    const wallet = new ethers.Wallet(config.privateKey);
    this.address = wallet.address;
  }

  /**
   * Fetch a URL, automatically handling 402 payment challenges.
   * Works exactly like native fetch, but pays when required.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = url.toString();
    const response = await fetch(urlStr, init);

    if (response.status !== 402) {
      return response;
    }

    return handlePaymentRequired(response, urlStr, {
      privateKey: this.config.privateKey,
      facilitatorUrl: this.config.facilitatorUrl,
      tracker: this.tracker,
      requestInit: init,
    });
  }

  /** Total USDC spent this session. */
  get spent(): number {
    return this.tracker.spent;
  }

  /** Remaining budget in USDC. Infinity if no budget set. */
  get remaining(): number {
    return this.tracker.remaining;
  }

  /** All payment receipts from this session. */
  get payments(): readonly PaymentReceipt[] {
    return this.tracker.history;
  }
}
