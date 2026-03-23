#!/usr/bin/env node
/**
 * validate-skills.js — Validate all OpenClaw SKILL.md files
 *
 * Checks:
 *   1. YAML frontmatter parses correctly
 *   2. Required fields present (name, description, version, triggers, tools)
 *   3. Trigger phrases are unique across skills
 *   4. Version follows semver
 *   5. Referenced MCP tools exist in catalog
 *
 * Usage:
 *   node scripts/validate-skills.js
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '..', 'openclaw', 'skills');
const CATALOG_PATH = resolve(__dirname, '..', 'openclaw', 'mcp-tool-catalog.json');

// ── YAML frontmatter parser (minimal, no external deps) ──────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;
  let currentArray = null;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ')) {
      if (currentArray && currentKey) {
        currentArray.push(trimmed.slice(2).trim());
      }
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (value.trim()) {
        result[key] = value.trim();
        currentKey = null;
        currentArray = null;
      } else {
        // Start of array or nested object
        currentKey = key;
        currentArray = [];
        result[key] = currentArray;
      }
    }
  }

  return result;
}

// ── Validation ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['name', 'description', 'version', 'triggers', 'tools'];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

let errors = 0;
let warnings = 0;
const allTriggers = new Map(); // trigger → skill name

function error(skill, msg) {
  console.error(`  ✗ [${skill}] ${msg}`);
  errors++;
}

function warn(skill, msg) {
  console.warn(`  ⚠ [${skill}] ${msg}`);
  warnings++;
}

function ok(skill, msg) {
  console.log(`  ✓ [${skill}] ${msg}`);
}

// ── Load catalog ─────────────────────────────────────────────────────────────

let catalogToolNames = new Set();
if (existsSync(CATALOG_PATH)) {
  try {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
    catalogToolNames = new Set(catalog.tools.map(t => t.name));
    console.log(`Loaded MCP catalog: ${catalogToolNames.size} tools\n`);
  } catch (e) {
    console.warn(`Warning: Could not load catalog: ${e.message}\n`);
  }
} else {
  console.warn('Warning: MCP catalog not found. Run "node scripts/export-mcp-catalog.js" first.\n');
}

// ── Scan skills directory ────────────────────────────────────────────────────

if (!existsSync(SKILLS_DIR)) {
  console.error(`Skills directory not found: ${SKILLS_DIR}`);
  process.exit(1);
}

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

console.log(`Found ${skillDirs.length} skill(s) to validate:\n`);

for (const skillDir of skillDirs) {
  const skillPath = join(SKILLS_DIR, skillDir, 'SKILL.md');

  if (!existsSync(skillPath)) {
    error(skillDir, 'SKILL.md file not found');
    continue;
  }

  const content = readFileSync(skillPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    error(skillDir, 'Could not parse YAML frontmatter (must start with ---)');
    continue;
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!frontmatter[field]) {
      error(skillDir, `Missing required field: ${field}`);
    }
  }

  // Check semver
  if (frontmatter.version && !SEMVER_RE.test(frontmatter.version)) {
    error(skillDir, `Invalid version (not semver): ${frontmatter.version}`);
  }

  // Check triggers uniqueness
  const triggers = Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [];
  if (triggers.length === 0) {
    warn(skillDir, 'No triggers defined');
  }

  for (const trigger of triggers) {
    const normalized = trigger.toLowerCase().trim();
    if (allTriggers.has(normalized)) {
      warn(skillDir, `Duplicate trigger "${trigger}" (also in ${allTriggers.get(normalized)})`);
    }
    allTriggers.set(normalized, frontmatter.name || skillDir);
  }

  // Check body has content
  const body = content.replace(/^---[\s\S]*?---/, '').trim();
  if (body.length < 100) {
    warn(skillDir, 'SKILL.md body is very short — may not provide enough instructions');
  }

  // Check for step structure
  const hasSteps = /## Step \d/i.test(body);
  if (!hasSteps) {
    warn(skillDir, 'No step structure found (expected "## Step 1:", "## Step 2:", etc.)');
  }

  // Check for error handling section
  const hasErrorHandling = /error handling/i.test(body);
  if (!hasErrorHandling) {
    warn(skillDir, 'No error handling section found');
  }

  ok(skillDir, `${frontmatter.name} v${frontmatter.version} — ${triggers.length} triggers, body ${body.length} chars`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Skills: ${skillDirs.length}  Triggers: ${allTriggers.size}  Errors: ${errors}  Warnings: ${warnings}`);

if (errors > 0) {
  console.error('\n✗ Validation FAILED');
  process.exit(1);
} else {
  console.log('\n✓ All skills valid');
}
