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

# bitflow-zest-yield-balancer

## What it does
This skill monitors and optimizes sBTC yield by comparing the APY of Zest Protocol's sBTC supply reserve against Bitflow's sBTC/STX XYK liquidity pool. It identifies yield spreads and prepares the necessary transaction sequences to migrate capital to the highest-yielding platform.

## Why agents need it
Agents need this skill to maximize the productivity of their sBTC capital autonomously. Instead of manually checking APYs across different DeFi protocols, an agent can use this skill to programmatically detect and capture yield opportunities, maintaining a "yield-first" allocation strategy.

## Safety notes
- **Writes to chain:** This skill prepares transaction payloads that move funds.
- **Mainnet only:** Uses Stacks mainnet contract identifiers and APIs.
- **Gas fees:** Requires STX for transaction fees on both sides of a rebalance.
- **Slippage:** Liquidity actions on Bitflow are subject to pool ratios and potential slippage.

## Commands

### doctor
Checks environment, API connectivity (Hiro & Bitflow), and wallet gas readiness.
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

# Generate rebalance plan and MCP commands
bun run bitflow-zest-yield-balancer/bitflow-zest-yield-balancer.ts run --action=rebalance
```

## Output contract

All outputs are JSON to stdout.

**Success (status):**
```json
{
  "status": "success",
  "action": "Current yield landscape retrieved",
  "data": {
    "yields": {
      "zest_sbtc_apy": "2.50%",
      "bitflow_sbtc_stx_apy": "3.20%",
      "spread": "0.70%"
    },
    "positions": {
      "zest_sats": 0,
      "bitflow_lp_tokens": 0,
      "liquid_sbtc_sats": 50000
    },
    "recommendation": "Yield is higher on Bitflow. Consider moving funds to Bitflow."
  },
  "error": null
}
```

**Rebalance Plan:**
```json
{
  "status": "success",
  "action": "Prepare rebalance: Move to Bitflow",
  "data": {
    "strategy": "Enter Bitflow sBTC/STX LP for higher yield",
    "steps": [
      {
        "name": "Add Liquidity to Bitflow",
        "mcp_command": {
          "tool": "call_contract",
          "params": {
            "contractAddress": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
            "contractName": "xyk-core-v-1-2",
            "functionName": "add-liquidity",
            "functionArgs": []
          }
        }
      }
    ]
  }
}
```

## Known constraints
- **Bitflow Core:** Uses `xyk-core-v-1-2` for LP actions.
- **Asset Pair:** Specifically targets the sBTC/STX pair.
- **Threshold:** Enforces a 0.5% (50 bps) spread threshold to avoid excessive rebalancing due to minor fluctuations.
