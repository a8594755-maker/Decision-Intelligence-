export const ARTIFACT_CONTRACT_VERSION = 'v1';

const V1_VALIDATORS = {
  forecast_series: validateForecastSeries,
  metrics: validateForecastMetrics,
  report_json: validateReportJson,
  forecast_csv: validateCsvArtifact,
  solver_meta: validateSolverMeta,
  constraint_check: validateConstraintCheck,
  plan_table: validatePlanTable,
  replay_metrics: validateReplayMetrics,
  inventory_projection: validateInventoryProjection,
  evidence_pack: validateEvidencePack,
  plan_csv: validateCsvArtifact,
  // What-If scenario comparison artifact (v1 addendum; relaxed — object with required top-level keys)
  scenario_comparison: validateScenarioComparison,
  // Step 9 – Agentic Negotiation Loop v0
  negotiation_options: validateNegotiationOptions,
  negotiation_evaluation: validateNegotiationEvaluation,
  negotiation_report: validateNegotiationReport,
  // Multi-Echelon v0 artifact types
  bom_explosion: validateBomExplosion,
  component_plan_table: validateComponentPlanTable,
  component_plan_csv: validateCsvArtifact,
  component_inventory_projection: validateComponentInventoryProjection,
  bottlenecks: validateBottlenecks,
  // Decision Narrative v1
  decision_narrative: validateDecisionNarrative,
  // Supplier Event Connector v0
  supplier_event_log: validateSupplierEventLog,
  // Phase 3: Proactive Alerts & Risk Deltas
  proactive_alerts: validateProactiveAlerts,
  risk_delta_summary: validateRiskDeltaSummary,
  // Plan Baseline Comparison (approved plan write-back)
  plan_baseline_comparison: validatePlanBaselineComparison,
  // Data Quality Report (data resilience architecture)
  data_quality_report: validateDataQualityReport,
  // CFR Game-Theory Negotiation (v3.0)
  cfr_negotiation_strategy: validateCfrNegotiationStrategy,
  cfr_negotiation_state: validateCfrNegotiationState,
  cfr_negotiation_recommendation: validateCfrNegotiationRecommendation
};

const MAX_ISSUES = 50;
const PLAN_REPORT_ARRAY_FIELDS = ['key_results', 'exceptions', 'recommended_actions'];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const typeOfValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const addIssue = (issues, issue) => {
  if (issues.length >= MAX_ISSUES) return;
  issues.push(issue);
};

const addMissingIssue = (issues, path, message = 'missing required field') => {
  addIssue(issues, {
    kind: 'missing',
    path,
    message
  });
};

const addTypeIssue = (issues, path, expected, value) => {
  addIssue(issues, {
    kind: 'type',
    path,
    expected,
    actual: typeOfValue(value),
    message: `expected ${expected}, received ${typeOfValue(value)}`
  });
};

const requireField = (issues, obj, field, path) => {
  if (!isObject(obj)) {
    addTypeIssue(issues, path, 'object', obj);
    return undefined;
  }

  if (!hasOwn(obj, field)) {
    addMissingIssue(issues, `${path}.${field}`);
    return undefined;
  }

  return obj[field];
};

const requireObjectField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return null;
  if (!isObject(value)) {
    addTypeIssue(issues, `${path}.${field}`, 'object', value);
    return null;
  }
  return value;
};

const requireArrayField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    addTypeIssue(issues, `${path}.${field}`, 'array', value);
    return null;
  }
  return value;
};

const requireBooleanField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    addTypeIssue(issues, `${path}.${field}`, 'boolean', value);
  }
};

const requireNumberField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return;
  if (!isFiniteNumber(value)) {
    addTypeIssue(issues, `${path}.${field}`, 'number', value);
  }
};

const requireStringField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return;
  if (typeof value !== 'string') {
    addTypeIssue(issues, `${path}.${field}`, 'string', value);
  }
};

const requireStringOrNullField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return;
  if (value !== null && typeof value !== 'string') {
    addTypeIssue(issues, `${path}.${field}`, 'string|null', value);
  }
};

const requireNumberOrNullField = (issues, obj, field, path) => {
  const value = requireField(issues, obj, field, path);
  if (value === undefined) return;
  if (value !== null && !isFiniteNumber(value)) {
    addTypeIssue(issues, `${path}.${field}`, 'number|null', value);
  }
};

const ensureObjectPayload = (issues, payload) => {
  if (!isObject(payload)) {
    addTypeIssue(issues, 'payload', 'object', payload);
    return null;
  }
  return payload;
};

function validateForecastSeries(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  const groups = requireArrayField(issues, root, 'groups', 'payload');
  if (!groups) return;

  groups.slice(0, 5).forEach((group, index) => {
    const groupPath = `payload.groups[${index}]`;
    if (!isObject(group)) {
      addTypeIssue(issues, groupPath, 'object', group);
      return;
    }

    const hasSku = hasOwn(group, 'sku');
    const hasMaterialCode = hasOwn(group, 'material_code');
    if (!hasSku && !hasMaterialCode) {
      addMissingIssue(issues, `${groupPath}.sku|material_code`, 'missing required identifier field (sku or material_code)');
    } else {
      if (hasSku && typeof group.sku !== 'string') {
        addTypeIssue(issues, `${groupPath}.sku`, 'string', group.sku);
      }
      if (hasMaterialCode && typeof group.material_code !== 'string') {
        addTypeIssue(issues, `${groupPath}.material_code`, 'string', group.material_code);
      }
    }

    requireStringField(issues, group, 'plant_id', groupPath);
    const points = requireArrayField(issues, group, 'points', groupPath);
    if (!points) return;

    points.slice(0, 5).forEach((point, pointIndex) => {
      const pointPath = `${groupPath}.points[${pointIndex}]`;
      if (!isObject(point)) {
        addTypeIssue(issues, pointPath, 'object', point);
        return;
      }

      const hasTimeBucket = hasOwn(point, 'time_bucket');
      const hasDate = hasOwn(point, 'date');
      if (!hasTimeBucket && !hasDate) {
        addMissingIssue(issues, `${pointPath}.time_bucket|date`, 'point must include time_bucket or date');
      } else {
        if (hasTimeBucket && typeof point.time_bucket !== 'string') {
          addTypeIssue(issues, `${pointPath}.time_bucket`, 'string', point.time_bucket);
        }
        if (hasDate && typeof point.date !== 'string') {
          addTypeIssue(issues, `${pointPath}.date`, 'string', point.date);
        }
      }

      if (!hasOwn(point, 'forecast')) {
        addMissingIssue(issues, `${pointPath}.forecast`);
      } else if (point.forecast !== null && !isFiniteNumber(point.forecast)) {
        addTypeIssue(issues, `${pointPath}.forecast`, 'number|null', point.forecast);
      }
    });
  });
}

function validateForecastMetrics(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'metric_name', 'payload');
  requireNumberOrNullField(issues, root, 'mape', 'payload');
  requireNumberOrNullField(issues, root, 'mae', 'payload');
  requireStringField(issues, root, 'selected_model_global', 'payload');
  requireObjectField(issues, root, 'model_usage', 'payload');
  requireNumberField(issues, root, 'groups_processed', 'payload');
  requireNumberField(issues, root, 'rows_used', 'payload');
  requireNumberField(issues, root, 'dropped_rows', 'payload');
  requireNumberField(issues, root, 'horizon_periods', 'payload');
  requireStringField(issues, root, 'granularity', 'payload');
}

const looksLikePlanReport = (payload) => {
  if (!isObject(payload)) return false;
  if (PLAN_REPORT_ARRAY_FIELDS.some((key) => hasOwn(payload, key)) || hasOwn(payload, 'summary')) {
    return true;
  }
  const stage = String(payload.stage || '').toLowerCase();
  return ['optimize', 'plan', 'verify', 'report'].includes(stage);
};

function validateReportJson(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  if (!looksLikePlanReport(root)) {
    return;
  }

  requireStringField(issues, root, 'summary', 'payload');
  PLAN_REPORT_ARRAY_FIELDS.forEach((field) => {
    const values = requireArrayField(issues, root, field, 'payload');
    if (!values) return;

    values.slice(0, 5).forEach((item, index) => {
      if (typeof item !== 'string') {
        addTypeIssue(issues, `payload.${field}[${index}]`, 'string', item);
      }
    });
  });
}

function validateCsvArtifact(payload, issues) {
  if (typeof payload !== 'string') {
    addTypeIssue(issues, 'payload', 'string', payload);
  }
}

function validateSolverMeta(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'status', 'payload');
  requireObjectField(issues, root, 'kpis', 'payload');
  requireObjectField(issues, root, 'solver_meta', 'payload');
  requireArrayField(issues, root, 'infeasible_reasons', 'payload');
  const proof = requireObjectField(issues, root, 'proof', 'payload');
  if (!proof) return;

  requireArrayField(issues, proof, 'objective_terms', 'payload.proof');
  requireArrayField(issues, proof, 'constraints_checked', 'payload.proof');
}

function validateConstraintCheck(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireBooleanField(issues, root, 'passed', 'payload');
  const violations = requireArrayField(issues, root, 'violations', 'payload');
  if (!violations) return;

  violations.slice(0, 5).forEach((violation, index) => {
    const violationPath = `payload.violations[${index}]`;
    if (!isObject(violation)) {
      addTypeIssue(issues, violationPath, 'object', violation);
      return;
    }

    requireStringField(issues, violation, 'rule', violationPath);
    requireStringField(issues, violation, 'details', violationPath);

    if (hasOwn(violation, 'sku') && violation.sku !== null && typeof violation.sku !== 'string') {
      addTypeIssue(issues, `${violationPath}.sku`, 'string|null', violation.sku);
    }
  });
}

function validatePlanTable(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireNumberField(issues, root, 'total_rows', 'payload');
  const rows = requireArrayField(issues, root, 'rows', 'payload');
  requireBooleanField(issues, root, 'truncated', 'payload');
  if (!rows) return;

  rows.slice(0, 5).forEach((row, index) => {
    const rowPath = `payload.rows[${index}]`;
    if (!isObject(row)) {
      addTypeIssue(issues, rowPath, 'object', row);
      return;
    }

    requireStringField(issues, row, 'sku', rowPath);
    requireStringOrNullField(issues, row, 'plant_id', rowPath);
    requireStringField(issues, row, 'order_date', rowPath);
    requireStringField(issues, row, 'arrival_date', rowPath);
    requireNumberField(issues, row, 'order_qty', rowPath);
  });
}

function validateReplayMetrics(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  const withPlan = requireObjectField(issues, root, 'with_plan', 'payload');
  const withoutPlan = requireObjectField(issues, root, 'without_plan', 'payload');
  const delta = requireObjectField(issues, root, 'delta', 'payload');

  [
    ['with_plan', withPlan],
    ['without_plan', withoutPlan],
    ['delta', delta]
  ].forEach(([name, section]) => {
    if (!section) return;

    ['service_level_proxy', 'stockout_units', 'holding_units'].forEach((metricKey) => {
      if (!hasOwn(section, metricKey)) return;
      const value = section[metricKey];
      if (!isFiniteNumber(value)) {
        addTypeIssue(issues, `payload.${name}.${metricKey}`, 'number', value);
      }
    });
  });
}

function validateInventoryProjection(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireNumberField(issues, root, 'total_rows', 'payload');
  const rows = requireArrayField(issues, root, 'rows', 'payload');
  requireBooleanField(issues, root, 'truncated', 'payload');
  if (!rows) return;

  rows.slice(0, 5).forEach((row, index) => {
    const rowPath = `payload.rows[${index}]`;
    if (!isObject(row)) {
      addTypeIssue(issues, rowPath, 'object', row);
      return;
    }

    requireStringField(issues, row, 'sku', rowPath);
    requireStringOrNullField(issues, row, 'plant_id', rowPath);
    requireStringField(issues, row, 'date', rowPath);
    requireNumberField(issues, row, 'with_plan', rowPath);
    requireNumberField(issues, row, 'without_plan', rowPath);
    requireNumberField(issues, row, 'demand', rowPath);
    requireNumberField(issues, row, 'stockout_units', rowPath);

    if (hasOwn(row, 'inbound_plan') && !isFiniteNumber(row.inbound_plan)) {
      addTypeIssue(issues, `${rowPath}.inbound_plan`, 'number', row.inbound_plan);
    }
    if (hasOwn(row, 'inbound_open_pos') && !isFiniteNumber(row.inbound_open_pos)) {
      addTypeIssue(issues, `${rowPath}.inbound_open_pos`, 'number', row.inbound_open_pos);
    }
  });
}

function validateEvidencePack(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'generated_at', 'payload');

  const runId = requireField(issues, root, 'run_id', 'payload');
  if (runId !== undefined && !isFiniteNumber(runId) && typeof runId !== 'string') {
    addTypeIssue(issues, 'payload.run_id', 'number|string', runId);
  }

  const datasetProfileId = requireField(issues, root, 'dataset_profile_id', 'payload');
  if (datasetProfileId !== undefined && !isFiniteNumber(datasetProfileId) && typeof datasetProfileId !== 'string') {
    addTypeIssue(issues, 'payload.dataset_profile_id', 'number|string', datasetProfileId);
  }

  requireStringField(issues, root, 'solver_status', 'payload');
  requireObjectField(issues, root, 'refs', 'payload');
  requireObjectField(issues, root, 'evidence', 'payload');
}

// scenario_comparison validator (What-If v0 addendum)
function validateScenarioComparison(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  // Required top-level fields
  const runIdField = requireField(issues, root, 'base_run_id', 'payload');
  if (runIdField !== undefined && typeof runIdField !== 'number' && typeof runIdField !== 'string') {
    addTypeIssue(issues, 'payload.base_run_id', 'number|string', runIdField);
  }
  const scenRunIdField = requireField(issues, root, 'scenario_run_id', 'payload');
  if (scenRunIdField !== undefined && typeof scenRunIdField !== 'number' && typeof scenRunIdField !== 'string') {
    addTypeIssue(issues, 'payload.scenario_run_id', 'number|string', scenRunIdField);
  }

  requireObjectField(issues, root, 'overrides', 'payload');
  const kpis = requireObjectField(issues, root, 'kpis', 'payload');
  if (kpis) {
    requireObjectField(issues, kpis, 'base', 'payload.kpis');
    requireObjectField(issues, kpis, 'scenario', 'payload.kpis');
    requireObjectField(issues, kpis, 'delta', 'payload.kpis');
  }
  requireArrayField(issues, root, 'top_changes', 'payload');
  requireArrayField(issues, root, 'notes', 'payload');
}

// ---------------------------------------------------------------------------
// Step 9 – Agentic Negotiation Loop v0 validators
// ---------------------------------------------------------------------------

function validateNegotiationOptions(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'trigger', 'payload');
  requireObjectField(issues, root, 'intent', 'payload');

  const runId = requireField(issues, root, 'base_run_id', 'payload');
  if (runId !== undefined && !isFiniteNumber(runId) && typeof runId !== 'string') {
    addTypeIssue(issues, 'payload.base_run_id', 'number|string', runId);
  }

  const options = requireArrayField(issues, root, 'options', 'payload');
  if (!options) return;

  options.slice(0, 6).forEach((opt, i) => {
    const optPath = `payload.options[${i}]`;
    if (!isObject(opt)) { addTypeIssue(issues, optPath, 'object', opt); return; }
    requireStringField(issues, opt, 'option_id', optPath);
    requireStringField(issues, opt, 'title', optPath);
    requireObjectField(issues, opt, 'overrides', optPath);
    requireObjectField(issues, opt, 'engine_flags', optPath);
    requireArrayField(issues, opt, 'why', optPath);
    requireArrayField(issues, opt, 'evidence_refs', optPath);
  });
}

function validateNegotiationEvaluation(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  const runId = requireField(issues, root, 'base_run_id', 'payload');
  if (runId !== undefined && !isFiniteNumber(runId) && typeof runId !== 'string') {
    addTypeIssue(issues, 'payload.base_run_id', 'number|string', runId);
  }

  requireStringField(issues, root, 'ranking_method', 'payload');

  const ranked = requireArrayField(issues, root, 'ranked_options', 'payload');
  if (!ranked) return;

  ranked.slice(0, 6).forEach((opt, i) => {
    const optPath = `payload.ranked_options[${i}]`;
    if (!isObject(opt)) { addTypeIssue(issues, optPath, 'object', opt); return; }
    requireStringField(issues, opt, 'option_id', optPath);
    requireStringField(issues, opt, 'status', optPath);
    const kpis = requireObjectField(issues, opt, 'kpis', optPath);
    if (kpis) {
      requireObjectField(issues, kpis, 'base', `${optPath}.kpis`);
      requireObjectField(issues, kpis, 'scenario', `${optPath}.kpis`);
      requireObjectField(issues, kpis, 'delta', `${optPath}.kpis`);
    }
    requireObjectField(issues, opt, 'constraints_summary', optPath);
    requireArrayField(issues, opt, 'notes', optPath);
  });
}

function validateNegotiationReport(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'summary', 'payload');
  requireArrayField(issues, root, 'bullet_reasons', 'payload');
  requireArrayField(issues, root, 'evidence_refs', 'payload');

  const runId = requireField(issues, root, 'base_run_id', 'payload');
  if (runId !== undefined && !isFiniteNumber(runId) && typeof runId !== 'string') {
    addTypeIssue(issues, 'payload.base_run_id', 'number|string', runId);
  }
}

function validateBomExplosion(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;
  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireNumberField(issues, root, 'total_rows', 'payload');
  requireBooleanField(issues, root, 'truncated', 'payload');
  const totals = requireObjectField(issues, root, 'totals', 'payload');
  if (totals) {
    requireNumberField(issues, totals, 'num_fg', 'payload.totals');
    requireNumberField(issues, totals, 'num_components', 'payload.totals');
    requireNumberField(issues, totals, 'num_edges', 'payload.totals');
    requireNumberField(issues, totals, 'num_rows', 'payload.totals');
  }
  const reqs = requireArrayField(issues, root, 'requirements', 'payload');
  if (!reqs) return;
  reqs.slice(0, 3).forEach((req, i) => {
    const p = `payload.requirements[${i}]`;
    if (!isObject(req)) { addTypeIssue(issues, p, 'object', req); return; }
    requireStringField(issues, req, 'fg_sku', p);
    requireStringField(issues, req, 'component_sku', p);
    requireNumberField(issues, req, 'qty_required', p);
  });
}

function validateComponentPlanTable(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;
  requireNumberField(issues, root, 'total_rows', 'payload');
  requireBooleanField(issues, root, 'truncated', 'payload');
  const rows = requireArrayField(issues, root, 'rows', 'payload');
  if (!rows) return;
  rows.slice(0, 5).forEach((row, i) => {
    const p = `payload.rows[${i}]`;
    if (!isObject(row)) { addTypeIssue(issues, p, 'object', row); return; }
    requireStringField(issues, row, 'component_sku', p);
    requireStringOrNullField(issues, row, 'plant_id', p);
    requireStringField(issues, row, 'order_date', p);
    requireStringField(issues, row, 'arrival_date', p);
    requireNumberField(issues, row, 'order_qty', p);
  });
}

function validateComponentInventoryProjection(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;
  requireNumberField(issues, root, 'total_rows', 'payload');
  requireBooleanField(issues, root, 'truncated', 'payload');
  const rows = requireArrayField(issues, root, 'rows', 'payload');
  if (!rows) return;
  rows.slice(0, 5).forEach((row, i) => {
    const p = `payload.rows[${i}]`;
    if (!isObject(row)) { addTypeIssue(issues, p, 'object', row); return; }
    requireStringField(issues, row, 'component_sku', p);
    requireStringOrNullField(issues, row, 'plant_id', p);
    requireStringField(issues, row, 'date', p);
    requireNumberField(issues, row, 'on_hand_end', p);
    requireNumberField(issues, row, 'backlog', p);
    requireNumberField(issues, row, 'demand_dependent', p);
    requireNumberField(issues, row, 'inbound_plan', p);
    requireNumberField(issues, row, 'inbound_open_pos', p);
  });
}

function validateDecisionNarrative(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;
  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'solver_status', 'payload');
  requireStringField(issues, root, 'summary_text', 'payload');
  const situation = requireObjectField(issues, root, 'situation', 'payload');
  if (situation) {
    requireStringField(issues, situation, 'text', 'payload.situation');
    requireArrayField(issues, situation, 'evidence_refs', 'payload.situation');
  }
  const driver = requireObjectField(issues, root, 'driver', 'payload');
  if (driver) {
    requireStringField(issues, driver, 'text', 'payload.driver');
    requireStringField(issues, driver, 'category', 'payload.driver');
    requireArrayField(issues, driver, 'evidence_refs', 'payload.driver');
  }
  const recommendation = requireObjectField(issues, root, 'recommendation', 'payload');
  if (recommendation) {
    requireStringField(issues, recommendation, 'text', 'payload.recommendation');
    requireStringField(issues, recommendation, 'action_type', 'payload.recommendation');
    requireArrayField(issues, recommendation, 'evidence_refs', 'payload.recommendation');
  }
  requireArrayField(issues, root, 'constraint_binding_summary', 'payload');
  requireArrayField(issues, root, 'all_evidence_refs', 'payload');
}

function validateBottlenecks(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;
  requireStringField(issues, root, 'generated_at', 'payload');
  requireNumberField(issues, root, 'total_rows', 'payload');
  const rows = requireArrayField(issues, root, 'rows', 'payload');
  if (!rows) return;
  rows.slice(0, 5).forEach((row, i) => {
    const p = `payload.rows[${i}]`;
    if (!isObject(row)) { addTypeIssue(issues, p, 'object', row); return; }
    requireStringField(issues, row, 'component_sku', p);
    requireStringOrNullField(issues, row, 'plant_id', p);
    requireNumberField(issues, row, 'missing_qty', p);
    requireArrayField(issues, row, 'periods_impacted', p);
    requireArrayField(issues, row, 'affected_fg_skus', p);
    requireArrayField(issues, row, 'evidence_refs', p);
  });
}

function validateSupplierEventLog(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireNumberField(issues, root, 'total_events', 'payload');

  const events = requireArrayField(issues, root, 'events', 'payload');
  if (!events) return;

  events.slice(0, 5).forEach((event, i) => {
    const p = `payload.events[${i}]`;
    if (!isObject(event)) { addTypeIssue(issues, p, 'object', event); return; }
    requireStringField(issues, event, 'event_id', p);
    requireStringField(issues, event, 'event_type', p);
    requireStringField(issues, event, 'supplier_id', p);
    requireStringField(issues, event, 'occurred_at', p);
  });
}

function validateProactiveAlerts(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');

  const alerts = requireArrayField(issues, root, 'alerts', 'payload');
  if (!alerts) return;

  alerts.slice(0, 5).forEach((alert, i) => {
    const p = `payload.alerts[${i}]`;
    if (!isObject(alert)) { addTypeIssue(issues, p, 'object', alert); return; }
    requireStringField(issues, alert, 'alert_id', p);
    requireStringField(issues, alert, 'alert_type', p);
    requireStringField(issues, alert, 'severity', p);
    requireStringField(issues, alert, 'material_code', p);
    requireStringField(issues, alert, 'title', p);
    requireNumberField(issues, alert, 'impact_score', p);
  });

  requireObjectField(issues, root, 'summary', 'payload');
}

function validateRiskDeltaSummary(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireNumberField(issues, root, 'total_deltas', 'payload');

  const deltas = requireArrayField(issues, root, 'deltas', 'payload');
  if (!deltas) return;

  deltas.slice(0, 5).forEach((delta, i) => {
    const p = `payload.deltas[${i}]`;
    if (!isObject(delta)) { addTypeIssue(issues, p, 'object', delta); return; }
    requireStringField(issues, delta, 'supplier_id', p);
    requireNumberField(issues, delta, 'risk_score_delta', p);
    requireArrayField(issues, delta, 'evidence_refs', p);
  });
}

function validatePlanBaselineComparison(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireNumberField(issues, root, 'current_run_id', 'payload');

  if (hasOwn(root, 'previous_run_id') && root.previous_run_id !== null) {
    requireNumberField(issues, root, 'previous_run_id', 'payload');
  }

  if (hasOwn(root, 'skus_added')) requireArrayField(issues, root, 'skus_added', 'payload');
  if (hasOwn(root, 'skus_removed')) requireArrayField(issues, root, 'skus_removed', 'payload');
  if (hasOwn(root, 'qty_changes')) requireArrayField(issues, root, 'qty_changes', 'payload');
}

function validateDataQualityReport(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'coverage_level', 'payload');
  requireArrayField(issues, root, 'available_datasets', 'payload');
  requireArrayField(issues, root, 'missing_datasets', 'payload');
  requireArrayField(issues, root, 'fallbacks_used', 'payload');
  requireArrayField(issues, root, 'dataset_fallbacks', 'payload');
}

// ---------------------------------------------------------------------------
// CFR Game-Theory Negotiation v3.0 validators
// ---------------------------------------------------------------------------

function validateCfrNegotiationStrategy(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'scenario_id', 'payload');
  requireNumberField(issues, root, 'buyer_bucket', 'payload');
  requireNumberField(issues, root, 'iterations', 'payload');
  requireNumberField(issues, root, 'exploitability', 'payload');
  requireObjectField(issues, root, 'supplier_priors', 'payload');

  const strategies = requireArrayField(issues, root, 'strategies', 'payload');
  if (!strategies) return;

  strategies.slice(0, 5).forEach((strat, i) => {
    const p = `payload.strategies[${i}]`;
    if (!isObject(strat)) { addTypeIssue(issues, p, 'object', strat); return; }
    requireStringField(issues, strat, 'info_key', p);
    requireNumberField(issues, strat, 'num_actions', p);
    requireArrayField(issues, strat, 'average_strategy', p);
  });
}

function validateCfrNegotiationState(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'negotiation_id', 'payload');
  requireNumberField(issues, root, 'current_round', 'payload');
  requireStringField(issues, root, 'status', 'payload');
  requireArrayField(issues, root, 'action_history', 'payload');
  requireObjectField(issues, root, 'buyer_position', 'payload');
}

function validateCfrNegotiationRecommendation(payload, issues) {
  const root = ensureObjectPayload(issues, payload);
  if (!root) return;

  requireStringField(issues, root, 'version', 'payload');
  requireStringField(issues, root, 'generated_at', 'payload');
  requireStringField(issues, root, 'recommended_action', 'payload');
  requireObjectField(issues, root, 'action_probabilities', 'payload');
  requireNumberField(issues, root, 'expected_value', 'payload');
  requireStringField(issues, root, 'position_strength', 'payload');
  requireArrayField(issues, root, 'evidence_refs', 'payload');
}

const buildValidationErrorMessage = (artifactType, issues) => {
  const missing = issues.filter((issue) => issue.kind === 'missing');
  const typeIssues = issues.filter((issue) => issue.kind === 'type');

  const lines = [
    `Artifact Output Contract ${ARTIFACT_CONTRACT_VERSION} validation failed for artifact_type="${artifactType}".`
  ];

  if (missing.length > 0) {
    lines.push(`Missing fields (${missing.length}): ${missing.slice(0, 8).map((issue) => issue.path).join(', ')}.`);
  }

  if (typeIssues.length > 0) {
    lines.push(`Type violations (${typeIssues.length}): ${typeIssues.slice(0, 8).map((issue) => `${issue.path} expected ${issue.expected} got ${issue.actual}`).join('; ')}.`);
  }

  lines.push('Example violations:');
  issues.slice(0, 8).forEach((issue) => {
    lines.push(`- ${issue.path}: ${issue.message}`);
  });

  return lines.join('\n');
};

export function validateArtifactOrThrow({ artifact_type, payload }) {
  const artifactType = String(artifact_type || '').trim();
  const validator = V1_VALIDATORS[artifactType];

  // Unknown artifact types are intentionally pass-through to preserve compatibility.
  if (!validator) {
    return payload;
  }

  const issues = [];
  validator(payload, issues);

  if (issues.length > 0) {
    const error = new Error(buildValidationErrorMessage(artifactType, issues));
    error.name = 'ArtifactContractValidationError';
    error.artifact_type = artifactType;
    error.contract_version = ARTIFACT_CONTRACT_VERSION;
    error.issues = issues;
    throw error;
  }

  return payload;
}

export default {
  ARTIFACT_CONTRACT_VERSION,
  validateArtifactOrThrow
};
