#!/usr/bin/env bun
/**
 * Bitflow-Zest Yield Balancer — Autonomous sBTC yield optimization
 *
 * Compares sBTC APY on Zest Protocol vs. Bitflow sBTC/STX XYK pool.
 * Suggests and prepares rebalancing transactions to maximize yield.
 *
 * Built for AIBTC x Bitflow "Skills Pay the Bills" competition.
 * v1.1.5 - Addressing arc0btc re-review blockers.
 */

import { Command } from "commander";
import {
  principalCV,
  contractPrincipalCV,
  fetchCallReadOnlyFunction,
  ClarityType,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Constants ──────────────────────────────────────────────────────────

const NETWORK = STACKS_MAINNET;
const STACKS_API = "https://stacks-node-api.mainnet.stacks.co";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_API = "https://api.bitflow.finance/api/v1"; 

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const STX_TOKEN = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const BITFLOW_CORE = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2";
const BITFLOW_SBTC_STX_POOL = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const ZEST_POOL = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const ZSBTC_TOKEN = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0";

const MIN_GAS_USTX = 200_000;
const REBALANCE_THRESHOLD_BPS = 50; // 0.5% yield difference
const SLIPPAGE_TOLERANCE_PCT = 0.05; // 5% protection
const FETCH_TIMEOUT = 15000;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, any>;
  error: { code: string; message: string; next: string } | null;
}

interface BitflowPool {
  pool_id: string;
  apr24h: number;
  tvl_usd: number;
  reserve_x: string;
  reserve_y: string;
  shares_total: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function emitError(code: string, message: string, next: string): void {
  emit({
    status: "error",
    action: "Error encountered",
    data: {},
    error: { code, message, next },
  });
}

async function fetchWithTimeout(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url} with status ${response.status}`);
  }
  return response;
}

async function getBalances(address: string) {
  const apis = [STACKS_API, HIRO_API];
  let lastError = null;

  for (const api of apis) {
    try {
      const res = await fetchWithTimeout(`${api}/extended/v1/address/${address}/balances`);
      const data = await res.json() as any;
      
      const sbtcKey = `${SBTC_TOKEN}::sbtc-token`;
      const zsbtcKey = `${ZSBTC_TOKEN}::zsbtc-v2-0`;
      const bitflowLpKey = `${BITFLOW_SBTC_STX_POOL}::pool-token`;

      return {
        stx: parseInt(data.stx?.balance || "0", 10) - parseInt(data.stx?.locked || "0", 10),
        sbtc: parseInt(data.fungible_tokens?.[sbtcKey]?.balance || "0", 10),
        zest_sbtc: parseInt(data.fungible_tokens?.[zsbtcKey]?.balance || "0", 10),
        bitflow_lp: parseInt(data.fungible_tokens?.[bitflowLpKey]?.balance || "0", 10),
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Critical: Failed to fetch balances. Network unreachable. Error: ${lastError}`);
}

async function getBitflowPool(): Promise<BitflowPool> {
  const res = await fetchWithTimeout(`${BITFLOW_API}/pools`);
  const data = await res.json() as any;
  const pools = Array.isArray(data) ? data : (data.data || []);
  const pool = pools.find((p: any) => p.pool_id === "xyk_sbtc_stx");
  if (!pool) throw new Error("sBTC-STX pool (xyk_sbtc_stx) not found in Bitflow API");
  return pool;
}

async function getZestApy(): Promise<number> {
  const [address, name] = ZEST_POOL.split(".");
  const [sbtcAddr, sbtcName] = SBTC_TOKEN.split(".");

  const result = await fetchCallReadOnlyFunction({
    network: NETWORK,
    contractAddress: address,
    contractName: name,
    functionName: "get-reserve-state",
    functionArgs: [contractPrincipalCV(sbtcAddr, sbtcName)],
    senderAddress: "SP000000000000000000002Q6VF78",
  });
  
  if (result && result.type === ClarityType.ResponseOk) {
    const val = result.value as any;
    if (val && val.data) {
      const rate = val.data["current-liquidity-rate"].value;
      // Zest/Aave rates are in Ray (1e27). 
      // (rate / 1e27) * 100 = rate / 1e25
      const apy = (Number(rate) / 1e27) * 100;
      return parseFloat(apy.toFixed(2));
    }
  }
  throw new Error("Failed to parse Zest APY from on-chain response");
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(address: string): Promise<void> {
  if (!address) {
    emitError("MISSING_ADDRESS", "STX_ADDRESS environment variable is not set", "Set STX_ADDRESS and retry");
    return;
  }

  try {
    const results = await Promise.all([
      fetchWithTimeout(`${STACKS_API}/v2/info`),
      getBitflowPool(),
      getZestApy(),
      getBalances(address)
    ]);

    const checks = {
      stacks_api: !!results[0],
      bitflow_api: !!results[1],
      zest_api: !!results[2],
      balances_ok: !!results[3],
      stx_gas_ok: (results[3] as any).stx >= MIN_GAS_USTX,
    };

    emit({
      status: "success",
      action: "Ready to optimize yield",
      data: { checks, address },
      error: null,
    });
  } catch (e) {
    emitError("DOCTOR_FAIL", `Environment not ready: ${e}`, "Check network and API status");
  }
}

async function status(address: string): Promise<void> {
  try {
    const [bfPool, zestApy, balances] = await Promise.all([
      getBitflowPool(),
      getZestApy(),
      getBalances(address),
    ]);
    
    const bfApy = bfPool.apr24h;
    const diff = bfApy - zestApy;
    const recommendation = diff > (REBALANCE_THRESHOLD_BPS/100)
      ? "Yield is higher on Bitflow. Consider moving funds to Bitflow."
      : diff < -(REBALANCE_THRESHOLD_BPS/100)
        ? "Yield is higher on Zest. Consider moving funds to Zest."
        : "Yields are balanced. No action needed.";

    emit({
      status: "success",
      action: "Yield landscape retrieved",
      data: {
        yields: {
          zest_sbtc_apy: `${zestApy.toFixed(2)}%`,
          bitflow_sbtc_stx_apy: `${bfApy.toFixed(2)}%`,
          spread: `${Math.abs(diff).toFixed(2)}%`,
        },
        positions: {
          zest_sbtc_sats: balances.zest_sbtc,
          bitflow_lp_tokens: balances.bitflow_lp,
          liquid_sbtc_sats: balances.sbtc,
        },
        recommendation,
      },
      error: null,
    });
  } catch (e) {
    emitError("STATUS_FAIL", String(e), "API failure. Fallbacks disabled for safety.");
  }
}

async function run(address: string, action: string, confirm: boolean): Promise<void> {
  if (action === "check") {
    await status(address);
    return;
  }

  if (action !== "rebalance") {
    emitError("INVALID_ACTION", `Unknown action: ${action}`, "Use --action=check|rebalance");
    return;
  }

  try {
    const bfPoolData = await getBitflowPool();
    const zestApy = await getZestApy();
    const balances = await getBalances(address);
    
    const bfApy = bfPoolData.apr24h;
    const diff = bfApy - zestApy;

    if (diff > (REBALANCE_THRESHOLD_BPS/100)) {
      const amount = balances.zest_sbtc > 0 ? balances.zest_sbtc : balances.sbtc;
      if (amount > 10000) {
        if (!confirm) {
          emit({
            status: "blocked",
            action: "Confirmation required",
            data: { recommendation: "Move to Bitflow", amount_sats: amount },
            error: null
          });
          return;
        }

        // Estimate LP tokens out for add-liquidity min-dlp
        // ratio = shares_total / reserve_x (where x is sbtc)
        const ratio = Number(bfPoolData.shares_total) / Number(bfPoolData.reserve_x);
        const expectedLp = Math.floor(amount * ratio);
        const minLp = Math.floor(expectedLp * (1 - SLIPPAGE_TOLERANCE_PCT));

        const steps = [];
        if (balances.zest_sbtc > 0) {
          steps.push({
            name: "Withdraw from Zest",
            mcp_command: {
              tool: "zest_withdraw",
              params: { asset: "sBTC", amount: amount.toString() }
            }
          });
        }

        steps.push({
          name: "Add Liquidity to Bitflow",
          mcp_command: {
            tool: "call_contract",
            params: {
              contractAddress: BITFLOW_CORE.split(".")[0],
              contractName: BITFLOW_CORE.split(".")[1],
              functionName: "add-liquidity",
              functionArgs: [
                { type: "principal", value: BITFLOW_SBTC_STX_POOL },
                { type: "principal", value: SBTC_TOKEN },
                { type: "principal", value: STX_TOKEN },
                { type: "uint", value: amount.toString() },
                { type: "uint", value: minLp.toString() }
              ],
              postConditionMode: "deny",
              postConditions: [
                {
                  type: "ft",
                  principal: address,
                  asset: SBTC_TOKEN,
                  assetName: "sbtc-token",
                  conditionCode: "eq",
                  amount: amount.toString()
                }
              ]
            }
          }
        });

        emit({ status: "success", action: "Rebalance to Bitflow prepared", data: { steps }, error: null });
      } else {
        emit({ status: "success", action: "No funds to rebalance", data: {}, error: null });
      }
    } else if (diff < -(REBALANCE_THRESHOLD_BPS/100)) {
      if (balances.bitflow_lp > 0) {
        if (!confirm) {
          emit({
            status: "blocked",
            action: "Confirmation required",
            data: { recommendation: "Move to Zest" },
            error: null
          });
          return;
        }

        // Estimate sBTC out for zest_supply amount
        // sbtc_out = lp_tokens * (reserve_x / shares_total)
        const ratio = Number(bfPoolData.reserve_x) / Number(bfPoolData.shares_total);
        const expectedSbtc = Math.floor(balances.bitflow_lp * ratio);
        const minSbtc = Math.floor(expectedSbtc * (1 - SLIPPAGE_TOLERANCE_PCT));

        emit({
          status: "success",
          action: "Rebalance to Zest prepared",
          data: {
            steps: [
              {
                name: "Withdraw from Bitflow",
                mcp_command: {
                  tool: "call_contract",
                  params: {
                    contractAddress: BITFLOW_CORE.split(".")[0],
                    contractName: BITFLOW_CORE.split(".")[1],
                    functionName: "withdraw-liquidity",
                    functionArgs: [
                      { type: "principal", value: BITFLOW_SBTC_STX_POOL },
                      { type: "principal", value: SBTC_TOKEN },
                      { type: "principal", value: STX_TOKEN },
                      { type: "uint", value: balances.bitflow_lp.toString() },
                      { type: "uint", value: minSbtc.toString() }, // Fixed minAmount protection
                      { type: "uint", value: "0" }
                    ],
                    postConditionMode: "deny",
                    postConditions: [
                      {
                        type: "ft",
                        principal: address,
                        asset: BITFLOW_SBTC_STX_POOL,
                        assetName: "pool-token",
                        conditionCode: "eq",
                        amount: balances.bitflow_lp.toString()
                      }
                    ]
                  }
                }
              },
              {
                name: "Supply to Zest",
                mcp_command: {
                  tool: "zest_supply",
                  params: { asset: "sBTC", amount: minSbtc.toString() } // Now executable with estimated min
                }
              }
            ]
          },
          error: null
        });
      } else {
        emit({ status: "success", action: "No funds to rebalance", data: {}, error: null });
      }
    } else {
      emit({ status: "success", action: "Balanced", data: {}, error: null });
    }
  } catch (e) {
    emitError("RUN_FAIL", `Operation failed: ${e}`, "Check network and API status. Fallbacks disabled.");
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-zest-yield-balancer")
  .description("Optimize sBTC yield between Bitflow and Zest Protocol")
  .version("1.1.5");

program
  .command("doctor")
  .description("Check environment readiness")
  .action(async () => {
    const address = process.env.STX_ADDRESS || "";
    await doctor(address);
  });

program
  .command("status")
  .description("Check current yields and positions")
  .action(async () => {
    const address = process.env.STX_ADDRESS || "";
    await status(address);
  });

program
  .command("run")
  .description("Execute yield optimization")
  .option("--action <action>", "Action: check | rebalance", "check")
  .option("--confirm", "Confirm execution of write actions", false)
  .action(async (opts) => {
    const address = process.env.STX_ADDRESS || "";
    await run(address, opts.action, opts.confirm);
  });

program.parseAsync(process.argv).catch((err) => {
  emitError("UNHANDLED", String(err), "Check logs and retry");
});
