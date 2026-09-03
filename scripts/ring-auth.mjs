#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const command = argv[0] || '';
const namespace = option('--namespace') || 'doorbell';

if (command === '--test') {
  await test();
  process.exit(0);
}
validateToken(namespace, 'namespace');

if (command === 'watch') {
  const allowedSigners = path.resolve(required('--allowed-signers'));
  const signal = path.resolve(required('--signal'));
  watch({ allowedSigners, signal, namespace, requireSignature: !argv.includes('--allow-unsigned') });
} else if (command === 'sign') {
  const line = readLine();
  const principal = required('--principal');
  const key = path.resolve(required('--key'));
  const signal = optionalPath('--signal');
  process.stdout.write(`${signLine(line, { principal, key, signal, namespace })}\n`);
} else if (command === 'verify') {
  const line = readLine();
  const allowedSigners = path.resolve(required('--allowed-signers'));
  const signal = optionalPath('--signal');
  const verdict = verifyLine(line, { allowedSigners, signal, namespace });
  process.stdout.write(`${verdict.status}\n`);
  process.exitCode = verdict.status === 'bad' ? 1 : 0;
} else if (command === 'present') {
  const line = readLine();
  const allowedSigners = path.resolve(required('--allowed-signers'));
  const signal = optionalPath('--signal');
  const requireSignature = argv.includes('--require-signature');
  process.stdout.write(`${presentLine(line, { allowedSigners, signal, namespace, requireSignature })}\n`);
} else {
  fail('usage: ring-auth.mjs sign|verify|present|watch [options]');
}

function watch({ allowedSigners, signal, namespace, requireSignature }, emit = line => process.stdout.write(`${line}\n`)) {
  requireFile(allowedSigners, 'allowed signers');
  requireFile(signal, 'signal');
  let offset = fs.statSync(signal).size;
  let partial = '';
  process.title = `doorbell:ring-auth:${path.basename(signal)}`;
  fs.watchFile(signal, { interval: 250, persistent: true }, current => {
    if (current.size < offset) {
      offset = current.size;
      partial = '';
      return;
    }
    if (current.size === offset) return;
    let start = offset;
    const truncated = current.size - start > 64 * 1024;
    if (truncated) {
      start = current.size - 64 * 1024;
      partial = '';
    }
    const length = current.size - start;
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(signal, 'r');
    try {
      fs.readSync(handle, buffer, 0, length, start);
    } finally {
      fs.closeSync(handle);
      offset = current.size;
    }
    let text = buffer.toString('utf8');
    if (truncated) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const lines = `${partial}${text}`.split('\n');
    partial = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      emit(presentLine(line, { allowedSigners, signal, namespace, requireSignature }));
    }
  });
  return () => fs.unwatchFile(signal);
}

function signLine(raw, { principal, key, signal, namespace }) {
  validateToken(principal, 'principal');
  const parsed = parseSignature(raw);
  if (parsed.signature) fail('ring already has a final signature field');
  if (field(raw, 'from') !== principal) fail('from field does not match --principal');
  requireFile(key, 'private key');
  const result = spawnSync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', key], {
    input: raw,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  commandSucceeded(result, 'ssh-keygen sign');
  const signature = result.stdout.split(/\r?\n/).filter(value => value && !value.startsWith('-----')).join('');
  if (!/^[A-Za-z0-9+/=]+$/.test(signature)) fail('ssh-keygen returned an invalid signature');

  const id = field(raw, 'id');
  if (signal && id) {
    const proofs = signatureFile(signal);
    try {
      fs.accessSync(proofs, fs.constants.W_OK);
      fs.appendFileSync(proofs, `id:${id} sig:${signature}\n`, { encoding: 'utf8' });
      return `${raw} sig:e1`;
    } catch {
      // Inline is the lossless fallback when a pre-created proof file is unavailable.
    }
  }
  return `${raw} sig:${signature}`;
}

function verifyLine(raw, { allowedSigners, signal, namespace }) {
  requireFile(allowedSigners, 'allowed signers');
  const { canonical, signature } = parseSignature(raw);
  if (!signature) return { status: 'none', canonical };
  const principal = field(canonical, 'from');
  const id = field(canonical, 'id');
  if (!principal || !isToken(principal)) return { status: 'bad', canonical, id };

  let proof = signature;
  if (proof === 'e1') {
    if (!signal || !id) return { status: 'bad', canonical, id };
    proof = findProof(signatureFile(signal), id);
    if (!proof) return { status: 'bad', canonical, id };
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(proof) || proof.length > 8_192) {
    return { status: 'bad', canonical, id };
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-signature-'));
  const signaturePath = path.join(temp, 'signature');
  try {
    const wrapped = `-----BEGIN SSH SIGNATURE-----\n${proof.match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----\n`;
    fs.writeFileSync(signaturePath, wrapped, { mode: 0o600 });
    const result = spawnSync('ssh-keygen', [
      '-Y', 'verify', '-f', allowedSigners, '-I', principal, '-n', namespace, '-s', signaturePath,
    ], {
      input: canonical,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (result.error) fail(`ssh-keygen verify: ${result.error.message}`);
    return { status: result.status === 0 ? 'ok' : 'bad', canonical, id };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function presentLine(raw, options) {
  const verdict = verifyLine(raw, options);
  const id = verdict.id || field(verdict.canonical, 'id') || 'unknown';
  if (verdict.status === 'ok') return `[sig:ok] ${verdict.canonical}`;
  if (verdict.status === 'none' && !options.requireSignature) return `[sig:none] ${verdict.canonical}`;
  return `[sig:bad] id:${id}`;
}

function parseSignature(line) {
  const match = /^(.*) sig:([^\s]+)$/.exec(line);
  return match ? { canonical: match[1], signature: match[2] } : { canonical: line, signature: '' };
}

function field(line, name) {
  const match = new RegExp(`(?:^| )${name}:([^ ]+)`).exec(line);
  return match ? match[1] : '';
}

function findProof(file, id) {
  if (!isToken(id)) return '';
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
  const size = fs.statSync(file).size;
  const length = Math.min(size, 4 * 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(handle);
  }
  let text = buffer.toString('utf8');
  if (length < size) {
    const newline = text.indexOf('\n');
    if (newline === -1) return '';
    text = text.slice(newline + 1);
  }
  const prefix = `id:${id} sig:`;
  const match = text.split(/\r?\n/).reverse().find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function signatureFile(signal) {
  return signal.endsWith('.signal') ? `${signal.slice(0, -7)}.signatures` : `${signal}.signatures`;
}

function readLine() {
  const input = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!input || /[\r\n]/.test(input)) fail('expected exactly one non-empty ring line');
  if (input.length > 16 * 1024) fail('ring line exceeds 16 KiB');
  return input;
}

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? '' : argv[index + 1] || '';
}

function required(name) {
  const value = option(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function optionalPath(name) {
  const value = option(name);
  return value ? path.resolve(value) : '';
}

function validateToken(value, label) {
  if (!isToken(value)) fail(`invalid ${label}`);
}

function isToken(value) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${label} file does not exist: ${file}`);
}

function commandSucceeded(result, label) {
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label}: ${(result.stderr || result.stdout || 'failed').trim()}`);
}

async function test() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-auth-test-'));
  try {
    const key = path.join(temp, 'alice');
    commandSucceeded(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
      encoding: 'utf8', timeout: 5_000,
    }), 'ssh-keygen test key');
    const publicParts = fs.readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    const allowedSigners = path.join(temp, 'allowed_signers');
    fs.writeFileSync(allowedSigners, `alice namespaces="doorbell" ${publicParts}\n`);
    const canonical = 'ping id:rabc123 from:alice topic:discuss sig:formats at:2026-09-03T09:00:00';

    const inline = signLine(canonical, { principal: 'alice', key, signal: '', namespace: 'doorbell' });
    assert(inline.endsWith(' sig:e1') === false, 'inline fallback');
    assert(presentLine(inline, { allowedSigners, signal: '', namespace: 'doorbell', requireSignature: true }) === `[sig:ok] ${canonical}`, 'inline presentation');
    assert(presentLine(inline.replace('discuss', 'tampered'), { allowedSigners, signal: '', namespace: 'doorbell', requireSignature: true }) === '[sig:bad] id:rabc123', 'tampered body hidden');
    assert(presentLine(inline.replace('from:alice', 'from:../../'), { allowedSigners, signal: '', namespace: 'doorbell', requireSignature: true }) === '[sig:bad] id:rabc123', 'invalid principal rejected');

    const signal = path.join(temp, 'alice.signal');
    fs.writeFileSync(signal, '');
    fs.writeFileSync(signatureFile(signal), '');
    const sidecar = signLine(canonical, { principal: 'alice', key, signal, namespace: 'doorbell' });
    assert(sidecar === `${canonical} sig:e1`, 'sidecar marker');
    assert(presentLine(sidecar, { allowedSigners, signal, namespace: 'doorbell', requireSignature: true }) === `[sig:ok] ${canonical}`, 'sidecar presentation');
    assert(presentLine(canonical, { allowedSigners, signal, namespace: 'doorbell', requireSignature: false }) === `[sig:none] ${canonical}`, 'unsigned presentation');
    assert(presentLine(canonical, { allowedSigners, signal, namespace: 'doorbell', requireSignature: true }) === '[sig:bad] id:rabc123', 'unsigned body hidden when required');
    const observed = [];
    const stop = watch({ allowedSigners, signal, namespace: 'doorbell', requireSignature: true }, value => observed.push(value));
    fs.appendFileSync(signal, `${sidecar}\n`);
    await new Promise(resolve => setTimeout(resolve, 750));
    stop();
    assert(observed.length === 1 && observed[0] === `[sig:ok] ${canonical}`, 'watch presents before output');
    console.log('doorbell: ring auth tests passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function assert(condition, label) {
  if (!condition) fail(`test failed: ${label}`);
}

function fail(message) {
  console.error(`doorbell: ${message}`);
  process.exit(1);
}
