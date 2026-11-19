// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// M3: broker overhead. Same stub, same workload: (a) direct in-process calls, (b) one worker behind the broker.
const lib = require('./lib.cjs');
const { runLoad } = require('./load.cjs');
const a = lib.parseArgs(process.argv);
const kinds = (a.driver || 'redis,kafka').split(',');
const reps = Number(a.reps || 5), tasks = Number(a.tasks || 200), directTasks = Number(a.direct_tasks || 20000);
const checkTasks = Number(a.check_tasks || 30);

async function directRun(n, latencyMs) {
  const stub = async (p) => { if (latencyMs > 0) await lib.sleep(latencyMs); return 'ok'; };
  const lat = []; const t0 = performance.now();
  for (let i = 0; i < n; i++) { const s = performance.now(); await stub({ taskId: 't' + i, agentId: 'bench-agent', timestamp: 0, data: { seq: i } }); lat.push(performance.now() - s); }
  const wall = performance.now() - t0;
  return { tasks: n, latencyMs, wall_ms: wall, throughput_tps: n / (wall / 1000), lat_p50_ms: lib.percentile(lat, 50), lat_p95_ms: lib.percentile(lat, 95), lat_mean_ms: lat.reduce((x, y) => x + y, 0) / n };
}
(async () => {
  const out = { measurement: 'm3', machine: lib.machineInfo(), params: { kinds, reps, tasks, directTasks, checkTasks }, direct: [], broker: [] };
  for (let rep = 0; rep < reps; rep++) { const r = await directRun(directTasks, 0); r.rep = rep; out.direct.push(r); console.log('direct 0ms', rep, r.throughput_tps.toFixed(0), 't/s mean', r.lat_mean_ms.toFixed(5), 'ms'); }
  for (const kind of kinds) for (const [mode, latencyMs, n] of [['seq', 0, tasks], ['burst', 0, tasks], ['seq', 500, checkTasks]]) for (let rep = 0; rep < reps; rep++) {
    try {
      const r = await runLoad({ kind, workers: 1, latencyMs, tasks: n, seed: 2000 + rep, mode, partitions: 8, tag: `m3-${kind}-${mode}-L${latencyMs}-r${rep}` });
      r.rep = rep; out.broker.push(r);
      console.log(`m3 ${kind} ${mode} L=${latencyMs} rep=${rep} ${r.throughput_tps.toFixed(1)} t/s p50=${r.lat_p50_ms.toFixed(2)} p95=${r.lat_p95_ms.toFixed(2)}`);
    } catch (e) { out.broker.push({ kind, mode, latencyMs, rep, error: String(e && e.stack || e) }); console.log('m3 FAILED', kind, mode, latencyMs, rep, String(e)); }
    lib.writeJson('m3.json', out);
  }
  out.finished_utc = new Date().toISOString(); lib.writeJson('m3.json', out); process.exit(0);
})();
