// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Builds RESULTS.md from results/*.json. Every number in the tables is read from those files.
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, 'results');
const load = (n) => { const p = path.join(R, n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const f = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : Number(x).toFixed(d);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const stat = (xs) => { const v = xs.filter((x) => x != null); const m = med(v); return { n: v.length, m, lo: Math.min(...v), hi: Math.max(...v), spread: m ? (Math.max(...v) - Math.min(...v)) / m * 100 : null }; };
const cell = (s, d = 1) => s.n ? `${f(s.m, d)} (${f(s.lo, d)}–${f(s.hi, d)})${s.spread > 20 ? ' *' : ''}` : 'n/a';
const out = [];
const w = (s = '') => out.push(s);

function loadTable(file, title, optional) {
  const d = load(file);
  if (!d && optional) return;
  if (!d) { w(`### ${title}\n\nNot run (no \`results/${file}\`).\n`); return; }
  w(`### ${title}`); w();
  w(`Source: \`results/${file}\`. ${d.params.tasks} tasks per run, ${d.params.reps} repetitions per cell (cell = median (min–max)). \`*\` marks a spread (max−min)/median above 20 %.`); w();
  for (const L of d.params.lats) {
    w(`Stub model latency ${L} ms:`); w();
    w('| Workers | Throughput (tasks/s) | Speed-up vs N=1 (medians) | Latency p50 (ms) | Latency p95 (ms) | Runs ok / duplicates |');
    w('|---|---|---|---|---|---|');
    let base = null;
    for (const N of d.params.Ns) {
      const runs = d.runs.filter((r) => r.latencyMs === L && r.workers === N);
      const ok = runs.filter((r) => !r.error);
      const tp = stat(ok.map((r) => r.throughput_tps)); if (N === d.params.Ns[0]) base = tp.m;
      const incomplete = ok.filter((r) => r.completed !== r.tasks).length;
      w(`| ${N} | ${cell(tp)} | ${base && tp.m ? f(tp.m / base, 2) + 'x' : 'n/a'} | ${cell(stat(ok.map((r) => r.lat_p50_ms)))} | ${cell(stat(ok.map((r) => r.lat_p95_ms)))} | ${ok.length}/${runs.length} ok, ${ok.reduce((a, r) => a + r.duplicates, 0)} duplicated tasks, ${incomplete} incomplete runs |`);
    }
    w();
  }
  w('Latency is publish-call to completion-event on the client, with all tasks submitted at once (burst), so it includes queue waiting time.'); w();
}

function m3(file, heading) {
  const d = load(file); w(heading); w();
  if (!d) { w('Not run.\n'); return; }
  const dir = d.direct;
  const dLat = stat(dir.map((r) => r.lat_mean_ms)), dTp = stat(dir.map((r) => r.throughput_tps));
  w(`Source: \`results/${file}\`. Stub model latency 0 ms. Direct: ${d.params.directTasks} sequential in-process calls of the same stub handler, ${d.params.reps} repetitions. Broker: one worker process, ${d.params.tasks} tasks, ${d.params.reps} repetitions; "sequential" = one task in flight (client waits for each completion), "burst" = all submitted at once. Cells are median (min–max); \`*\` = spread above 20 %.`); w();
  w('| Path | Per-task latency, mean (ms) | Per-task latency p50 (ms) | Throughput (tasks/s) |'); w('|---|---|---|---|');
  w(`| Direct call (no broker) | ${cell(dLat, 5)} | ${cell(stat(dir.map((r) => r.lat_p50_ms)), 5)} | ${cell(dTp, 0)} |`);
  const rows = {};
  for (const kind of d.params.kinds) {
    const seq = d.broker.filter((r) => !r.error && r.kind === kind && r.mode === 'seq' && r.latencyMs === 0);
    const bur = d.broker.filter((r) => !r.error && r.kind === kind && r.mode === 'burst' && r.latencyMs === 0);
    const sL = stat(seq.map((r) => r.lat_p50_ms)), sM = stat(seq.map((r) => r.lat_mean_ms)), bT = stat(bur.map((r) => r.throughput_tps)), sT = stat(seq.map((r) => r.throughput_tps));
    rows[kind] = { sL, sM, bT, sT };
    w(`| ${kind === 'redis' ? 'Redis' : 'Kafka'}, 1 worker, sequential | ${cell(sM, 2)} | ${cell(sL, 2)} | ${cell(sT, 1)} |`);
    w(`| ${kind === 'redis' ? 'Redis' : 'Kafka'}, 1 worker, burst | – | – | ${cell(bT, 1)} |`);
  }
  w(); w('Derived (computed from the medians above; "added latency" = broker sequential p50 − direct p50):'); w();
  w('| Driver | Added latency per task (ms) | Throughput ratio, broker burst / direct | Overhead share if model call = 500 ms | = 5 s |'); w('|---|---|---|---|---|');
  const dP50 = med(dir.map((r) => r.lat_p50_ms));
  for (const kind of d.params.kinds) {
    const r = rows[kind]; const add = r.sL.m - dP50;
    const share = (L) => f(add / (add + L) * 100, 2) + ' %';
    w(`| ${kind === 'redis' ? 'Redis' : 'Kafka'} | ${f(add, 2)} | ${r.bT.m ? f(r.bT.m / dTp.m, 6) : 'n/a'} (${f(dTp.m / r.bT.m, 0)}x slower) | ${share(500)} | ${share(5000)} |`);
  }
  w(); w('Measured check at a 500 ms stub (sequential, one worker):'); w();
  w('| Driver | Tasks x reps | Per-task latency p50 (ms), median (min–max) | Latency − 500 ms (ms) | Measured overhead share |'); w('|---|---|---|---|---|');
  for (const kind of d.params.kinds) {
    const c = d.broker.filter((r) => !r.error && r.kind === kind && r.mode === 'seq' && r.latencyMs === 500);
    const s = stat(c.map((r) => r.lat_p50_ms)); if (!s.n) { w(`| ${kind} | n/a | n/a | n/a | n/a |`); continue; }
    w(`| ${kind === 'redis' ? 'Redis' : 'Kafka'} | ${d.params.checkTasks} x ${c.length} | ${cell(s, 2)} | ${f(s.m - 500, 2)} | ${f((s.m - 500) / s.m * 100, 2)} % |`);
  }
  w();
}

function m4() {
  w('## M4. Crash recovery (kill -9 of a worker in the middle of a task)'); w();
  const files = [['m4_redis_default.json', 'Redis (BullMQ), library defaults'], ['m4_redis_short.json', 'Redis (BullMQ), shortened lock/stall settings'], ['m4_kafka_default.json', 'Kafka (KafkaJS), library defaults']];
  w('Two workers on one queue; each trial submits 3 tasks and kills (SIGKILL, from the harness) the worker that runs the seeded k-th task, 300 ms into its 1000 ms stub call. The replacement worker starts only after the trial, so the victim can only be taken over by the surviving worker. "Executed" counts a start of the stub handler; "re-executed" is a victim whose handler started twice (the killed attempt plus the retry). Times are in ms from the kill. `*` = spread above 20 %.'); w();
  w('| Setting | Crashes | Tasks completed / lost | Duplicate completion events | Victims re-executed | Victim run to the end twice | Other tasks run to the end twice | Kill → picked up (ms) | Kill → completed (ms) |');
  w('|---|---|---|---|---|---|---|---|---|');
  const sets = [];
  for (const [fn, label] of files) {
    const d = load(fn); if (!d) { w(`| ${label} | not run | | | | | | | |`); continue; }
    const t = d.totals; const p = stat(d.trials.map((x) => x.kill_to_pickup_ms)), c = stat(d.trials.map((x) => x.kill_to_done_ms));
    sets.push([label, d.settings_in_force, fn]);
    if (!t) { w(`| ${label} | ${d.trials.length} (run incomplete) | | | | | | ${cell(p, 0)} | ${cell(c, 0)} |`); continue; }
    w(`| ${label} | ${t.crashes_injected} | ${t.completed} / ${t.lost} of ${t.tasks_submitted} | ${t.tasks_with_duplicate_completion_event} | ${t.victims_re_executed} | ${t.victim_executed_to_end_twice} | ${t.non_victim_tasks_executed_to_end_twice} | ${cell(p, 0)} | ${cell(c, 0)} |`);
  }
  w(); w('Settings in force (copied from the result files):'); w();
  for (const [label, s, fn] of sets) w(`- ${label} (\`results/${fn}\`): \`${JSON.stringify(s)}\``);
  w();
  w('The Kafka driver does not expose session timeout, heartbeat or rebalance timeout (it builds `kafka.consumer({ groupId })`), so no shorter Kafka setting was run.'); w();
}

const m1 = load('m1_redis.json');
w('# Results'); w();
w('All numbers below are generated by `make-results.cjs` from the files in `results/`. Nothing is typed by hand.'); w();
const mach = (m1 || load('m3.json') || {}).machine;
w('## Setup'); w();
if (mach) {
  w(`Single machine, loopback network. CPU ${mach.cpu_model}, ${mach.cpu_logical_cores} logical cores; ${mach.ram_gib} GiB RAM; ${mach.os}${mach.wsl ? ' (WSL2)' : ''}; Node ${mach.node}; Docker ${mach.docker}. Broker containers: ${mach.redis}; Kafka ${mach.kafka_image} (\`kafka-topics --version\`: ${mach.kafka_version_check}), one broker, Zookeeper, replication factor 1; no per-container CPU limits. Library: kaiban-distributed ${mach.library_version}, commit ${mach.library_commit}, working tree has uncommitted changes: ${mach.library_dirty === null ? 'unknown' : mach.library_dirty ? 'yes' : 'no'}, built \`dist/\`, with BullMQ ${mach.bullmq}, KafkaJS ${mach.kafkajs}, ioredis ${mach.ioredis}. Measured ${mach.date_utc.slice(0, 10)} (start of the first run recorded in \`results/\`).`);
  w(); w('Each worker is a separate Node process running the library\'s own `AgentActor` over the library\'s own `BullMQDriver` or `KafkaDriver`; the model is a stub that sleeps a fixed time (no network, no LLM). The client process publishes with the same driver and reads completions from the library\'s completed channel. Seeds are fixed (task payloads and crash order are derived from them); timings are not reproducible to the microsecond.'); w();
}
loadTable('m1_redis.json', 'M1. Redis driver, throughput and latency vs number of workers');
loadTable('m2_kafka.json', 'M2. Kafka driver, same workload (topic with 8 partitions)');
loadTable('m2_kafka_L0_rerun.json', 'M2c. Kafka driver, 0 ms stub, repeated (unstable first pass repeated, same seeds)', true);
loadTable('m2_kafka_p4.json', 'M2b. Kafka driver, N=8 with 4 partitions (the repository compose default)');
m3('m3.json', '## M3. Broker overhead (one process, direct calls, versus one worker behind the broker)');
m4();
// What the result files say about the completed-events topic (Kafka runs only).
function completedTopicNote() {
  const base = 'The completed-events topic (`kaiban-events-completed`, fixed in the library) is shared by all Kafka runs. The task topic has 8 partitions (4 in M2b); with the repository compose default of 4 partitions, at most 4 Kafka workers of one role consume at a time.';
  const counts = new Set(); let unrecorded = 0;
  for (const f of ['m2_kafka.json', 'm2_kafka_p4.json', 'm2_kafka_L0_rerun.json']) {
    const d = load(f); if (!d) continue;
    for (const r of d.runs) { if (r.completed_partitions == null) unrecorded++; else counts.add(r.completed_partitions); }
  }
  if (unrecorded > 0) return base + ' These result files were recorded before the harness stored that topic\'s partition count. The harness version that produced them asked for one partition and deleted and re-created the topic before every run; on a fresh broker the first Kafka run had 1 partition, and from the second run on the broker re-created the topic with its default of 8 (checked afterwards with the same code and compose file). The harness now creates the topic once with 8 partitions and records the count in every run.';
  return base + ' Its partition count is recorded in every run: ' + [...counts].sort().join(', ') + '.';
}
w('## What these numbers do and do not show'); w();
for (const s of [
  'Single machine, loopback network, one broker instance for each driver. Network latency, broker replication and multi-node effects are absent; real deployments add at least a network round trip per hop.',
  'The model is a stub with a fixed latency. Real LLM latency varies by orders of magnitude and has a long tail, so the absolute numbers say nothing about end-to-end agent quality or about provider behaviour.',
  'Worker processes, the client and the brokers share the same logical cores; with N=8 workers plus the client, CPU contention may limit the 0 ms results. The 0 ms numbers are a ceiling for this machine, not a capacity figure.',
  'Throughput is measured with a burst of 200 tasks, so latency p50/p95 in M1/M2 include queue waiting; they are not unloaded service latencies (those are in M3, sequential).',
  'Each worker runs one task at a time (the library default for both drivers); N counts processes, not concurrent tasks per process.',
  'Latency is taken on the client from the publish call to the arrival of the completion event, so it includes both broker hops (task queue and completed channel).',
  'M3 compares broker execution with a bare function call. A direct call is the lower bound and says nothing about what the application would otherwise need (retries, isolation, scaling).',
  'The 5 s overhead share in M3 is computed from the measured overhead; only the 500 ms share has a measured check.',
  'M4 kills only a worker process, with a fixed 300 ms delay into the task; it does not cover broker failure, network partitions or simultaneous crashes. Recovery time is dominated by the broker-side detection settings recorded with the results, not by the library code. The Kafka session timeout is not configurable through the driver, so no shorter Kafka setting was run.',
  'M4 counts executions of the stub handler. A task re-run after a crash is a repeated side effect in a real agent (at-least-once delivery); the library does not make it exactly-once.',
  completedTopicNote(),
  'The M3 "measured check" at 500 ms includes the timer overshoot of the stub sleep and both broker hops with one task in flight; the computed share uses the 0 ms overhead only, so the two can differ.',
  'The harness measures stub completion events at the client; it does not use the library CompletionRouter. It uses the library AgentActor, BullMQDriver, KafkaDriver and COMPLETED_CHANNEL unmodified.',
  'M4 Redis: with the library defaults a lock must expire (30 s) and a stalled-job check (every 30 s) must then find the job, so the pick-up time is a whole number of check periods and can differ by 30 s from one kill to the next. Redis key expiry follows the wall clock: if the machine clock is corrected during the run (NTP, a virtual machine time sync), a lock can outlive a check and detection slips to the next one; with the shortened setting (lockDuration 2000 ms, stalledInterval 1000 ms, passed through the driver options to BullMQ) it is much shorter. The shortened setting is not exposed as a typed option of the driver (it is passed through untyped), and a short lock raises the risk of false stall detection for a task that blocks the event loop.',
  'The harness imports only the built `dist/` of the repository. The library version, the commit and whether the working tree had uncommitted changes are recorded in the Setup section; the build in `dist/` is what is measured.',
  'Cells marked `*` have a spread above 20 % across the repetitions; read those medians as indicative only. Raw per-run data is kept in `results/`.',
]) w(`- ${s}`);
if (load('m2_kafka_L0_rerun.json')) w('- The first Kafka 0 ms pass (M2) had cells with a spread above 20 %, so that table was repeated once (M2c, same seeds). Both passes are kept in `results/`; compare their spreads before quoting a Kafka 0 ms cell.');
fs.writeFileSync(path.join(__dirname, 'RESULTS.md'), out.join('\n') + '\n');
console.log('RESULTS.md written');
