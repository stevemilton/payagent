/**
 * payagent — In-memory spending limits tracker.
 */
import type { PayAgentConfig, PaymentReceipt } from './types.js';
import { BudgetExceededError, DomainNotAllowedError } from './errors.js';

const USDC_DECIMALS = 6;

/** Convert USDC base units string to human-readable dollar amount. */
export function baseUnitsToUSDC(baseUnits: string): number {
  return Number(BigInt(baseUnits)) / 10 ** USDC_DECIMALS;
}

/** Format a number as USDC string (e.g. 0.1 -> "0.10"). */
export function formatUSDC(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

export class SpendTracker {
  private totalSpent = 0;
  private receipts: PaymentReceipt[] = [];
  private readonly maxPerRequest?: number;
  private readonly budget?: number;
  private readonly allowedDomains?: Set<string>;
  private readonly allowedChains?: Set<string>;

  constructor(config: PayAgentConfig) {
    this.maxPerRequest = config.maxPerRequest;
    this.budget = config.budget;
    this.allowedDomains = config.allowedDomains
      ? new Set(config.allowedDomains.map((d) => d.toLowerCase()))
      : undefined;
    this.allowedChains = config.allowedChains
      ? new Set(config.allowedChains)
      : undefined;
  }

  /** Check if a payment is allowed before signing. Throws on violation. */
  checkPayment(amountBaseUnits: string, url: string, network: string): void {
    const amountUSDC = baseUnitsToUSDC(amountBaseUnits);

    // Domain check
    if (this.allowedDomains) {
      const domain = new URL(url).hostname.toLowerCase();
      if (!this.allowedDomains.has(domain)) {
        throw new DomainNotAllowedError(domain);
      }
    }

    // Chain check (returns false — caller handles UnsupportedChainError)
    if (this.allowedChains && !this.allowedChains.has(network)) {
      return; // Let the caller filter chains and throw UnsupportedChainError
    }

    // Per-request limit
    if (this.maxPerRequest !== undefined && amountUSDC > this.maxPerRequest) {
      throw new BudgetExceededError(
        formatUSDC(amountUSDC),
        formatUSDC(this.maxPerRequest),
        'per-request',
      );
    }

    // Total budget
    if (this.budget !== undefined && this.totalSpent + amountUSDC > this.budget) {
      const remaining = this.budget - this.totalSpent;
      throw new BudgetExceededError(
        formatUSDC(amountUSDC),
        formatUSDC(remaining),
        'total',
      );
    }
  }

  /** Is a given chain allowed? */
  isChainAllowed(network: string): boolean {
    if (!this.allowedChains) return true;
    return this.allowedChains.has(network);
  }

  /** Record a successful payment. */
  recordPayment(receipt: PaymentReceipt): void {
    this.totalSpent += baseUnitsToUSDC(receipt.amountBaseUnits);
    this.receipts.push(receipt);
  }

  /** Total USDC spent this session. */
  get spent(): number {
    return this.totalSpent;
  }

  /** Remaining budget (Infinity if no budget set). */
  get remaining(): number {
    if (this.budget === undefined) return Infinity;
    return Math.max(0, this.budget - this.totalSpent);
  }

  /** All payment receipts. */
  get history(): readonly PaymentReceipt[] {
    return this.receipts;
  }
}
