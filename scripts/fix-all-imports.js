#!/usr/bin/env node
/**
 * Comprehensive import path fixer for the services reorganization.
 * Scans ALL JS/JSX files in src/, checks every relative import to services/,
 * and fixes broken paths by looking up where the target file actually lives.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SERVICES_DIR = path.join(ROOT, 'src/services');

// Build a complete lookup: basename → absolute directory
const fileLocationMap = new Map();

function indexDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
      const base = entry.name.replace(/\.(js|jsx)$/, '');
      // Store the directory where this file lives
      if (!fileLocationMap.has(base)) {
        fileLocationMap.set(base, []);
      }
      fileLocationMap.get(base).push(dir);
    }
  }
}

indexDir(SERVICES_DIR);
console.log(`Indexed ${fileLocationMap.size} unique basenames in services/`);

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.includes('node_modules')) {
      results.push(...walkDir(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
      results.push(full);
    }
  }
  return results;
}

function resolveImport(fromDir, importPath) {
  const resolved = path.resolve(fromDir, importPath);
  // Try exact path
  if (fs.existsSync(resolved)) return true;
  // Try with .js
  if (fs.existsSync(resolved + '.js')) return true;
  // Try as directory (index.js)
  if (fs.existsSync(path.join(resolved, 'index.js'))) return true;
  return false;
}

let totalFixed = 0;
const allFiles = walkDir(path.join(ROOT, 'src'));

for (const filePath of allFiles) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;
  const fileDir = path.dirname(filePath);

  // Match all relative imports (static + dynamic)
  content = content.replace(
    /(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'")\n]+)(['")])/g,
    (match, prefix, importPath, endChar) => {
      // Check if this import resolves correctly
      if (resolveImport(fileDir, importPath)) return match;

      // Extract the basename from the import path
      const importBase = path.basename(importPath).replace(/\.js$/, '');

      // Look up where this file actually lives
      const locations = fileLocationMap.get(importBase);
      if (!locations || locations.length === 0) return match;

      // Find the best matching location (prefer the one that's actually a services subdirectory)
      let targetDir = locations[0];
      if (locations.length > 1) {
        // Prefer directories directly under services/
        for (const loc of locations) {
          const relToServices = path.relative(SERVICES_DIR, loc);
          if (!relToServices.includes('/') || relToServices.split('/').length <= 2) {
            targetDir = loc;
            break;
          }
        }
      }

      // Calculate new relative path
      let newRel = path.relative(fileDir, targetDir);
      if (!newRel.startsWith('.')) newRel = './' + newRel;

      const hasJsExt = importPath.endsWith('.js');
      const ext = hasJsExt ? '.js' : '';
      const newPath = `${newRel}/${importBase}${ext}`;

      // Verify the new path resolves
      if (!resolveImport(fileDir, newPath)) {
        console.warn(`  WARN: Cannot resolve fix for ${importPath} in ${filePath}`);
        return match;
      }

      modified = true;
      return `${prefix}${newPath}${endChar}`;
    }
  );

  if (modified) {
    fs.writeFileSync(filePath, content);
    totalFixed++;
    console.log(`  Fixed: ${path.relative(ROOT, filePath)}`);
  }
}

console.log(`\nFixed ${totalFixed} files total`);
