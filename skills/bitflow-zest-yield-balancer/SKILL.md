---
name: bitflow-zest-yield-balancer
description: "Autonomous sBTC yield optimizer that balances capital between Bitflow LP and Zest Protocol based on real-time APY spread."
metadata:
  author: "PR1M3"
  author-agent: "Yield Optimizer Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only"
---

# bitflow-zest-yield-balancer (v1.1.0)

## What it does
This skill monitors and optimizes sBTC yield by comparing the APY of Zest Protocol's sBTC supply reserve against Bitflow's sBTC/STX XYK liquidity pool. It identifies yield spreads and prepares the necessary transaction sequences to migrate capital to the highest-yielding platform.

## Why agents need it
Agents need this skill to maximize the productivity of their sBTC capital autonomously. Instead of manually checking APYs across different DeFi protocols, an agent can use this skill to programmatically detect and capture yield opportunities, maintaining a "yield-first" allocation strategy.

## Prerequisites
- **STX_ADDRESS:** Must be set in the environment to check balances and positions.
- **AIBTC MCP Wallet:** Required for transaction signing.

## Safety notes
- **Writes to chain:** This skill prepares transaction payloads that move funds.
- **Confirmation required:** Use the `--confirm` flag to generate executable write commands.
- **Post-conditions:** All generated transactions include strict `PostConditionMode.Deny` with explicit fungible token post-conditions to prevent over-spending or unauthorized drains.
- **Mainnet only:** Uses Stacks mainnet contract identifiers and APIs.
- **Gas fees:** Requires STX for transaction fees on both sides of a rebalance.
- **Slippage:** Liquidity actions include non-zero slippage protection (e.g., `min-dlp` at 95% of expected and minimum `x`/`y` amounts for withdrawals).

## Commands

### doctor
Checks environment readiness, including API connectivity (Hiro & Bitflow), STX gas balance, and presence of `STX_ADDRESS`.
```bash
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts doctor
```

### status
Fetches current APYs from Zest and Bitflow, reports current positions, and calculates the yield spread.
```bash
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts status
```

### run
Core execution engine for rebalancing.
```bash
# Preview recommendation
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts run --action=check

# Request rebalance (blocks for confirmation)
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts run --action=rebalance

# Execute rebalance (generates MCP commands)
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts run --action=rebalance --confirm
```

## Output contract

All outputs are JSON to stdout.

**Success (status):**
```json
{
  "status": "success",
  "action": "Yield landscape retrieved",
  "data": {
    "yields": {
      "zest_sbtc_apy": "2.50%",
      "bitflow_sbtc_stx_apy": "3.20%",
      "spread": "0.70%"
    },
    "positions": {
      "zest_sbtc_sats": 0,
      "bitflow_lp_tokens": 0,
      "liquid_sbtc_sats": 50000
    },
    "recommendation": "Yield is higher on Bitflow. Consider moving funds to Bitflow."
  },
  "error": null
}
```

**Rebalance Plan (with --confirm):**
```json
{
  "status": "success",
  "action": "Rebalance to Bitflow prepared",
  "data": {
    "steps": [
      {
        "name": "Add Liquidity to Bitflow",
        "mcp_command": {
          "tool": "call_contract",
          "params": {
            "contractAddress": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
            "contractName": "xyk-core-v-1-2",
            "functionName": "add-liquidity",
            "functionArgs": [...],
            "postConditions": [...]
          }
        }
      }
    ]
  },
  "error": null
}
```

## Known constraints
- **Bitflow Core:** Uses `xyk-core-v-1-2` for LP actions.
- **Asset Pair:** Specifically targets the sBTC/STX XYK pair.
- **Threshold:** Enforces a 0.5% (50 bps) spread threshold to avoid excessive rebalancing due to minor fluctuations.
