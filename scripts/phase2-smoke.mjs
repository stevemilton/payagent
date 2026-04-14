/**
 * Phase 2 smoke test — hits a locally-running ArisPay API (PHASE 1)
 * via the SDK's DelegationClient, confirms end-to-end shape.
 *
 * Run:
 *   ARISPAY_URL=http://localhost:3001 ARISPAY_KEY=ap_test_xxx node scripts/phase2-smoke.mjs
 */
import { DelegationClient, getUSDCBalance, formatUSDC } from '../dist/index.js';

const baseUrl = process.env.ARISPAY_URL;
const authToken = process.env.ARISPAY_KEY;
if (!baseUrl || !authToken) {
  console.error('Set ARISPAY_URL and ARISPAY_KEY');
  process.exit(1);
}

const client = new DelegationClient(baseUrl, authToken);

console.log('1. createX402Agent');
const agent = await client.createX402Agent({
  name: `sdk-smoke-${Date.now()}`,
  agentType: 'hermes',
  maxPerTx: 100,
  maxDaily: 1000,
  maxMonthly: 10000,
  allowedDomains: ['api.arcticx.ai'],
});
console.log('   ->', agent);
if (!agent.agentId || !agent.walletAddress || !agent.apiKey) {
  throw new Error('createX402Agent missing fields');
}

console.log('2. getBalance');
const bal1 = await client.getBalance(agent.agentId);
console.log('   ->', bal1);

console.log('3. pollUntilFunded (short timeout — mock returns balance immediately)');
const funded = await client.pollUntilFunded(agent.agentId, { intervalMs: 500, timeoutMs: 5000 });
console.log('   ->', funded);
if (!funded.fundedAt && BigInt(funded.usdcBalance) === 0n) {
  throw new Error('pollUntilFunded returned but wallet not funded');
}

console.log('4. getUSDCBalance (on-chain) — skip if mock wallet address');
if (/^0x[0-9a-fA-F]{40}$/.test(agent.walletAddress)) {
  try {
    const onChain = await getUSDCBalance(agent.walletAddress, 'base-sepolia');
    console.log(`   -> on-chain: ${onChain} base units (${formatUSDC(onChain)} USDC)`);
  } catch (err) {
    console.log('   !! RPC query failed (network):', err.message);
  }
} else {
  console.log(`   -> skipped: "${agent.walletAddress}" is a mock address, not a real EVM address`);
}

console.log('\nALL SDK TESTS PASSED');
