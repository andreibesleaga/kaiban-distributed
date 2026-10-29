#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// CI dependency gate (root lockfile): fail on HIGH/CRITICAL `npm audit` advisories, except the
// ones listed with an unexpired `exp:` date in .trivyignore — the same list the Trivy image scan
// reads, so one file holds every accepted risk. Each entry is explained in SECURITY.md.
//   node scripts/audit-gate.js
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

const BLOCKING = new Set(['high', 'critical']);

/** Advisory ids from .trivyignore text: active (no date, or date >= today) and expired. */
function parseIgnores(text, today) {
  const active = new Set();
  const expired = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [id, ...opts] = line.split(/\s+/);
    const exp = opts.find((o) => o.startsWith('exp:'));
    if (exp && exp.slice(4) < today) expired.push(id);
    else active.add(id);
  }
  return { active, expired };
}

/** Split the HIGH/CRITICAL advisories of an `npm audit --json` report into blocking and waived. */
function evaluate(audit, ignoreText, today) {
  if (!audit || typeof audit.vulnerabilities !== 'object' || audit.vulnerabilities === null) {
    throw new Error('not an npm audit report: ' + JSON.stringify(audit).slice(0, 200));
  }
  const { active, expired } = parseIgnores(ignoreText, today);
  const blocking = new Map();
  const waived = new Map();
  for (const vuln of Object.values(audit.vulnerabilities)) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;   // a string = another package
      const id = String(via.url || '').split('/').pop();
      const line = `${via.name} ${via.range}: ${via.title} (${id}, ${via.severity})`;
      (active.has(id) ? waived : blocking).set(`${id} ${via.name}`, line);
    }
  }
  return { blocking: [...blocking.values()], waived: [...waived.values()], expired };
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let result;
  try {
    const ignores = existsSync('.trivyignore') ? readFileSync('.trivyignore', 'utf8') : '';
    result = evaluate(JSON.parse(run.stdout), ignores, today);
  } catch (e) {
    console.error(`audit gate: ${e.message}\n${run.stderr || ''}`);
    return 1;
  }
  for (const w of result.waived) console.log(`waived (.trivyignore, SECURITY.md): ${w}`);
  for (const id of result.expired) console.log(`expired exception, enforced again: ${id}`);
  if (result.blocking.length) {
    console.error('HIGH/CRITICAL advisories:');
    for (const b of result.blocking) console.error(`  ${b}`);
    return 1;
  }
  console.log(`npm audit: 0 HIGH/CRITICAL outside the documented exceptions (${result.waived.length} waived)`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { parseIgnores, evaluate };
