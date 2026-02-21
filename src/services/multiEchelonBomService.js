import { explodeBOM, DEFAULTS as BOM_DEFAULTS } from '../domains/forecast/bomCalculator.js';
import { datasetFingerprintInternals } from '../utils/datasetFingerprint';

const { stableStringify, fnv1a32 } = datasetFingerprintInternals;

export const MULTI_ECHELON_MODES = {
  OFF: 'off',
  BOM_V0: 'bom_v0'
};

const GLOBAL_PLANT_KEY = '__GLOBAL__';
const MAX_REQUIREMENT_ROWS_IN_ARTIFACT = 5000;
const MAX_TRACE_COMPONENTS = 200;
const MAX_TRACE_LINKS_PER_COMPONENT = 8;

const DEFAULT_MAPPING_RULES = Object.freeze({
  trim: true,
  case: 'upper'
});

const DEFAULT_SCOPE = Object.freeze({
  sku_allowlist: [],
  plant_allowlist: []
});

const DEFAULT_LOT_SIZING_MODE = 'moq_pack';

const BOM_EXPLOSION_CACHE = new Map();

const toNumber = (value, fallback = NaN) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const toIsoDay = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const parsed = new Date(raw.length > 10 ? raw : `${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const parseEnvBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};

const safeClone = (value) => {
  try {
    return JSON.parse(stableStringify(value));
  } catch {
    return value;
  }
};

const normalizeCaseMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'lower') return 'lower';
  if (normalized === 'none') return 'none';
  return 'upper';
};

export const normalizeMappingRules = (rules = {}) => ({
  trim: rules?.trim !== false,
  case: normalizeCaseMode(rules?.case || DEFAULT_MAPPING_RULES.case)
});

export const normalizeSkuKey = (value, rules = DEFAULT_MAPPING_RULES) => {
  const normalizedRules = normalizeMappingRules(rules);
  let text = String(value || '');
  if (normalizedRules.trim) text = text.trim();
  if (!text) return '';
  if (normalizedRules.case === 'upper') return text.toUpperCase();
  if (normalizedRules.case === 'lower') return text.toLowerCase();
  return text;
};

const normalizePlantKey = (value, rules = DEFAULT_MAPPING_RULES) => {
  const skuLike = normalizeSkuKey(value, rules);
  return skuLike || GLOBAL_PLANT_KEY;
};

const denormalizePlantKey = (value) => {
  const normalized = String(value || '').trim();
  return normalized && normalized !== GLOBAL_PLANT_KEY ? normalized : null;
};

const normalizeScope = (scope = {}, rules = DEFAULT_MAPPING_RULES) => {
  const skuAllow = Array.isArray(scope?.sku_allowlist)
    ? scope.sku_allowlist.map((sku) => normalizeSkuKey(sku, rules)).filter(Boolean)
    : [];

  const plantAllow = Array.isArray(scope?.plant_allowlist)
    ? scope.plant_allowlist.map((plant) => normalizePlantKey(plant, rules)).filter(Boolean)
    : [];

  return {
    sku_allowlist: Array.from(new Set(skuAllow)).sort((a, b) => a.localeCompare(b)),
    plant_allowlist: Array.from(new Set(plantAllow)).sort((a, b) => a.localeCompare(b))
  };
};

const normalizeMode = (rawMode) => {
  const mode = String(rawMode || '').trim().toLowerCase();
  return mode === MULTI_ECHELON_MODES.BOM_V0
    ? MULTI_ECHELON_MODES.BOM_V0
    : MULTI_ECHELON_MODES.OFF;
};

export const resolveMultiEchelonConfig = ({ planSettings = {}, env = {} } = {}) => {
  const nested = planSettings?.multi_echelon || {};

  const explicitMode = normalizeMode(
    planSettings?.multi_echelon_mode
      || planSettings?.multiEchelonMode
      || nested?.mode
  );

  const envEnabled = parseEnvBoolean(
    env?.VITE_DI_MULTI_ECHELON
      ?? env?.DI_MULTI_ECHELON,
    false
  );

  const mode = explicitMode !== MULTI_ECHELON_MODES.OFF
    ? explicitMode
    : (envEnabled ? MULTI_ECHELON_MODES.BOM_V0 : MULTI_ECHELON_MODES.OFF);

  const mappingRules = normalizeMappingRules(
    nested?.mapping_rules || planSettings?.mapping_rules || DEFAULT_MAPPING_RULES
  );

  const maxDepthCandidate = toNumber(
    nested?.max_bom_depth ?? planSettings?.max_bom_depth,
    NaN
  );

  const maxDepth = Number.isFinite(maxDepthCandidate) && maxDepthCandidate > 0
    ? Math.floor(maxDepthCandidate)
    : BOM_DEFAULTS.MAX_BOM_DEPTH;

  const scope = normalizeScope(
    nested?.fg_to_components_scope || planSettings?.fg_to_components_scope || DEFAULT_SCOPE,
    mappingRules
  );

  const lotSizingModeRaw = String(
    nested?.lot_sizing_mode || planSettings?.lot_sizing_mode || DEFAULT_LOT_SIZING_MODE
  ).trim();

  return {
    mode,
    max_bom_depth: maxDepth,
    fg_to_components_scope: scope,
    lot_sizing_mode: lotSizingModeRaw || DEFAULT_LOT_SIZING_MODE,
    mapping_rules: mappingRules,
    requested_by_env: explicitMode === MULTI_ECHELON_MODES.OFF && envEnabled
  };
};

const normalizeBomEdges = (bomEdges = [], mappingRules = DEFAULT_MAPPING_RULES) => {
  return (Array.isArray(bomEdges) ? bomEdges : [])
    .map((edge, index) => {
      const parent = normalizeSkuKey(edge?.parent_material, mappingRules);
      const child = normalizeSkuKey(edge?.child_material, mappingRules);
      const qtyPer = toNumber(edge?.qty_per, NaN);
      if (!parent || !child || !Number.isFinite(qtyPer) || qtyPer <= 0) {
        return null;
      }

      const validFrom = toIsoDay(edge?.valid_from);
      const validTo = toIsoDay(edge?.valid_to);

      const row = {
        id: edge?.id || `bom_edge_${index + 1}`,
        parent_material: parent,
        child_material: child,
        qty_per: Number(qtyPer),
        plant_id: denormalizePlantKey(normalizePlantKey(edge?.plant_id, mappingRules)),
        valid_from: validFrom,
        valid_to: validTo,
        scrap_rate: Number.isFinite(toNumber(edge?.scrap_rate, NaN)) ? Number(edge.scrap_rate) : undefined,
        yield_rate: Number.isFinite(toNumber(edge?.yield_rate, NaN)) ? Number(edge.yield_rate) : undefined,
        priority: Number.isFinite(toNumber(edge?.priority, NaN)) ? Number(edge.priority) : undefined,
        created_at: toIsoDay(edge?.created_at)
      };

      return row;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.parent_material !== b.parent_material) return a.parent_material.localeCompare(b.parent_material);
      if (a.child_material !== b.child_material) return a.child_material.localeCompare(b.child_material);
      if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
      if ((a.valid_from || '') !== (b.valid_from || '')) return (a.valid_from || '').localeCompare(b.valid_from || '');
      if ((a.valid_to || '') !== (b.valid_to || '')) return (a.valid_to || '').localeCompare(b.valid_to || '');
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
};

const normalizeFgDemandSeries = ({ demandSeries = [], config }) => {
  const mappingRules = config?.mapping_rules || DEFAULT_MAPPING_RULES;
  const scope = config?.fg_to_components_scope || DEFAULT_SCOPE;
  const skuAllow = new Set(scope.sku_allowlist || []);
  const plantAllow = new Set(scope.plant_allowlist || []);

  return (Array.isArray(demandSeries) ? demandSeries : [])
    .map((row, index) => {
      const sku = normalizeSkuKey(row?.sku, mappingRules);
      if (!sku) return null;

      const plantKey = normalizePlantKey(row?.plant_id, mappingRules);
      const date = toIsoDay(row?.date);
      const qty = Math.max(0, toNumber(row?.p50, 0));

      if (!date || qty <= 0) return null;
      if (skuAllow.size > 0 && !skuAllow.has(sku)) return null;
      if (plantAllow.size > 0 && !plantAllow.has(plantKey)) return null;

      return {
        id: `fg_${index + 1}`,
        material_code: sku,
        plant_id: plantKey,
        time_bucket: date,
        demand_qty: Number(qty),
        source_type: 'forecast_series',
        source_id: `${sku}|${plantKey}|${date}`
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.material_code !== b.material_code) return a.material_code.localeCompare(b.material_code);
      if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
      return (a.time_bucket || '').localeCompare(b.time_bucket || '');
    });
};

const normalizePath = (path = [], mappingRules = DEFAULT_MAPPING_RULES) => {
  return (Array.isArray(path) ? path : [])
    .map((material) => normalizeSkuKey(material, mappingRules))
    .filter(Boolean);
};

const buildRequirements = ({ traceRows = [], mappingRules = DEFAULT_MAPPING_RULES }) => {
  return (Array.isArray(traceRows) ? traceRows : [])
    .map((trace) => {
      const fgSku = normalizeSkuKey(trace?.fg_material_code, mappingRules);
      const componentSku = normalizeSkuKey(trace?.component_material_code, mappingRules);
      const date = toIsoDay(trace?.time_bucket);
      const plant = denormalizePlantKey(normalizePlantKey(trace?.plant_id, mappingRules));
      const qtyRequired = toNumber(trace?.component_qty, NaN);
      const fgQty = toNumber(trace?.fg_qty, NaN);
      const usageCandidate = toNumber(trace?.qty_multiplier, NaN);

      if (!fgSku || !componentSku || !date || !Number.isFinite(qtyRequired)) return null;

      const usageQty = Number.isFinite(usageCandidate)
        ? usageCandidate
        : (Number.isFinite(fgQty) && fgQty > 0 ? qtyRequired / fgQty : 0);

      const path = normalizePath(trace?.path, mappingRules);

      return {
        fg_sku: fgSku,
        component_sku: componentSku,
        plant_id: plant,
        date,
        qty_required: Number(qtyRequired),
        bom_path: path,
        level: Number.isFinite(toNumber(trace?.bom_level, NaN)) ? Math.max(1, Math.floor(Number(trace.bom_level))) : path.length,
        usage_qty: Number.isFinite(usageQty) ? Number(usageQty) : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.fg_sku !== b.fg_sku) return a.fg_sku.localeCompare(b.fg_sku);
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.level !== b.level) return a.level - b.level;
      return a.bom_path.join('>').localeCompare(b.bom_path.join('>'));
    });
};

const buildUsageRows = (requirements = []) => {
  const byPath = new Map();

  requirements.forEach((row) => {
    const plant = row.plant_id || '';
    const pathKey = row.bom_path.join('>');
    const key = `${row.fg_sku}|${row.component_sku}|${plant}|${pathKey}`;
    const existing = byPath.get(key);
    const usageQty = Math.max(0, toNumber(row.usage_qty, 0));

    if (!existing) {
      byPath.set(key, {
        fg_sku: row.fg_sku,
        component_sku: row.component_sku,
        plant_id: row.plant_id || null,
        usage_qty: usageQty,
        level: Number.isFinite(toNumber(row.level, NaN)) ? Number(row.level) : null,
        bom_path: row.bom_path
      });
      return;
    }

    if (usageQty > existing.usage_qty) existing.usage_qty = usageQty;
    if (Number.isFinite(existing.level) && Number.isFinite(toNumber(row.level, NaN))) {
      existing.level = Math.min(existing.level, Number(row.level));
    }
  });

  const byPair = new Map();
  Array.from(byPath.values()).forEach((row) => {
    const pairKey = `${row.fg_sku}|${row.component_sku}|${row.plant_id || ''}`;
    if (!byPair.has(pairKey)) {
      byPair.set(pairKey, {
        fg_sku: row.fg_sku,
        component_sku: row.component_sku,
        plant_id: row.plant_id || null,
        usage_qty: 0,
        level: row.level,
        path_count: 0
      });
    }

    const pair = byPair.get(pairKey);
    pair.usage_qty = Number(pair.usage_qty + row.usage_qty);
    pair.path_count += 1;
    if (Number.isFinite(toNumber(row.level, NaN))) {
      if (!Number.isFinite(toNumber(pair.level, NaN))) {
        pair.level = Number(row.level);
      } else {
        pair.level = Math.min(Number(pair.level), Number(row.level));
      }
    }
  });

  return Array.from(byPair.values())
    .map((row) => ({
      ...row,
      usage_qty: Number(Number(row.usage_qty).toFixed(6))
    }))
    .sort((a, b) => {
      if (a.fg_sku !== b.fg_sku) return a.fg_sku.localeCompare(b.fg_sku);
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      return (a.plant_id || '').localeCompare(b.plant_id || '');
    });
};

const buildTraceIndex = (requirements = []) => {
  const componentMap = new Map();

  requirements.forEach((row) => {
    const key = `${row.component_sku}|${row.plant_id || ''}`;
    if (!componentMap.has(key)) {
      componentMap.set(key, {
        component_sku: row.component_sku,
        plant_id: row.plant_id || null,
        total_qty_required: 0,
        levels: new Set(),
        fg_skus: new Set(),
        periods: new Set()
      });
    }

    const bucket = componentMap.get(key);
    bucket.total_qty_required += Math.max(0, toNumber(row.qty_required, 0));
    bucket.fg_skus.add(row.fg_sku);
    bucket.periods.add(row.date);
    if (Number.isFinite(toNumber(row.level, NaN))) bucket.levels.add(Number(row.level));
  });

  const components = Array.from(componentMap.values())
    .map((bucket) => ({
      component_sku: bucket.component_sku,
      plant_id: bucket.plant_id,
      total_qty_required: Number(bucket.total_qty_required.toFixed(6)),
      min_level: bucket.levels.size > 0 ? Math.min(...Array.from(bucket.levels)) : null,
      fg_skus: Array.from(bucket.fg_skus).sort((a, b) => a.localeCompare(b)).slice(0, MAX_TRACE_LINKS_PER_COMPONENT),
      periods: Array.from(bucket.periods).sort((a, b) => a.localeCompare(b)).slice(0, MAX_TRACE_LINKS_PER_COMPONENT)
    }))
    .sort((a, b) => {
      if (b.total_qty_required !== a.total_qty_required) return b.total_qty_required - a.total_qty_required;
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      return (a.plant_id || '').localeCompare(b.plant_id || '');
    })
    .slice(0, MAX_TRACE_COMPONENTS);

  return {
    components,
    total_components: componentMap.size
  };
};

const buildExplosionCacheKey = ({
  datasetFingerprint,
  config,
  fgDemands,
  bomEdges
}) => {
  const signature = {
    dataset_fingerprint: String(datasetFingerprint || 'no_fingerprint'),
    mode: config?.mode || MULTI_ECHELON_MODES.OFF,
    max_bom_depth: config?.max_bom_depth || BOM_DEFAULTS.MAX_BOM_DEPTH,
    lot_sizing_mode: config?.lot_sizing_mode || DEFAULT_LOT_SIZING_MODE,
    fg_to_components_scope: config?.fg_to_components_scope || DEFAULT_SCOPE,
    mapping_rules: config?.mapping_rules || DEFAULT_MAPPING_RULES,
    fg_demands: (fgDemands || []).map((row) => [
      row.material_code,
      row.plant_id,
      row.time_bucket,
      Number(row.demand_qty || 0)
    ]),
    bom_edges: (bomEdges || []).map((edge) => [
      edge.parent_material,
      edge.child_material,
      edge.plant_id || '',
      Number(edge.qty_per || 0),
      edge.valid_from || '',
      edge.valid_to || ''
    ])
  };

  return `bomv0_${fnv1a32(stableStringify(signature))}`;
};

export const explodeBomForRun = ({
  datasetFingerprint,
  demandSeries = [],
  bomEdges = [],
  config = {}
} = {}) => {
  const effectiveConfig = {
    ...resolveMultiEchelonConfig({ planSettings: config, env: {} }),
    ...(config || {})
  };

  if (effectiveConfig.mode !== MULTI_ECHELON_MODES.BOM_V0) {
    return {
      used: false,
      reused: false,
      cache_key: null,
      config: effectiveConfig,
      bom_edges: [],
      requirements: [],
      usage_rows: [],
      artifact: null,
      errors: []
    };
  }

  const normalizedBomEdges = normalizeBomEdges(bomEdges, effectiveConfig.mapping_rules);
  const fgDemands = normalizeFgDemandSeries({
    demandSeries,
    config: effectiveConfig
  });

  if (normalizedBomEdges.length === 0 || fgDemands.length === 0) {
    return {
      used: false,
      reused: false,
      cache_key: null,
      config: effectiveConfig,
      bom_edges: normalizedBomEdges,
      requirements: [],
      usage_rows: [],
      artifact: {
        version: 'v0',
        generated_at: new Date().toISOString(),
        max_depth: effectiveConfig.max_bom_depth,
        totals: {
          num_fg: fgDemands.length,
          num_components: 0,
          num_edges: normalizedBomEdges.length,
          num_rows: 0
        },
        total_rows: 0,
        truncated: false,
        requirements: [],
        trace_index: {
          components: [],
          total_components: 0
        }
      },
      errors: []
    };
  }

  const cacheKey = buildExplosionCacheKey({
    datasetFingerprint,
    config: effectiveConfig,
    fgDemands,
    bomEdges: normalizedBomEdges
  });

  if (BOM_EXPLOSION_CACHE.has(cacheKey)) {
    const cached = safeClone(BOM_EXPLOSION_CACHE.get(cacheKey));
    return {
      ...cached,
      reused: true
    };
  }

  const exploded = explodeBOM(fgDemands, normalizedBomEdges, {
    maxDepth: effectiveConfig.max_bom_depth
  });

  const requirements = buildRequirements({
    traceRows: exploded?.traceRows || [],
    mappingRules: effectiveConfig.mapping_rules
  });

  const usageRows = buildUsageRows(requirements);
  const traceIndex = buildTraceIndex(requirements);

  const uniqueFg = new Set(requirements.map((row) => row.fg_sku));
  const uniqueComponents = new Set(requirements.map((row) => row.component_sku));

  const artifactRequirements = requirements.slice(0, MAX_REQUIREMENT_ROWS_IN_ARTIFACT);
  const artifact = {
    version: 'v0',
    generated_at: new Date().toISOString(),
    max_depth: effectiveConfig.max_bom_depth,
    totals: {
      num_fg: uniqueFg.size,
      num_components: uniqueComponents.size,
      num_edges: normalizedBomEdges.length,
      num_rows: requirements.length
    },
    total_rows: requirements.length,
    truncated: requirements.length > MAX_REQUIREMENT_ROWS_IN_ARTIFACT,
    requirements: artifactRequirements,
    trace_index: traceIndex
  };

  const result = {
    used: true,
    reused: false,
    cache_key: cacheKey,
    config: effectiveConfig,
    bom_edges: normalizedBomEdges,
    requirements,
    usage_rows: usageRows,
    artifact,
    errors: Array.isArray(exploded?.errors) ? exploded.errors : []
  };

  BOM_EXPLOSION_CACHE.set(cacheKey, safeClone(result));
  return result;
};

export const clearBomExplosionCache = () => {
  BOM_EXPLOSION_CACHE.clear();
};

export const getBomExplosionCacheSize = () => BOM_EXPLOSION_CACHE.size;

export default {
  MULTI_ECHELON_MODES,
  normalizeMappingRules,
  normalizeSkuKey,
  resolveMultiEchelonConfig,
  explodeBomForRun,
  clearBomExplosionCache,
  getBomExplosionCacheSize
};
