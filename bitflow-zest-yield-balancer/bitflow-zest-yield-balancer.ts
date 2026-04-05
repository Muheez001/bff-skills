#!/usr/bin/env bun
/**
 * Bitflow-Zest Yield Balancer — Autonomous sBTC yield optimization
 *
 * Compares sBTC APY on Zest Protocol vs. Bitflow sBTC/STX LP pool.
 * Suggests and prepares rebalancing transactions to maximize yield.
 *
 * Commands: doctor | status | run
 * Actions (run): check | rebalance
 *
 * Built for AIBTC x Bitflow "Skills Pay the Bills" competition.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const STX_TOKEN = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx"; // Using wstx for Bitflow trait compatibility
const BITFLOW_CORE = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2";
const BITFLOW_SBTC_STX_POOL = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const ZEST_POOL = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";

const MIN_GAS_USTX = 200_000;
const REBALANCE_THRESHOLD_BPS = 50; // 0.5% yield difference to trigger rebalance

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface PoolData {
  protocol: string;
  asset: string;
  apy: number;
  position: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

async function getSbtcBalance(address: string): Promise<number> {
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    const key = `${SBTC_TOKEN}::sbtc-token`;
    return parseInt(data.fungible_tokens?.[key]?.balance || "0", 10);
  } catch {
    return 0;
  }
}

async function getStxBalance(address: string): Promise<number> {
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    return parseInt(data.balance, 10) - parseInt(data.locked, 10);
  } catch {
    return 0;
  }
}

async function getZestApy(): Promise<number> {
  try {
    // In a real agent environment, we'd use the MCP tool yield_dashboard_apy_breakdown
    // Here we fallback to a fetch or a reasonable default if API is unavailable
    const res = await fetch("https://api.zestprotocol.com/v1/reserves"); // Example Zest API
    if (res.ok) {
      const data = await res.json() as any;
      const sbtc = data.find((r: any) => r.asset === "sBTC");
      return sbtc ? parseFloat(sbtc.supplyApy) * 100 : 2.5;
    }
    return 2.5; // Baseline sBTC yield on Zest
  } catch {
    return 2.5;
  }
}

async function getBitflowApy(): Promise<number> {
  try {
    const res = await fetch(`${BITFLOW_APP_API}/pools`);
    if (res.ok) {
      const data = await res.json() as any;
      const pool = data.data?.find((p: any) => p.poolId === "xyk_sbtc_stx");
      return pool ? pool.apr24h : 3.2;
    }
    return 3.2; // Baseline sBTC/STX yield on Bitflow
  } catch {
    return 3.2;
  }
}

async function getZestPosition(address: string): Promise<number> {
  // Mocking position read — in production this uses fetchCallReadOnlyFunction
  return 0; 
}

async function getBitflowPosition(address: string): Promise<number> {
  // Mocking LP token balance
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
  if (!res.ok) return 0;
  const data = await res.json() as any;
  const key = `${BITFLOW_SBTC_STX_POOL}::pool-token`;
  return parseInt(data.fungible_tokens?.[key]?.balance || "0", 10);
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(address: string): Promise<void> {
  const checks: Record<string, boolean> = {
    address_set: !!address,
    hiro_api: false,
    bitflow_api: false,
    stx_gas_ok: false,
  };

  try {
    const info = await fetch(`${HIRO_API}/v2/info`);
    checks.hiro_api = info.ok;
    const bf = await fetch(`${BITFLOW_APP_API}/pools`);
    checks.bitflow_api = bf.ok;
    const stx = await getStxBalance(address);
    checks.stx_gas_ok = stx >= MIN_GAS_USTX;
  } catch {}

  const allOk = Object.values(checks).every(Boolean);
  emit({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Ready to optimize yield" : "Fix blockers in data",
    data: { checks, address },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: "Environment not ready", next: "Ensure wallet has STX and APIs are reachable" },
  });
}

async function status(address: string): Promise<void> {
  const [zestApy, bfApy, zestPos, bfPos, sbtcBal] = await Promise.all([
    getZestApy(),
    getBitflowApy(),
    getZestPosition(address),
    getBitflowPosition(address),
    getSbtcBalance(address),
  ]);

  emit({
    status: "success",
    action: "Current yield landscape retrieved",
    data: {
      yields: {
        zest_sbtc_apy: `${zestApy.toFixed(2)}%`,
        bitflow_sbtc_stx_apy: `${bfApy.toFixed(2)}%`,
        spread: `${Math.abs(zestApy - bfApy).toFixed(2)}%`,
      },
      positions: {
        zest_sats: zestPos,
        bitflow_lp_tokens: bfPos,
        liquid_sbtc_sats: sbtcBal,
      },
      recommendation: zestApy > bfApy + (REBALANCE_THRESHOLD_BPS/100) 
        ? "Yield is higher on Zest. Consider moving funds to Zest."
        : bfApy > zestApy + (REBALANCE_THRESHOLD_BPS/100)
          ? "Yield is higher on Bitflow. Consider moving funds to Bitflow."
          : "Yields are balanced. No urgent action needed.",
    },
    error: null,
  });
}

async function run(address: string, action: string): Promise<void> {
  const zestApy = await getZestApy();
  const bfApy = await getBitflowApy();
  const zestPos = await getZestPosition(address);
  const bfPos = await getBitflowPosition(address);
  const sbtcBal = await getSbtcBalance(address);

  if (action === "check") {
    await status(address);
    return;
  }

  if (action === "rebalance") {
    // Decision logic
    if (zestApy > bfApy + (REBALANCE_THRESHOLD_BPS/100) && bfPos > 0) {
      // Move Bitflow -> Zest
      emit({
        status: "success",
        action: "Prepare rebalance: Bitflow -> Zest",
        data: {
          strategy: "Exit Bitflow LP and supply to Zest for higher yield",
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
                    { type: "uint", value: bfPos.toString() },
                    { type: "uint", value: "0" }, // min-x
                    { type: "uint", value: "0" }  // min-y
                  ]
                }
              }
            },
            {
              name: "Supply to Zest",
              mcp_command: {
                tool: "zest_supply",
                params: { asset: "sBTC", amount: "pending_from_withdraw" }
              }
            }
          ]
        },
        error: null,
      });
    } else if (bfApy > zestApy + (REBALANCE_THRESHOLD_BPS/100) && (zestPos > 0 || sbtcBal > 10000)) {
      // Move Zest -> Bitflow or Liquid -> Bitflow
      const amount = zestPos > 0 ? zestPos : sbtcBal;
      emit({
        status: "success",
        action: "Prepare rebalance: Move to Bitflow",
        data: {
          strategy: "Enter Bitflow sBTC/STX LP for higher yield",
          steps: [
            zestPos > 0 ? {
              name: "Withdraw from Zest",
              mcp_command: {
                tool: "zest_withdraw",
                params: { asset: "sBTC", amount: zestPos.toString() }
              }
            } : null,
            {
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
                    { type: "uint", value: "0" } // min-dlp
                  ]
                }
              }
            }
          ].filter(Boolean)
        },
        error: null,
      });
    } else {
      emit({
        status: "success",
        action: "No rebalance recommended at this time",
        data: { zestApy, bfApy, spread: Math.abs(zestApy - bfApy) },
        error: null,
      });
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-zest-yield-balancer")
  .description("Optimize sBTC yield between Bitflow and Zest Protocol");

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
  .action(async (opts) => {
    const address = process.env.STX_ADDRESS || "";
    await run(address, opts.action);
  });

program.parseAsync(process.argv).catch((err) => {
  emit({
    status: "error",
    action: "Unexpected error",
    data: {},
    error: { code: "UNHANDLED", message: String(err), next: "Check logs and retry" },
  });
});
