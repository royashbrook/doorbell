#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

if (argv.includes('--test')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-aliases-'));
  try {
    fs.mkdirSync(path.join(temp, 'doorbell'));
    fs.writeFileSync(path.join(temp, 'doorbell', 'SKILL.md'), 'canonical');
    install(temp);
    install(temp);
    for (const name of ['db', 'ring']) {
      const content = fs.readFileSync(path.join(temp, name, 'SKILL.md'), 'utf8');
      if (!content.includes(`name: ${name}`) || !content.includes('canonical-skill: doorbell')) fail(`${name} alias test failed`);
    }
    fs.mkdirSync(path.join(temp, 'foreign'));
    fs.writeFileSync(path.join(temp, 'foreign', 'SKILL.md'), 'foreign');
    const original = path.join(root, 'aliases', 'db', 'SKILL.md');
    const target = path.join(temp, 'foreign', 'SKILL.md');
    let refused = false;
    try { writeAlias(original, target); } catch { refused = true; }
    if (!refused) fail('foreign skill protection test failed');
    console.log('doorbell: alias installer tests passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  process.exit(0);
}

const skillsDir = option('--skills-dir');
if (!skillsDir) fail('usage: install-aliases.mjs --skills-dir <path>');
install(path.resolve(skillsDir));

function install(directory) {
  const canonical = path.join(directory, 'doorbell', 'SKILL.md');
  if (!fs.existsSync(canonical)) fail(`canonical doorbell skill not found: ${canonical}`);
  for (const name of ['db', 'ring']) {
    const source = path.join(root, 'aliases', name, 'SKILL.md');
    const target = path.join(directory, name, 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAlias(source, target);
    console.log(`doorbell: installed ${name} alias at ${target}`);
  }
}

function writeAlias(source, target) {
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes('canonical-skill: doorbell')) throw new Error(`refusing to replace unrelated skill: ${target}`);
  }
  fs.copyFileSync(source, target);
}

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? '' : argv[index + 1] || '';
}

function fail(message) {
  console.error(`doorbell: ${message}`);
  process.exit(1);
}

