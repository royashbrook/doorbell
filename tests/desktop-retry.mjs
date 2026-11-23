// Run with node tests/desktop-retry.mjs. No desktop, signal bus or GUI launcher is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-retry-'));
const id = randomUUID();
const signal = path.join(dir, 'signal');
const sessions = path.join(dir, '.codex', 'sessions');
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + id : path.join(dir, 'ipc.sock');
const ring = 'retry-' + id;
const launches = [], prompts = [], delays = [];
const createConnection = net.createConnection;
let connections = 0;
let listener;

// Shorten only retry sleeps, not IPC timeouts or filesystem polls.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if ([5000, 10000, 20000, 40000, 60000].includes(ms)) {
    delays.push(ms);
    ms = 400;
  }
  return realTimeout(fn, ms, ...args);
};
net.createConnection = (...args) => {
  assert.equal(args[0], endpoint);
  const socket = createConnection(...args);
  if (++connections === 1) socket.once('error', error => {
    if (process.platform !== 'win32') {
      assert.equal(error.code, 'ECONNREFUSED');
      fs.unlinkSync(endpoint);
    }
    fs.appendFileSync(signal, 'later ring\n'.repeat(9));
    listener.listen(endpoint);
  });
  return socket;
};
os.homedir = () => dir;
childProcess.spawnSync = command => { launches.push(command); return { status: 0 }; };
syncBuiltinESMExports();
listener = net.createServer(socket => {
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
      const end = 4 + bytes.readUInt32LE(0);
      const request = JSON.parse(bytes.subarray(4, end));
      bytes = bytes.subarray(end);
      const turn = request.method === 'thread-follower-start-turn';
      if (turn) prompts.push(request.params.turnStart.request.input[0].text);
      const rejected = turn && prompts.length < 6;
      const reply = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId,
        resultType: rejected ? 'error' : 'success', error: rejected ? 'no-client-found' : undefined }));
      const frame = Buffer.alloc(4 + reply.length);
      frame.writeUInt32LE(reply.length);
      reply.copy(frame, 4);
      socket.write(frame);
      if (turn && !rejected) socket.once('close', () => listener.close());
    }
  });
});

const timeout = setTimeout(() => { throw Error('queued ring did not recover'); }, 30_000);
try {
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, id + '.jsonl'), '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
  fs.writeFileSync(signal, '');
  if (process.platform !== 'win32') {
    const stale = net.createServer().listen(endpoint);
    await once(stale, 'listening');
    fs.renameSync(endpoint, endpoint + '.stale');
    await new Promise(resolve => stale.close(resolve));
    fs.renameSync(endpoint + '.stale', endpoint);
  }
  process.env.CODEX_THREAD_ID = id;
  process.env.CODEX_IPC_SOCKET = endpoint;
  process.argv = [process.execPath, 'codex-desktop.mjs', '--once', '--signal', signal];
  const done = once(listener, 'close');
  await import('../scripts/codex-desktop.mjs');
  fs.appendFileSync(signal, ring + '\n');
  await done;
  assert.deepEqual(launches, [], 'a background retry attempted to launch a process');
  assert.equal(connections, 7);
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.deepEqual(prompts, Array(6).fill('[doorbell] ' + ring));
  console.log('doorbell: queued ring recovered without launching a process');
} finally {
  clearTimeout(timeout);
  fs.rmSync(dir, { recursive: true, force: true });
}
