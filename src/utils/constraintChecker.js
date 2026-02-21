function toNumber(value, defaultValue = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function normalizeSku(value) {
  return String(value || '').trim();
}

function buildSkuMap(rows = [], valueKey) {
  const map = new Map();
  rows.forEach((row) => {
    const sku = normalizeSku(row?.sku);
    if (!sku) return;
    const value = toNumber(row?.[valueKey], NaN);
    if (!Number.isFinite(value)) return;
    map.set(sku, Math.max(0, value));
  });
  return map;
}

function buildUnitCostLookup(planRows = [], constraints = {}) {
  const fromConstraints = new Map();
  (constraints?.unit_costs || []).forEach((row) => {
    const sku = normalizeSku(row?.sku);
    const cost = toNumber(row?.unit_cost, NaN);
    if (!sku || !Number.isFinite(cost) || cost < 0) return;
    fromConstraints.set(sku, cost);
  });

  const fromPlan = new Map();
  planRows.forEach((row) => {
    const sku = normalizeSku(row?.sku);
    const cost = toNumber(row?.unit_cost, NaN);
    if (!sku || !Number.isFinite(cost) || cost < 0) return;
    if (!fromPlan.has(sku)) {
      fromPlan.set(sku, cost);
    }
  });

  return {
    lookup: fromConstraints.size > 0 ? fromConstraints : fromPlan,
    source: fromConstraints.size > 0 ? 'constraints.unit_costs' : (fromPlan.size > 0 ? 'plan.unit_cost' : null)
  };
}

/**
 * Deterministic hard gate for plan validity.
 * Input plan rows: [{ sku, plant_id?, order_qty, unit_cost? }]
 * constraints: { moq, pack_size, budget_cap, max_order_qty, unit_costs? }
 */
export function constraintChecker({ plan = [], constraints = {} } = {}) {
  const planRows = Array.isArray(plan) ? plan : [];
  const violations = [];

  const moqMap = buildSkuMap(constraints?.moq || [], 'min_qty');
  const packMap = buildSkuMap(constraints?.pack_size || [], 'pack_qty');
  const maxMap = buildSkuMap(constraints?.max_order_qty || [], 'max_qty');

  planRows.forEach((row) => {
    const sku = normalizeSku(row?.sku);
    const qty = toNumber(row?.order_qty, NaN);

    if (!Number.isFinite(qty)) {
      violations.push({
        rule: 'order_qty_numeric',
        sku,
        details: 'order_qty must be a finite number.'
      });
      return;
    }

    if (qty < 0) {
      violations.push({
        rule: 'order_qty_non_negative',
        sku,
        details: `order_qty=${qty} must be >= 0.`
      });
    }

    const moq = moqMap.get(sku) || 0;
    if (moq > 0 && qty > 0 && qty + 1e-9 < moq) {
      violations.push({
        rule: 'moq',
        sku,
        details: `order_qty=${qty} is below MOQ=${moq}.`
      });
    }

    const pack = packMap.get(sku) || 0;
    if (pack > 1 && qty > 0) {
      const ratio = qty / pack;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
        violations.push({
          rule: 'pack_size_multiple',
          sku,
          details: `order_qty=${qty} is not a multiple of pack_qty=${pack}.`
        });
      }
    }

    const maxQty = maxMap.get(sku) || 0;
    if (maxQty > 0 && qty - maxQty > 1e-9) {
      violations.push({
        rule: 'max_order_qty',
        sku,
        details: `order_qty=${qty} exceeds max_qty=${maxQty}.`
      });
    }
  });

  const budgetCap = constraints?.budget_cap;
  const hasBudgetCap = Number.isFinite(toNumber(budgetCap, NaN));
  if (hasBudgetCap) {
    const numericCap = Math.max(0, toNumber(budgetCap, 0));
    const { lookup: costLookup, source: costSource } = buildUnitCostLookup(planRows, constraints);

    if (costSource) {
      const totalCost = planRows.reduce((sum, row) => {
        const sku = normalizeSku(row?.sku);
        const qty = Math.max(0, toNumber(row?.order_qty, 0));
        const unitCost = costLookup.get(sku) ?? 0;
        return sum + (qty * unitCost);
      }, 0);

      if (totalCost - numericCap > 1e-9) {
        violations.push({
          rule: 'budget_cap',
          sku: '*',
          details: `total_cost=${Number(totalCost.toFixed(6))} exceeds budget_cap=${numericCap} using ${costSource}.`
        });
      }
    }
  }

  violations.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
    return a.details.localeCompare(b.details);
  });

  return {
    passed: violations.length === 0,
    violations
  };
}

export default constraintChecker;
