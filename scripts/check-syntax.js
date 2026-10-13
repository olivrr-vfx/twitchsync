'use strict';

// Lightweight syntax check for all sources (no build step, no linter deps).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

let failed = 0;
for (const file of files) {
  const isModule = file.includes(`${path.sep}renderer${path.sep}`);
  try {
    if (isModule) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file) });
    else execFileSync(process.execPath, ['--check', file]);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${path.relative(process.cwd(), file)}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}
console.log(failed ? `${failed} Datei(en) mit Fehlern` : `✓ ${files.length} Dateien syntaktisch ok`);
process.exit(failed ? 1 : 0);
