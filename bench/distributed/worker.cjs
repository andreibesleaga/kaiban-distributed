// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// One worker process of one role: AgentActor (library) + a driver + a stub model with fixed latency.
const lib = require('./lib.cjs');
const cfg = JSON.parse(process.env.WORKER_CFG);
const send = (m) => process.send && process.send(m);

async function main() {
  const driver = lib.makeDriver(cfg.driver, { groupId: cfg.groupId, clientId: cfg.workerId, bullmq: cfg.bullmq });
  // Stub model: fixed latency, no randomness, no network. warmup tasks skip the sleep.
  const handler = async (payload) => {
    send({ type: 'start', taskId: payload.taskId, seq: payload.data.seq, t: lib.now(), worker: cfg.workerId });
    if (!payload.data.warmup && cfg.latencyMs > 0) await lib.sleep(cfg.latencyMs);
    send({ type: 'end', taskId: payload.taskId, t: lib.now(), worker: cfg.workerId });
    return 'ok';
  };
  const actor = new lib.AgentActor(cfg.agentId, driver, cfg.queue, handler);
  await actor.start();
  send({ type: 'ready', worker: cfg.workerId });
  const stop = async () => { try { await driver.disconnect(); } catch (_) {} process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => { console.error('worker failed', e); process.exit(1); });
