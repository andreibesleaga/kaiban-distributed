// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Shared helpers for the bench scripts. Plain CommonJS so the built library (dist/) loads as-is.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const BENCH = __dirname;
// Repository root: two directories up from bench/distributed/.
const REPO = path.resolve(BENCH, '..', '..');
const DIST = path.join(REPO, 'dist/src');
const RESULTS = path.join(BENCH, 'results');
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const { AgentActor } = require(path.join(DIST, 'application/actor/AgentActor'));
const { BullMQDriver } = require(path.join(DIST, 'infrastructure/messaging/bullmq-driver'));
const { KafkaDriver } = require(path.join(DIST, 'infrastructure/messaging/kafka-driver'));
const { COMPLETED_CHANNEL } = require(path.join(DIST, 'infrastructure/messaging/channels'));

const REDIS = { host: '127.0.0.1', port: 6379 };
const KAFKA_BROKERS = ['localhost:9092'];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function percentile(xs, p) { // nearest-rank
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
function summarize(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return { n: 0, median: null, min: null, max: null, spread_pct: null };
  const md = median(v), mn = Math.min(...v), mx = Math.max(...v);
  return { n: v.length, median: md, min: mn, max: mx, spread_pct: md ? ((mx - mn) / md) * 100 : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Milliseconds on the machine's monotonic clock. Every process on the machine reads the same clock,
// and wall-clock corrections (NTP, a hypervisor's time sync) do not move it, so a time stamped in a
// worker can be subtracted from one stamped in the client. It is not a date.
const now = () => Number(process.hrtime.bigint()) / 1e6;

function makeDriver(kind, opts = {}) {
  if (kind === 'redis') return new BullMQDriver({ connection: REDIS, ...(opts.bullmq || {}) });
  if (kind === 'kafka') return new KafkaDriver({ brokers: KAFKA_BROKERS, clientId: opts.clientId || 'bench', groupId: opts.groupId });
  throw new Error('unknown driver ' + kind);
}

// --- infrastructure hygiene -------------------------------------------------
async function resetRedis() {
  // FLUSHALL empties whatever Redis answers on the port: refuse unless the caller says it is the bench broker.
  if (process.env.BENCH_ALLOW_FLUSH !== '1') throw new Error('set BENCH_ALLOW_FLUSH=1 to let the harness empty the Redis on 127.0.0.1:6379 (bench broker only)');
  const IORedis = require('ioredis');
  const r = new IORedis(REDIS);
  await r.flushall();
  await r.quit();
}
async function kafkaAdmin() {
  const { Kafka, logLevel } = require('kafkajs');
  const k = new Kafka({ brokers: KAFKA_BROKERS, clientId: 'bench-admin', logLevel: logLevel.NOTHING });
  const admin = k.admin();
  await admin.connect();
  return admin;
}
async function recreateTopic(admin, topic, partitions) {
  const have = await admin.listTopics();
  if (have.includes(topic)) {
    await admin.deleteTopics({ topics: [topic], timeout: 30000 });
    for (let i = 0; i < 100 && (await admin.listTopics()).includes(topic); i++) await sleep(200);
  }
  for (let i = 0; i < 50; i++) {
    try { await admin.createTopics({ topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }], waitForLeaders: true, timeout: 30000 }); return; }
    catch (e) { await sleep(300); }
  }
  throw new Error('could not create topic ' + topic);
}
async function prepareInfra(kind, mailbox, partitions) {
  if (kind === 'redis') { await resetRedis(); return; }
  const admin = await kafkaAdmin();
  await recreateTopic(admin, COMPLETED_CHANNEL, 1);
  await recreateTopic(admin, mailbox, partitions);
  await admin.disconnect();
}
async function dropMailbox(kind, mailbox) {
  if (kind !== 'kafka') return;
  const admin = await kafkaAdmin();
  try { await admin.deleteTopics({ topics: [mailbox], timeout: 30000 }); } catch (_) {}
  await admin.disconnect();
}
async function waitGroupStable(groupId, members, timeoutMs = 60000) {
  const admin = await kafkaAdmin();
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      const d = await admin.describeGroups([groupId]);
      const g = d.groups[0];
      if (g.state === 'Stable' && g.members.length === members) return Date.now() - t0;
      await sleep(250);
    }
    throw new Error(`group ${groupId} not stable with ${members} members`);
  } finally { await admin.disconnect(); }
}

// --- worker processes -------------------------------------------------------
const { fork } = require('child_process');
function spawnWorker(cfg) {
  const child = fork(path.join(BENCH, 'worker.cjs'), [], {
    env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules'), WORKER_CFG: JSON.stringify(cfg) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const w = { id: cfg.workerId, child, ready: null, exited: false, exitAt: null, handlers: [] };
  w.ready = new Promise((resolve, reject) => {
    child.on('message', (m) => { if (m.type === 'ready') resolve(); else w.handlers.forEach((h) => h(m, w)); });
    child.on('exit', () => { w.exited = true; w.exitAt = now(); reject(new Error('worker exited before ready')); });
  });
  w.ready.catch(() => {});
  return w;
}
async function stopWorkers(ws) {
  await Promise.all(ws.map((w) => new Promise((res) => {
    if (w.exited) return res();
    w.child.once('exit', () => res());
    w.child.kill('SIGTERM');
    setTimeout(() => { if (!w.exited) w.child.kill('SIGKILL'); }, 8000);
  })));
}

// --- client: publisher + completion subscriber -------------------------------
// The client uses the same drivers; completions are read from the library's own
// COMPLETED_CHANNEL (what AgentActor publishes to and CompletionRouter reads from).
async function makeClient(kind, runTag) {
  const completions = new Map(); // taskId -> {t:[arrival times]}
  const listeners = [];
  const driver = makeDriver(kind, { groupId: `bench-client-${runTag}`, clientId: 'bench-client' });
  await driver.subscribe(COMPLETED_CHANNEL, async (p) => {
    const t = now();
    const e = completions.get(p.taskId) || { t: [] };
    e.t.push(t); completions.set(p.taskId, e);
    listeners.forEach((l) => l(p.taskId, t));
  });
  return { driver, completions, onCompletion: (f) => listeners.push(f),
    publish: (queue, payload) => driver.publish(queue, payload),
    close: () => driver.disconnect() };
}

function machineInfo() {
  const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const cpus = os.cpus();
  return {
    date_utc: new Date().toISOString(),
    cpu_model: cpus[0].model, cpu_logical_cores: cpus.length,
    ram_gib: +(os.totalmem() / 2 ** 30).toFixed(1),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    wsl: !!process.env.WSL_DISTRO_NAME,
    node: process.version,
    docker: sh('docker version --format "{{.Server.Version}}"'),
    redis: sh('docker exec kaiban-bench-redis-1 redis-server --version'),
    kafka_image: 'confluentinc/cp-kafka:7.6.0 (Apache Kafka 3.6.x), zookeeper cp-zookeeper:7.6.0',
    kafka_version_check: sh('docker exec kaiban-bench-kafka-1 kafka-topics --version'),
    library_version: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
    library_commit: sh(`git -C "${REPO}" rev-parse HEAD`),
    library_dirty: (() => { const s = sh(`git -C "${REPO}" status --porcelain`); return s === null ? null : s.length > 0; })(),
    bullmq: require('bullmq/package.json').version,
    kafkajs: require('kafkajs/package.json').version,
    ioredis: require('ioredis/package.json').version,
  };
}
function writeJson(name, obj) { fs.mkdirSync(RESULTS, { recursive: true }); fs.writeFileSync(path.join(RESULTS, name), JSON.stringify(obj, null, 2) + '\n'); }
function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; o[k] = v; }
  return o;
}
module.exports = { REPO, DIST, BENCH, RESULTS, AgentActor, BullMQDriver, KafkaDriver, COMPLETED_CHANNEL, mulberry32, median, percentile, summarize, sleep, now,
  makeDriver, prepareInfra, dropMailbox, waitGroupStable, spawnWorker, stopWorkers, makeClient, machineInfo, writeJson, parseArgs };
