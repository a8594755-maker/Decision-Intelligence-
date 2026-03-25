#!/usr/bin/env node
/**
 * Fixes cross-directory ./ imports in src/services/ subdirectories.
 * After reorganization, files that used to be siblings in services/
 * are now in different subdirs. This script rewrites ./X → ../targetDir/X.
 */
import fs from 'fs';
import path from 'path';

const SERVICES_DIR = 'src/services';
const SUBDIRS = [
  'agent-core', 'ai-infra', 'canvas', 'charts', 'chat', 'data-prep',
  'forecast', 'governance', 'infra', 'memory', 'planning', 'risk',
  'sap-erp', 'tasks',
];

// Build mapping: basename (without .js) → subdirectory
const fileToDir = new Map();
for (const dir of SUBDIRS) {
  const fullDir = path.join(SERVICES_DIR, dir);
  if (!fs.existsSync(fullDir)) continue;
  for (const f of fs.readdirSync(fullDir)) {
    if (!f.endsWith('.js')) continue;
    const base = f.replace(/\.js$/, '');
    if (base === 'index') continue;
    fileToDir.set(base, dir);
  }
}

console.log(`Mapped ${fileToDir.size} files`);

// Also map files in existing subdirs (aiEmployee, negotiation, etc.)
const EXISTING_SUBDIRS = ['_archive', 'aiEmployee', 'artifacts', 'closed_loop', 'eventLoop',
  'forecasting', 'hardening', 'kpiMonitor', 'negotiation', 'observability', 'roi', 'supabase', 'topology'];

let totalFixed = 0;

// Process each file in each new subdir
for (const srcDir of SUBDIRS) {
  const srcPath = path.join(SERVICES_DIR, srcDir);
  if (!fs.existsSync(srcPath)) continue;

  for (const fileName of fs.readdirSync(srcPath)) {
    if (!fileName.endsWith('.js')) continue;
    const filePath = path.join(srcPath, fileName);
    let content = fs.readFileSync(filePath, 'utf-8');
    let modified = false;

    // Match: from './something' or from "./something" (with optional .js)
    content = content.replace(
      /from\s+(['"])\.\/([\w.-]+?)(?:\.js)?\1/g,
      (match, quote, importBase) => {
        const targetDir = fileToDir.get(importBase);
        if (!targetDir) return match; // not a services file, keep as-is
        if (targetDir === srcDir) return match; // same directory, keep as-is

        modified = true;
        // Check if original had .js extension
        const hadJs = match.includes('.js' + quote);
        const ext = hadJs ? '.js' : '';
        return `from ${quote}../${targetDir}/${importBase}${ext}${quote}`;
      }
    );

    if (modified) {
      fs.writeFileSync(filePath, content);
      totalFixed++;
    }
  }
}

console.log(`Fixed ${totalFixed} files with cross-directory imports`);
