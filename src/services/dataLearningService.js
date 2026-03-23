/**
 * Data Learning Service — fetches and caches dataset profiles,
 * builds compact prompt digests for LLM system prompts.
 */

const ML_API_BASE = String(import.meta.env.VITE_ML_API_BASE || import.meta.env.VITE_ML_API_URL || 'http://localhost:8000');
const LOCAL_KEY = 'di_data_profile_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// SAP equivalents for context
const SAP_MAP = {
  customers: 'KNA1', orders: 'VBAK', order_items: 'VBAP', payments: 'BSEG',
  reviews: 'QM', products: 'MARA', sellers: 'LFA1', geolocation: 'ADRC',
  category_translation: 'T023T',
};

// ---------------------------------------------------------------------------
// Fetch + Cache
// ---------------------------------------------------------------------------

/**
 * Fetch data profile from the ML API and cache in localStorage.
 * Returns null on failure (non-blocking).
 */
export async function fetchDataProfile(dataset = 'olist') {
  try {
    const resp = await fetch(`${ML_API_BASE}/data-profile?dataset=${dataset}`);
    if (!resp.ok) return getCachedProfile();

    const profile = await resp.json();
    if (!profile.ok) return getCachedProfile();

    // Persist to localStorage
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      profile,
      cachedAt: Date.now(),
    }));
    console.info('[dataLearning] Profile fetched and cached:', profile.table_count, 'tables');
    return profile;
  } catch (err) {
    console.warn('[dataLearning] Failed to fetch profile, using cache:', err.message);
    return getCachedProfile();
  }
}

/**
 * Return cached profile from localStorage, or null if expired/missing.
 */
export function getCachedProfile() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const { profile, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > CACHE_TTL_MS) return null;
    return profile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt Digest (~800 tokens)
// ---------------------------------------------------------------------------

/**
 * Build a STRUCTURE-ONLY profile digest for system prompt injection.
 *
 * Purpose: help the Agent understand table schemas, column types, relationships,
 * and what values look like — so it writes BETTER SQL queries.
 *
 * This digest deliberately EXCLUDES exact statistics (percentages, means, distributions).
 * The Agent must ALWAYS run SQL to get actual numbers.
 */
export function buildProfileDigest(profile) {
  if (!profile?.tables) return '';

  const lines = [];
  const dateRange = profile.date_range
    ? `Data covers: ${profile.date_range.min} to ${profile.date_range.max}.`
    : '';

  lines.push(`${profile.table_count} tables, ~${Math.round((profile.total_rows ?? 0) / 1000)}K total rows. ${dateRange}`);

  // Table + full column schemas
  lines.push('\n**Tables & Columns:**');
  for (const [tname, tinfo] of Object.entries(profile.tables)) {
    const sap = SAP_MAP[tname] || '';
    const sapNote = sap ? ` (SAP: ${sap})` : '';
    lines.push(`\n**${tname}**${sapNote} — ${(tinfo.row_count ?? 0).toLocaleString()} rows`);

    for (const [cname, cinfo] of Object.entries(tinfo.columns || {})) {
      let desc = `  - \`${cname}\` ${cinfo.dtype}`;

      // Semantic type
      if (cinfo.semantic) desc += ` [${cinfo.semantic}]`;

      // Cardinality hint (helps Agent understand what to GROUP BY)
      if (cinfo.cardinality != null) {
        desc += ` — ${cinfo.cardinality} unique`;
      }

      // For low-cardinality categoricals: list possible values (not percentages)
      if (cinfo.top_values && cinfo.cardinality <= 30) {
        const possibleValues = Object.keys(cinfo.top_values).join(', ');
        desc += ` → values: [${possibleValues}]`;
      }

      // Null hint (helps Agent know to use COALESCE or WHERE IS NOT NULL)
      if (cinfo.null_pct > 5) {
        desc += ` ⚠️ ${cinfo.null_pct}% null`;
      }

      lines.push(desc);
    }
  }

  // FK relationships — critical for knowing how to JOIN
  if (profile.relationships?.length > 0) {
    lines.push('\n**JOIN Relationships (FK):**');
    for (const rel of profile.relationships) {
      lines.push(`- ${rel.child}.${rel.column} → ${rel.parent}.${rel.column}`);
    }
  }

  lines.push('\n**IMPORTANT: Always run SQL via query_sap_data to get actual numbers. Never guess or cite cached statistics.**');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// On-demand detail block for specific tables
// ---------------------------------------------------------------------------

/**
 * Build detailed column info for tables mentioned in the user message.
 * Returns empty string if no tables are detected.
 */
export function buildProfilePromptBlock(profile, userMessage = '') {
  if (!profile?.tables || !userMessage) return '';

  const lower = userMessage.toLowerCase();
  const mentionedTables = Object.keys(profile.tables).filter(t => lower.includes(t));
  if (mentionedTables.length === 0) return '';

  const lines = ['\n### Detailed Column Info (for mentioned tables)'];
  for (const tname of mentionedTables) {
    const tinfo = profile.tables[tname];
    lines.push(`\n**${tname}** (${tinfo.row_count?.toLocaleString()} rows)`);
    for (const [cname, cinfo] of Object.entries(tinfo.columns || {})) {
      let detail = `  - \`${cname}\` (${cinfo.dtype})`;
      if (cinfo.null_pct > 0) detail += ` — ${cinfo.null_pct}% null`;
      if (cinfo.cardinality) detail += `, ${cinfo.cardinality} unique`;
      if (cinfo.top_values) {
        const top3 = Object.entries(cinfo.top_values).slice(0, 3).map(([k, v]) => `${k}:${v}%`).join(', ');
        detail += ` [${top3}]`;
      }
      if (cinfo.mean !== undefined) detail += ` [mean=${cinfo.mean}, med=${cinfo.median}]`;
      lines.push(detail);
    }
  }
  return lines.join('\n');
}
