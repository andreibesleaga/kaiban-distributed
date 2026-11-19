// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// One load run: spawn N worker processes, push `tasks` tasks through the broker, measure.
const lib = require('./lib.cjs');
const AGENT_ID = 'bench-agent';

function words(rng, n) {
  const w = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  return Array.from({ length: n }, () => w[Math.floor(rng() * w.length)]).join(' ');
}

async function runLoad({ kind, workers, latencyMs, tasks, seed, mode = 'burst', partitions = 8, tag }) {
  const runTag = `${tag}-${Date.now().toString(36)}`;
  const queue = `bench-mailbox-${runTag}`;
  const groupId = `bench-workers-${runTag}`;
  await lib.prepareInfra(kind, queue, partitions);
  const client = await lib.makeClient(kind, runTag);
  if (kind === 'kafka') await lib.waitGroupStable(`bench-client-${runTag}`, 1);
  const ws = Array.from({ length: workers }, (_, i) =>
    lib.spawnWorker({ driver: kind, queue, agentId: AGENT_ID, groupId, workerId: `w${i}`, latencyMs }));
  const starts = new Map();
  ws.forEach((w) => w.handlers.push((m) => { if (m.type === 'start') starts.set(m.taskId, m.worker); }));
  try {
    await Promise.all(ws.map((w) => w.ready));
    if (kind === 'kafka') await lib.waitGroupStable(groupId, workers);
    const mk = (id, seq, rng, warmup) => ({ taskId: id, agentId: AGENT_ID, timestamp: Date.now(),
      data: { seq, warmup: !!warmup, instruction: words(rng, 24) } });
    // warm-up (not measured): JIT, connections, partition assignment
    const wrng = lib.mulberry32(seed ^ 0xabc);
    const warmN = 4 * workers + 8;
    for (let i = 0; i < warmN; i++) await client.publish(queue, mk(`${runTag}-warm-${i}`, -1 - i, wrng, true));
    for (let t0 = Date.now(); Date.now() - t0 < 60000; await lib.sleep(20)) {
      let c = 0; for (let i = 0; i < warmN; i++) if (client.completions.has(`${runTag}-warm-${i}`)) c++;
      if (c === warmN) break;
    }
    const rng = lib.mulberry32(seed);
    const ids = Array.from({ length: tasks }, (_, i) => `${runTag}-t${i}`);
    const t0s = new Array(tasks);
    const deadline = 120000 + Math.ceil(tasks / workers) * (latencyMs + 50) * 3;
    const tStart = lib.now();
    let enqueueMs = null;
    if (mode === 'burst') {
      const pubs = ids.map((id, i) => { const p = mk(id, i, rng); t0s[i] = lib.now(); return client.publish(queue, p); });
      await Promise.all(pubs);
      enqueueMs = lib.now() - tStart;
      for (const t = Date.now(); Date.now() - t < deadline && !ids.every((id) => client.completions.has(id)); ) await lib.sleep(5);
    } else { // sequential closed loop: exactly one task in flight
      for (let i = 0; i < tasks; i++) {
        const p = mk(ids[i], i, rng);
        const done = new Promise((res) => { client.onCompletion((id) => { if (id === ids[i]) res(); }); });
        t0s[i] = lib.now(); await client.publish(queue, p); await Promise.race([done, lib.sleep(60000)]);
      }
    }
    await lib.sleep(300); // grace so a late duplicate would be seen
    const done = ids.map((id) => client.completions.get(id)).filter(Boolean);
    const completed = done.length;
    const duplicates = ids.filter((id) => (client.completions.get(id)?.t.length || 0) > 1).length;
    const lat = ids.map((id, i) => client.completions.get(id) ? client.completions.get(id).t[0] - t0s[i] : null).filter((x) => x !== null);
    const last = Math.max(...done.map((e) => e.t[0]));
    const wall = last - tStart;
    const perWorker = {}; ids.forEach((id) => { const w = starts.get(id); if (w) perWorker[w] = (perWorker[w] || 0) + 1; });
    return {
      kind, workers, latencyMs, tasks, seed, mode, partitions: kind === 'kafka' ? partitions : null,
      completed, duplicates, wall_ms: wall, enqueue_ms: enqueueMs,
      throughput_tps: completed / (wall / 1000),
      lat_p50_ms: lib.percentile(lat, 50), lat_p95_ms: lib.percentile(lat, 95), lat_min_ms: Math.min(...lat), lat_max_ms: Math.max(...lat), lat_mean_ms: lat.reduce((a, b) => a + b, 0) / lat.length,
      tasks_per_worker: perWorker,
    };
  } finally {
    await lib.stopWorkers(ws);
    await client.close();
    await lib.dropMailbox(kind, queue);
  }
}
module.exports = { runLoad };
