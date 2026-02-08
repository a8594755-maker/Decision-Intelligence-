# Operational Costs Upload Guide

## Step 1: Prepare Data File
- Use provided template: `templates/operational_costs.csv`
- Required fields:
  - `CostDate` (YYYY-MM-DD)
  - `DirectLaborHours`
  - `DirectLaborRate`
  - `ProductionOutput`
- Optional fields:
  - `IndirectLaborHours`
  - `IndirectLaborRate`
  - `MaterialCost`
  - `OverheadCost`
  - `Notes`

## Step 2: Upload Data
1. Go to Data Upload page
2. Select "🏭 Operational Costs" type
3. Drag and drop your CSV file
4. Map columns (automatic mapping works for template fields)
5. Review validation results
6. Click "Save Data"

## Step 3: Verify Upload
1. Go to Cost Analysis → Operational Cost tab
2. Check latest date appears
3. Verify cost per unit calculation

## Troubleshooting
- **Invalid date format**: Use YYYY-MM-DD
- **Negative cost per unit**: Check production output value
- **Missing data**: Ensure required fields are populated
