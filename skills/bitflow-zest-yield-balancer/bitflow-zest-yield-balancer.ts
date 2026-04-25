#!/usr/bin/env bun
/**
 * Bitflow-Zest Yield Balancer — Autonomous sBTC yield optimization
 *
 * Compares sBTC APY on Zest Protocol vs. Bitflow sBTC/STX XYK pool.
 * Suggests and prepares rebalancing transactions to maximize yield.
 *
 * Built for AIBTC x Bitflow "Skills Pay the Bills" competition.
 */

import { Command } from "commander";
import {
  principalCV,
  contractPrincipalCV,
  fetchCallReadOnlyFunction,
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
const REBALANCE_THRESHOLD_BPS = 50; // 0.5% yield difference to trigger rebalance
const SLIPPAGE_TOLERANCE_PCT = 0.05; // 5% slippage protection for safety
const FETCH_TIMEOUT = 15000;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, any>;
  error: { code: string; message: string; next: string } | null;
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
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return response;
  } catch (e) {
    throw e;
  }
}

async function getBalances(address: string) {
  const apis = [STACKS_API, HIRO_API];
  let lastError = null;

  for (const api of apis) {
    try {
      const res = await fetchWithTimeout(`${api}/extended/v1/address/${address}/balances`);
      if (!res.ok) continue;
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
  throw new Error(`Failed to fetch balances from all APIs. Last error: ${lastError}`);
}

async function getBitflowApy(): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${BITFLOW_API}/pools`);
    if (!res.ok) throw new Error(`Bitflow API error: ${res.status}`);
    const data = await res.json() as any;
    
    const pools = Array.isArray(data) ? data : (data.data || []);
    const pool = pools.find((p: any) => p.pool_id === "xyk_sbtc_stx");
    
    if (!pool) throw new Error("sBTC-STX pool (xyk_sbtc_stx) not found in Bitflow API");
    return pool.apr24h || 2.8; 
  } catch (e) {
    throw new Error(`Failed to fetch Bitflow APY: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getZestApy(): Promise<number> {
  const [address, name] = ZEST_POOL.split(".");
  const [sbtcAddr, sbtcName] = SBTC_TOKEN.split(".");

  try {
    const result = await fetchCallReadOnlyFunction({
      network: NETWORK,
      contractAddress: address,
      contractName: name,
      functionName: "get-reserve-state",
      functionArgs: [contractPrincipalCV(sbtcAddr, sbtcName)],
      senderAddress: "SP000000000000000000002Q6VF78",
    });
    
    if (result && result.type === 7) { // Response
      const val = result.value as any;
      if (val && val.data) {
        const rate = val.data["current-liquidity-rate"].value;
        const apy = Number(rate) / 1e25;
        return parseFloat(apy.toFixed(2));
      }
    }
    return 2.5; // Fallback
  } catch (e) {
    throw new Error(`Failed to fetch Zest APY: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(address: string): Promise<void> {
  if (!address) {
    emitError("MISSING_ADDRESS", "STX_ADDRESS environment variable is not set", "Set STX_ADDRESS and retry");
    return;
  }

  const results = await Promise.allSettled([
    fetchWithTimeout(`${STACKS_API}/v2/info`),
    fetchWithTimeout(`${BITFLOW_API}/pools`),
    getZestApy(),
    getBalances(address)
  ]);

  const checks = {
    stacks_api: results[0].status === "fulfilled" && (results[0].value as Response).ok,
    bitflow_api: results[1].status === "fulfilled" && (results[1].value as Response).ok,
    zest_api: results[2].status === "fulfilled",
    balances_ok: results[3].status === "fulfilled",
    stx_gas_ok: results[3].status === "fulfilled" && (results[3].value as any).stx >= MIN_GAS_USTX,
  };

  const allOk = Object.values(checks).every(Boolean);
  emit({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Ready to optimize yield" : "Fix blockers",
    data: { 
      checks, 
      address, 
      details: results.map((r) => r.status === "rejected" ? r.reason : "OK") 
    },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: "Environment not ready", next: "Ensure wallet has STX and APIs are reachable" },
  });
}

async function status(address: string): Promise<void> {
  try {
    const [bfApyResult, zestApyResult, balancesResult] = await Promise.allSettled([
      getBitflowApy(),
      getZestApy(),
      getBalances(address),
    ]);
    
    const bfApy = bfApyResult.status === "fulfilled" ? bfApyResult.value : 3.2;
    const zestApy = zestApyResult.status === "fulfilled" ? zestApyResult.value : 2.5;
    const balances = balancesResult.status === "fulfilled" ? balancesResult.value : { stx: 0, sbtc: 0, zest_sbtc: 0, bitflow_lp: 0 };

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
          api_status: {
            bitflow: bfApyResult.status === "fulfilled" ? "live" : "fallback",
            zest: zestApyResult.status === "fulfilled" ? "live" : "fallback"
          }
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
    emitError("STATUS_FAIL", String(e), "Check network and retry");
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
    let bfApy = 3.2;
    try { bfApy = await getBitflowApy(); } catch {}
    
    let zestApy = 2.5;
    try { zestApy = await getZestApy(); } catch {}

    const balances = await getBalances(address);
    const diff = bfApy - zestApy;

    if (diff > (REBALANCE_THRESHOLD_BPS/100)) {
      if (balances.zest_sbtc > 0 || balances.sbtc > 10000) {
        if (!confirm) {
          emit({
            status: "blocked",
            action: "Confirmation required",
            data: { recommendation: "Move to Bitflow", amount_sats: balances.zest_sbtc || balances.sbtc },
            error: null
          });
          return;
        }

        const amount = balances.zest_sbtc > 0 ? balances.zest_sbtc : balances.sbtc;
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
                { type: "uint", value: Math.floor(amount * (1 - SLIPPAGE_TOLERANCE_PCT)).toString() }
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

        const minAmount = Math.floor(balances.bitflow_lp * 0.005); 

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
                      { type: "uint", value: minAmount.toString() },
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
                  params: { asset: "sBTC", amount: "pending" }
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
    emitError("RUN_FAIL", String(e), "Check network and retry");
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-zest-yield-balancer")
  .description("Optimize sBTC yield between Bitflow and Zest Protocol")
  .version("1.1.4");

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
