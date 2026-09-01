#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const probe = argv.includes('--probe');
const test = argv.includes('--test');
const installLaunchd = argv.includes('--install-launchd');
const uninstallLaunchd = argv.includes('--uninstall-launchd');
const MAX_RING_BYTES = 16 * 1024;
const MAX_RING_LINES = 8;
const MAX_RING_LINE_LENGTH = 2_048;
const ERROR_RETRY_MS = 5_000;
const TRANSCRIPT_SCAN_CHUNK_BYTES = 1024 * 1024;
const START_TURN_VERSION = 2;

if (test) {
  const actual = formatDoorbellPrompt([
    'hello',
    'ring\u001b[31m payload',
  ]);
  const expected = '[doorbell] hello\n[doorbell] ring [31m payload';
  if (actual !== expected) fail(`format test failed: ${JSON.stringify(actual)}`);
  if (launchdJob('test') !== 'com.openai.doorbell.test'
    || legacyLaunchdJob('test') !== 'com.openai.file-doorbell.test') fail('launchd job name test failed');
  const start = startTurnParams('thread-1', 'message-1', 'hello');
  if (START_TURN_VERSION !== 2
    || start.turnStart?.request?.threadId !== 'thread-1'
    || start.turnStart.request.clientUserMessageId !== 'message-1'
    || start.turnStart.request.input?.[0]?.text !== 'hello'
    || 'turnStartParams' in start) fail('start-turn v2 payload test failed');
  const lifecycle = lifecycleState([
    '{"type":"event_msg","payload":{"type":"task_started"}}',
    '{"type":"event_msg","payload":{"type":"task_complete"}}',
  ]);
  if (lifecycle !== false) fail(`lifecycle test failed: ${JSON.stringify(lifecycle)}`);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-'));
  const testTranscript = path.join(testDir, 'transcript.jsonl');
  try {
    fs.writeFileSync(testTranscript, `{"type":"event_msg","payload":{"type":"task_complete"}}\n${'filler\n'.repeat(150_000)}`);
    if (readTaskActive(testTranscript) !== false) fail('chunked transcript scan test failed');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  const plist = launchdPlist({ job: 'test', label: 'test', signal: '/tmp/a&b', threadId: 't<1', log: '/tmp/test' });
  if (!plist.includes('/tmp/a&amp;b') || !plist.includes('t&lt;1')) fail('launchd plist escaping test failed');
  console.log('doorbell: codex desktop tests passed');
  process.exit(0);
}

const threadId = process.env.CODEX_THREAD_ID || '';
const signalArg = option('--signal') || process.env.CODEX_DOORBELL_SIGNAL || '';
const label = option('--label') || process.env.CODEX_DOORBELL_LABEL || 'file';
const signal = path.resolve(signalArg);

if (!/^[a-zA-Z0-9._-]+$/.test(label)) fail(`invalid label: ${label}`);
if (uninstallLaunchd) uninstallDesktopLaunchd(label);
if (!threadId) fail('CODEX_THREAD_ID is not set');
if (!signalArg) fail('--signal <path> is required');
if (!fs.existsSync(signal) || !fs.statSync(signal).isFile()) fail(`signal file does not exist: ${signal}`);
const transcript = findTranscript(threadId);
if (!transcript) fail(`transcript not found for ${threadId}`);
if (installLaunchd) installDesktopLaunchd({ label, signal, threadId });

process.title = `doorbell:codex-desktop:${label}`;
if (process.stdout.isTTY) process.stdout.write(`\u001b]0;doorbell: codex desktop: ${label}\u0007`);

if (probe) {
  try {
    await sendDesktopRequest();
    console.log(`doorbell: codex desktop IPC socket found for ${threadId}`);
    process.exit(0);
  } catch (error) {
    fail(message(error));
  }
}

let waking = false;
let wakeScheduled = false;
let stopped = false;
let readOffset = fs.statSync(signal).size;
let partialLine = '';
let transcriptOffset = fs.statSync(transcript).size;
let transcriptPartial = '';
let taskActive = readTaskActive(transcript);
const ringQueue = [];

console.log(`doorbell: armed as ${process.title}`);
console.log(`doorbell: watching ${signal}`);
console.log(`doorbell: codex desktop task lifecycle from ${transcript}`);

fs.watchFile(signal, { interval: 250, persistent: true }, current => {
  if (stopped) return;
  if (current.size < readOffset) {
    readOffset = current.size;
    partialLine = '';
    return;
  }
  if (current.size === readOffset) return;
  ringQueue.push(...readRingLines(current.size));
  if (ringQueue.length > MAX_RING_LINES) {
    ringQueue.splice(0, ringQueue.length - MAX_RING_LINES);
  }
  scheduleWake(50);
});

fs.watchFile(transcript, { interval: 100, persistent: true }, current => {
  if (stopped || current.size === transcriptOffset) return;
  if (current.size < transcriptOffset) {
    transcriptOffset = 0;
    transcriptPartial = '';
  }
  const state = readTranscriptLifecycle(current.size);
  if (state === undefined) return;
  taskActive = state;
  if (!taskActive && ringQueue.length > 0) scheduleWake(100);
});

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function wake() {
  wakeScheduled = false;
  if (stopped || waking || taskActive || ringQueue.length === 0) return;
  waking = true;

  const rings = ringQueue.splice(0, MAX_RING_LINES);
  console.log(`doorbell: ${rings.length} line(s) observed, prompting codex desktop task ${threadId}`);
  let delivered = false;
  try {
    await sendDesktopRequest(
      'thread-follower-start-turn',
      startTurnParams(threadId, randomUUID(), formatDoorbellPrompt(rings)),
      START_TURN_VERSION,
    );
    console.log('doorbell: codex desktop turn accepted');
    delivered = true;
  } catch (error) {
    ringQueue.unshift(...rings);
    console.error(`doorbell: codex desktop wake failed: ${message(error)}`);
  } finally {
    waking = false;
  }
  if (once && delivered) return stop();
  if (ringQueue.length > 0 && !taskActive) scheduleWake(delivered ? 1_000 : ERROR_RETRY_MS);
}

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? '' : argv[index + 1] || '';
}

function scheduleWake(delayMs) {
  if (stopped || waking || wakeScheduled || ringQueue.length === 0) return;
  wakeScheduled = true;
  setTimeout(() => void wake(), delayMs);
}

function readRingLines(currentSize) {
  let start = readOffset;
  const truncated = currentSize - start > MAX_RING_BYTES;
  if (truncated) start = currentSize - MAX_RING_BYTES;
  const length = currentSize - start;
  const buffer = Buffer.alloc(length);
  let file;
  try {
    file = fs.openSync(signal, 'r');
    fs.readSync(file, buffer, 0, length, start);
  } catch (error) {
    console.error(`doorbell: line read failed: ${message(error)}`);
    return [];
  } finally {
    if (file !== undefined) fs.closeSync(file);
    readOffset = currentSize;
  }

  let text = buffer.toString('utf8');
  if (truncated) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    partialLine = '';
  }
  const parts = `${partialLine}${text}`.split('\n');
  partialLine = parts.pop() || '';
  return parts.map(sanitizeRingLine).filter(Boolean).slice(-MAX_RING_LINES);
}

function readTranscriptLifecycle(currentSize) {
  const length = currentSize - transcriptOffset;
  if (length <= 0) return undefined;
  const buffer = Buffer.alloc(length);
  let file;
  try {
    file = fs.openSync(transcript, 'r');
    fs.readSync(file, buffer, 0, length, transcriptOffset);
  } catch (error) {
    console.error(`doorbell: codex desktop transcript read failed: ${message(error)}`);
    return undefined;
  } finally {
    if (file !== undefined) fs.closeSync(file);
    transcriptOffset = currentSize;
  }
  const parts = `${transcriptPartial}${buffer.toString('utf8')}`.split('\n');
  transcriptPartial = parts.pop() || '';
  return lifecycleState(parts);
}

function readTaskActive(filePath) {
  const size = fs.statSync(filePath).size;
  let end = size;
  let partialLine = '';
  while (end > 0) {
    const start = Math.max(0, end - TRANSCRIPT_SCAN_CHUNK_BYTES);
    const lines = `${readBytes(filePath, start, end - start)}${partialLine}`.split('\n');
    partialLine = start > 0 ? lines.shift() || '' : '';
    const state = lifecycleState(lines);
    if (state !== undefined) return state;
    end = start;
  }
  fail(`no task lifecycle event found in ${filePath}`);
}

function lifecycleState(lines) {
  let state;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'event_msg') continue;
      if (event.payload?.type === 'task_started') state = true;
      if (event.payload?.type === 'task_complete' || event.payload?.type === 'task_aborted') state = false;
    } catch {
      // Ignore partial and non-JSON lines.
    }
  }
  return state;
}

function findTranscript(conversationId) {
  const sessions = path.join(os.homedir(), '.codex', 'sessions');
  const suffix = `${conversationId}.jsonl`;
  const pending = [sessions];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
    }
  }
  return '';
}

function readBytes(filePath, start, length) {
  const buffer = Buffer.alloc(length);
  const file = fs.openSync(filePath, 'r');
  try {
    fs.readSync(file, buffer, 0, length, start);
  } finally {
    fs.closeSync(file);
  }
  return buffer.toString('utf8');
}

function formatDoorbellPrompt(lines) {
  return lines
    .map(sanitizeRingLine)
    .filter(Boolean)
    .slice(-MAX_RING_LINES)
    .map(line => `[doorbell] ${line}`)
    .join('\n');
}

function sanitizeRingLine(line) {
  return String(line)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .slice(0, MAX_RING_LINE_LENGTH)
    .trim();
}

function startTurnParams(conversationId, clientUserMessageId, text) {
  return {
    conversationId,
    turnStart: {
      request: {
        threadId: conversationId,
        clientUserMessageId,
        input: [{ type: 'text', text, text_elements: [] }],
      },
    },
  };
}

function installDesktopLaunchd({ label, signal, threadId }) {
  if (process.platform !== 'darwin') fail('--install-launchd requires macOS');
  const job = launchdJob(label);
  const legacyJob = legacyLaunchdJob(label);
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const logDir = path.join(os.homedir(), '.codex', 'logs');
  const plist = path.join(agentsDir, `${job}.plist`);
  const log = path.join(logDir, `${job}.log`);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plist, launchdPlist({ job, label, signal, threadId, log }), { mode: 0o600 });
  runCommand('/usr/bin/plutil', ['-lint', plist]);
  const domain = `gui/${process.getuid()}`;
  const bootout = spawnSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
  if (bootout.status === 0) spawnSync('/bin/sleep', ['0.2']);
  runCommand('launchctl', ['bootstrap', domain, plist]);
  spawnSync('launchctl', ['bootout', `${domain}/${legacyJob}`], { stdio: 'ignore' });
  fs.rmSync(path.join(agentsDir, `${legacyJob}.plist`), { force: true });
  console.log(`doorbell: installed ${job}`);
  console.log(`doorbell: launchd log ${log}`);
  process.exit(0);
}

function uninstallDesktopLaunchd(label) {
  if (process.platform !== 'darwin') fail('--uninstall-launchd requires macOS');
  const job = launchdJob(label);
  const domain = `gui/${process.getuid()}`;
  for (const candidate of [job, legacyLaunchdJob(label)]) {
    spawnSync('launchctl', ['bootout', `${domain}/${candidate}`], { stdio: 'ignore' });
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${candidate}.plist`), { force: true });
  }
  console.log(`doorbell: uninstalled ${job}`);
  process.exit(0);
}

function launchdJob(label) {
  return `com.openai.doorbell.${label}`;
}

function legacyLaunchdJob(label) {
  return `com.openai.file-doorbell.${label}`;
}

function launchdPlist({ job, label, signal, threadId, log }) {
  const adapter = fileURLToPath(import.meta.url);
  const value = text => escapeXml(text);
  const node = executableOnPath('node') || process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${value(job)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${value(node)}</string>
    <string>${value(adapter)}</string>
    <string>--signal</string><string>${value(signal)}</string>
    <string>--label</string><string>${value(label)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CODEX_THREAD_ID</key><string>${value(threadId)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${value(log)}</string>
  <key>StandardErrorPath</key><string>${value(log)}</string>
</dict>
</plist>
`;
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function executableOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail((result.stderr || result.stdout || `${command} ${args[0]} failed`).trim());
}

function stop() {
  if (stopped) return;
  stopped = true;
  fs.unwatchFile(signal);
  fs.unwatchFile(transcript);
  process.exitCode = 0;
}

async function sendDesktopRequest(method, params, version = 1) {
  const socketPath = process.env.CODEX_IPC_SOCKET || (
    process.platform === 'win32'
      ? '\\\\.\\pipe\\codex-ipc'
      : path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock')
  );
  const socket = net.createConnection(socketPath);
  const pendingRequests = new Map();
  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 1 || length > 16 * 1024 * 1024) {
        socket.destroy(new Error(`invalid IPC frame length: ${length}`));
        return;
      }
      if (buffer.length < 4 + length) return;
      const payload = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      if (payload.type !== 'response') continue;
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) continue;
      pendingRequests.delete(payload.requestId);
      clearTimeout(pending.timer);
      pending.resolve(payload);
    }
  });

  const closed = new Promise((_, reject) => {
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('desktop IPC connection closed')));
  });

  const request = (requestMethod, requestParams, version, timeoutMs) => {
    const requestId = randomUUID();
    const payload = {
      type: 'request',
      requestId,
      version,
      method: requestMethod,
      params: requestParams,
      timeoutMs,
    };
    const json = Buffer.from(JSON.stringify(payload));
    const frame = Buffer.allocUnsafe(4 + json.length);
    frame.writeUInt32LE(json.length, 0);
    json.copy(frame, 4);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`${requestMethod} timed out`));
      }, timeoutMs + 1_000);
      pendingRequests.set(requestId, { resolve, reject, timer });
    });
    socket.write(frame);
    return Promise.race([response, closed]);
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const initialized = await request('initialize', { clientType: 'doorbell' }, 0, 5_000);
    assertSuccess(initialized);
    if (!method) return initialized.result;
    const response = await request(method, params, version, 60_000);
    assertSuccess(response);
    return response.result;
  } finally {
    socket.destroy();
  }
}

function assertSuccess(response) {
  if (response.resultType !== 'success') throw new Error(response.error || 'desktop IPC request failed');
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(text) {
  console.error(`doorbell: ${text}`);
  process.exit(1);
}
