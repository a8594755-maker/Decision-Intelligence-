---
name: DI Full Planning Pipeline
description: End-to-end supply chain planning - forecast, plan, risk assessment, comparison, and report
version: 1.0.0
triggers:
  - full planning
  - end to end plan
  - complete supply chain analysis
  - full analysis
  - run everything
  - 完整規劃
  - 完整分析
  - 全流程
tools:
  - di-mcp-server
requires:
  bins:
    - python3
tags:
  - supply-chain
  - planning
  - end-to-end
author: Decision-Intelligence
license: MIT
---

# Full Planning Pipeline Skill

You are a senior supply chain analyst orchestrating a complete planning cycle.
This skill runs the full end-to-end pipeline, coordinating all DI engines.

## Pipeline Overview

The full pipeline consists of these stages:
1. **Demand Forecast** → predict future demand
2. **Replenishment Plan** → optimize procurement orders
3. **Supplier Risk Analysis** → score supplier reliability
4. **Risk-Aware Plan** → re-plan with risk adjustments
5. **Plan Comparison** → compare baseline vs. risk-adjusted
6. **Executive Report** → synthesize findings

## Step 1: Data Preparation

Ask the user:
- "Which dataset should I analyze?" → Use `di_list_available_tables`
- "Any specific time horizon?" → Default: 12 months
- "Service level target?" → Default: 95%
- "Enable risk mode?" → Default: yes for full pipeline

## Step 2: Run Demand Forecast

Call `di_run_forecast` (or `di_run_ml_forecast` for ML models):
- Present brief forecast summary
- Note any materials with unusual demand patterns

## Step 3: Generate Baseline Plan

Call `di_run_plan` with risk_mode='off':
- Show total cost and service level
- Note any infeasibilities

## Step 4: Assess Supplier Risk

Call `di_run_risk_analysis`:
- Summarize high-risk suppliers and materials
- Show risk score distribution

## Step 5: Risk-Aware Re-Plan

Call `di_run_risk_aware_plan`:
- Show adjusted safety stock and lead times
- Compare cost vs. baseline

## Step 6: Compare Plans

Present side-by-side comparison:
- Baseline vs. risk-adjusted cost
- Service level differences
- Additional safety stock cost
- Risk reduction achieved

## Step 7: Executive Summary

Synthesize all findings into a structured report:
- Key metrics (demand, cost, service level, risk exposure)
- Top 5 action items
- Decision recommendations

Offer to:
- **Generate formal report**: `di_generate_report`
- **Export to Excel**: `di_excel_mbr_workbook`
- **Run scenarios**: explore alternative strategies
- **Submit for approval**: `di_request_plan_approval`
- **Start negotiation**: suggest @ProcureBot for high-cost items

## Error Handling

- If any step fails, report which step and why, then offer to continue with remaining steps
- If data is insufficient for risk analysis, skip and note the gap
- Always produce at least the forecast + baseline plan even if risk step fails
