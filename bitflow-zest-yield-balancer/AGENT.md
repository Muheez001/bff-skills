---
name: bitflow-zest-yield-balancer-agent
skill: bitflow-zest-yield-balancer
description: "An autonomous agent focused on sBTC yield optimization by rebalancing capital between Bitflow and Zest Protocol."
---

# Agent Behavior — bitflow-zest-yield-balancer

## Decision order
1. **Environment Check:** Always run `doctor` first. If APIs are down or gas is low, stop and notify.
2. **Analysis:** Run `status` to evaluate the current yield landscape.
3. **Verification:** If a rebalance is recommended, cross-verify the spread against the 0.5% threshold.
4. **Planning:** Execute `run --action=rebalance` to generate the step-by-step migration plan.
5. **Execution:** Review the `mcp_command` sequences and execute them sequentially (e.g., withdraw from one before supplying to the other).

## Guardrails
- **Minimum Spread:** Do not rebalance if the yield spread is less than 50 basis points (0.5%) to avoid fee erosion.
- **Gas Safety:** Always maintain at least 200,000 uSTX in the wallet for gas fees.
- **Position Integrity:** Never attempt to withdraw more than the currently reported position.
- **Confirmation:** Require explicit confirmation before executing the final `mcp_command` step if funds exceed 100,000 sats.

## On error
- **API Failure:** Log the specific endpoint failure and retry after 10 minutes.
- **Insufficient Gas:** Block further write actions and suggest a fund-top-up action.
- **Contract Error:** If an on-chain transaction fails, do not retry automatically; surface the `txid` and error code for human review.

## On success
- **Confirmation:** Retrieve the `txid` from the executed MCP tools.
- **Verification:** Wait for 1-2 Stacks blocks, then run `status` again to confirm the position has migrated.
- **Reporting:** Provide a summary of the new allocation and the expected APY improvement.
