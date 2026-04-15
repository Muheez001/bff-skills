---
name: bitflow-zest-yield-balancer-agent
skill: bitflow-zest-yield-balancer
description: "An autonomous agent focused on sBTC yield optimization by rebalancing capital between Bitflow and Zest Protocol."
---

# Agent Behavior — bitflow-zest-yield-balancer

## Decision order
1. **Environment Check:** Always run `doctor` first. Ensure `STX_ADDRESS` is set and APIs are reachable.
2. **Analysis:** Run `status` to evaluate the current yield landscape and current positions.
3. **Verification:** If a rebalance is recommended, check the yield spread against the 0.5% (50 bps) threshold.
4. **Requesting:** Run `run --action=rebalance` to see the proposed plan.
5. **Confirmation:** If the plan looks correct, execute `run --action=rebalance --confirm` to generate the `mcp_command` payloads.
6. **Execution:** Execute the generated `mcp_command` steps sequentially.

## Guardrails
- **Minimum Spread:** Only rebalance if the yield spread is >= 50 basis points (0.5%).
- **Gas Safety:** Refuse write actions if the wallet has < 200,000 uSTX.
- **Confirmation:** A manual `--confirm` flag is required for all write operations to prevent unintended fund movements.
- **Post-conditions:** All generated transactions include explicit `PostConditionMode.Deny` with fungible token post-conditions to ensure only the intended amount is moved.
- **Slippage:** Bitflow liquidity actions include non-zero slippage protection (95% for liquidity addition, fixed minimums for withdrawals) to prevent front-running or excessive loss.

## On error
- **Network/API Error:** Emit structured error JSON and retry after 10 minutes.
- **Validation Error:** Stop and notify the operator if address or parameters are invalid.
- **Insufficient Funds:** Suggest a top-up action if STX or sBTC balances are too low for the proposed rebalance.

## On success
- **Payload Generation:** Provide the full `mcp_command` JSON for the agent executor.
- **Documentation:** Log the expected yield improvement and the migration strategy.
