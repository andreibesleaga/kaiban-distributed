// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// M1 (--driver redis) and M2 (--driver kafka): throughput + latency vs number of worker processes.
const lib = require('./lib.cjs');
const { runLoad } = require('./load.cjs');
const a = lib.parseArgs(process.argv);
const kind = a.driver || 'redis';
const Ns = (a.workers || '1,2,4,8').split(',').map(Number);
const lats = (a.latency || '0,500').split(',').map(Number);
const repList = a['rep-list'] ? a['rep-list'].split(',').map(Number) : null;
const reps = Number(a.reps || 5), tasks = Number(a.tasks || 200);
const partitions = Number(a.partitions || 8);
const name = a.name || (kind === 'redis' ? 'm1_redis' : 'm2_kafka') + (partitions !== 8 && kind === 'kafka' ? `_p${partitions}` : '');
(async () => {
  const out = { measurement: name, machine: lib.machineInfo(), params: { kind, Ns, lats, reps: repList ? repList.length : reps, rep_list: repList, tasks, partitions, seed_base: 1000 }, runs: [] };
  for (const latencyMs of lats) for (const workers of Ns) for (const rep of (repList || Array.from({ length: reps }, (_, i) => i))) {
    const seed = 1000 + rep;
    try {
      const r = await runLoad({ kind, workers, latencyMs, tasks, seed, partitions, tag: `${name}-L${latencyMs}-N${workers}-r${rep}` });
      r.rep = rep; r.loadavg_after = require('os').loadavg(); out.runs.push(r);
      console.log(`${name} L=${latencyMs} N=${workers} rep=${rep} ${r.throughput_tps.toFixed(1)} t/s p50=${r.lat_p50_ms.toFixed(1)} p95=${r.lat_p95_ms.toFixed(1)} done=${r.completed}/${tasks} dup=${r.duplicates}`);
    } catch (e) {
      out.runs.push({ kind, workers, latencyMs, rep, seed, error: String(e && e.stack || e) });
      console.log(`${name} L=${latencyMs} N=${workers} rep=${rep} FAILED ${e}`);
    }
    lib.writeJson(name + '.json', out);
  }
  out.finished_utc = new Date().toISOString();
  lib.writeJson(name + '.json', out);
  process.exit(0);
})();
