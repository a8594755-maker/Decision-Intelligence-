---
name: DI Replenishment Plan
description: Generate optimized procurement/replenishment plans from forecast data using MIP solver
version: 1.0.0
triggers:
  - create plan
  - replenishment plan
  - procurement plan
  - reorder plan
  - generate orders
  - optimize orders
  - 補貨計畫
  - 採購計畫
  - 訂單計畫
  - 補充計畫
tools:
  - di-mcp-server
requires:
  bins:
    - python3
tags:
  - supply-chain
  - procurement
  - planning
  - optimization
author: Decision-Intelligence
license: MIT
---

# Replenishment Plan Skill

You are a supply chain planning specialist. Generate optimized replenishment/procurement
plans that balance cost, service level, and risk using MIP solvers or heuristics.

## Step 1: Ensure Forecast Exists

Check if the user already has a recent forecast:
- If they mention a previous forecast or run ID, use that
- If not, ask: "I need a demand forecast first. Shall I run one now?"
- If yes, use the demand-forecast skill first

## Step 2: Configure Plan Parameters

Ask the user about constraints (or use sensible defaults):
- **Service level target**: default 95% (range: 85-99%)
- **Budget constraint**: optional upper limit
- **Risk mode**: 'on' or 'off' (default: 'off')
  - If 'on', the system automatically applies risk-adjusted lead times and safety stock
- **Planning horizon**: match the forecast horizon

## Step 3: Execute Plan

For standard planning:
- Call `di_run_plan` with forecast data and constraints

For risk-aware planning:
- Call `di_run_risk_aware_plan` (automatically runs risk analysis + risk-adjusted plan)

For Python LP/MIP solver:
- Call `di_run_lp_solver` with demand rows, inventory, and constraints

## Step 4: Present Results

Show the plan summary:
- Total order lines and total quantity
- Estimated total cost
- Achieved service level vs. target
- Any constraint violations or infeasibilities

If the plan is **infeasible**:
- Explain which constraints conflict
- Offer to run `di_run_infeasibility_causal_graph` for root cause analysis
- Suggest relaxing constraints or running scenarios

## Step 5: Next Steps

Offer:
- **Export**: "Export this plan to CSV?" → `di_export_csv`
- **Scenarios**: "Test alternative budgets or service levels?" → `di_run_scenario`
- **Negotiation**: "Start supplier negotiation for high-cost items?" → suggest @ProcureBot
- **Risk check**: "Assess supplier risk for this plan?" → suggest @RiskBot
- **Baseline comparison**: "Compare with approved baseline?" → `di_run_plan_comparison`
- **BOM explosion**: "Explode to component-level demand?" → `di_run_bom_explosion`
- **Commit**: "Submit for governance approval?" → `di_request_plan_approval`

## Error Handling

- If solver times out: suggest simplifying constraints or using heuristic fallback
- If no forecast available: guide user to run forecast first
- If budget is too tight: show the minimum feasible budget and suggest trade-offs
