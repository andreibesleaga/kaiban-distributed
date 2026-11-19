// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// M4: crash recovery. kill -9 a worker mid-task (the k-th task of each trial), measure pick-up and completion.
// Two workers consume one queue. Each trial submits 3 tasks; the task at index k (seeded per trial) is the victim:
// 300 ms after its first 'start' the harness sends SIGKILL to the worker running it. A replacement is started
// only after the trial ended, so the victim can only be picked up by the surviving worker.
const lib = require('./lib.cjs');
const a = lib.parseArgs(process.argv);
const kind = a.driver || 'redis';
const profile = a.profile || 'default';
const crashes = Number(a.crashes || 30);
const latencyMs = Number(a.latency || 1000), killAfterMs = 300, tasksPerTrial = 3, trialDeadlineMs = Number(a.deadline || 240000);
const BULLMQ_PROFILES = { default: {}, short: { lockDuration: 2000, stalledInterval: 1000 } };
const bullmq = kind === 'redis' ? BULLMQ_PROFILES[profile] : undefined;
const name = a.name || `m4_${kind}_${profile}`;
const bullmqDefaults = { lockDuration: 30000, stalledInterval: 30000, maxStalledCount: 1, note: 'BullMQ Worker defaults (bullmq ' + require('bullmq/package.json').version + '); lock renewed every lockDuration/2' };
const kafkaDefaults = { sessionTimeout_ms: 30000, heartbeatInterval_ms: 3000, rebalanceTimeout_ms: 60000, note: 'kafkajs ' + require('kafkajs/package.json').version + ' consumer defaults; KafkaDriver does not expose them; heartbeat during a task every 3000 ms (driver constant)' };

(async () => {
  const runTag = `m4-${kind}-${profile}-${Date.now().toString(36)}`;
  const queue = `bench-mailbox-${runTag}`, groupId = `bench-workers-${runTag}`;
  const completedPartitions = await lib.prepareInfra(kind, queue, 2);
  const client = await lib.makeClient(kind, runTag);
  if (kind === 'kafka') await lib.waitGroupStable(`bench-client-${runTag}`, 1);
  const events = []; // start/end events from all workers
  let workerSeq = 0, live = [];
  const spawn = () => {
    const w = lib.spawnWorker({ driver: kind, queue, agentId: 'bench-agent', groupId, workerId: `w${workerSeq++}`, latencyMs, bullmq });
    w.handlers.push((m) => { if (m.type === 'start' || m.type === 'end') events.push(m); });
    live.push(w); return w;
  };
  const rng = lib.mulberry32(4242);
  const out = { measurement: name, machine: lib.machineInfo(), params: { kind, profile, crashes, latencyMs, killAfterMs, tasksPerTrial, trialDeadlineMs, seed: 4242, workers: 2, completed_partitions: completedPartitions },
    settings_in_force: kind === 'redis' ? { ...bullmqDefaults, ...(bullmq || {}), profile } : { ...kafkaDefaults, profile: 'default (no shorter setting exposed)', broker_group_initial_rebalance_delay_ms: 0 },
    trials: [] };
  const startWorkers = async () => { while (live.length < 2) spawn(); await Promise.all(live.map((w) => w.ready)); if (kind === 'kafka') await lib.waitGroupStable(groupId, 2); };
  await startWorkers();
  const allIds = [];
  try {
    for (let i = 0; i < crashes; i++) {
      const k = Math.floor(rng() * tasksPerTrial);
      const ids = Array.from({ length: tasksPerTrial }, (_, j) => `${runTag}-c${i}-t${j}`);
      allIds.push(...ids);
      const victim = ids[k];
      const trial = { trial: i, k, victim, killed_worker: null, t_kill: null, t_pickup: null, picked_by: null, t_done: null, kill_to_pickup_ms: null, kill_to_done_ms: null, status: null };
      let killTimer = null;
      const onStart = (m, w) => {
        if (m.type === 'start' && m.taskId === victim && trial.killed_worker === null) {
          trial.killed_worker = w.id;
          killTimer = setTimeout(() => { trial.t_kill = lib.now(); w.child.kill('SIGKILL'); }, killAfterMs);
        }
      };
      live.forEach((w) => w.handlers.push(onStart));
      for (let j = 0; j < tasksPerTrial; j++) await client.publish(queue, { taskId: ids[j], agentId: 'bench-agent', timestamp: Date.now(), data: { seq: j, trial: i } });
      const t0 = Date.now();
      while (Date.now() - t0 < trialDeadlineMs && !ids.every((id) => client.completions.has(id))) await lib.sleep(50);
      await lib.sleep(500);
      const starts = events.filter((e) => e.type === 'start' && e.taskId === victim);
      const second = starts.find((e) => e.worker !== trial.killed_worker);
      const killed = trial.t_kill !== null; // false when the task ended before the kill timer fired: no times are derived
      if (second && killed) { trial.t_pickup = second.t; trial.picked_by = second.worker; trial.kill_to_pickup_ms = second.t - trial.t_kill; }
      const c = client.completions.get(victim);
      if (c && killed) { trial.t_done = c.t[0]; trial.kill_to_done_ms = c.t[0] - trial.t_kill; }
      trial.victim_starts = starts.length;
      trial.victim_completions = c ? c.t.length : 0;
      trial.status = !killed ? 'NO_KILL' : c ? 'completed' : 'LOST';
      trial.others_completed = ids.filter((x) => x !== victim && client.completions.has(x)).length;
      console.log(`${name} trial ${i} k=${k} killed=${trial.killed_worker} pickup=${trial.kill_to_pickup_ms?.toFixed(0)} done=${trial.kill_to_done_ms?.toFixed(0)} ${trial.status}`);
      out.trials.push(trial);
      live.forEach((w) => { const j = w.handlers.indexOf(onStart); if (j >= 0) w.handlers.splice(j, 1); });
      clearTimeout(killTimer);
      live = live.filter((w) => !w.exited && !(w.id === trial.killed_worker));
      await lib.sleep(200);
      await startWorkers(); // replacement for the killed worker
      lib.writeJson(name + '.json', out);
    }
    // A duplicate from the last trials can arrive only after the broker detects the dead worker: wait that long.
    const detectMs = kind === 'redis' ? (bullmq?.lockDuration ?? bullmqDefaults.lockDuration) + (bullmq?.stalledInterval ?? bullmqDefaults.stalledInterval) : kafkaDefaults.sessionTimeout_ms;
    await lib.sleep(detectMs + latencyMs + 5000);
    // totals over all tasks
    let completed = 0, lost = 0, dupCompletions = 0, execTwiceNonVictim = 0, tasksWithTwoStarts = 0;
    const victims = new Set(out.trials.map((t) => t.victim));
    for (const id of allIds) {
      const c = client.completions.get(id); const st = events.filter((e) => e.type === 'start' && e.taskId === id).length;
      const en = events.filter((e) => e.type === 'end' && e.taskId === id).length;
      if (c) completed++; else lost++;
      if (c && c.t.length > 1) dupCompletions++;
      if (en > 1) execTwiceNonVictim += victims.has(id) ? 0 : 1; // executed to the end twice
      if (st > 1) tasksWithTwoStarts++;
    }
    out.totals = { tasks_submitted: allIds.length, crashes_injected: out.trials.filter((t) => t.status !== 'NO_KILL').length, trials_without_kill: out.trials.filter((t) => t.status === 'NO_KILL').length, completed, lost, tasks_with_duplicate_completion_event: dupCompletions,
      tasks_started_more_than_once: tasksWithTwoStarts, victims_re_executed: out.trials.filter((t) => t.victim_starts >= 2).length,
      non_victim_tasks_executed_to_end_twice: execTwiceNonVictim,
      victim_executed_to_end_twice: [...victims].filter((id) => events.filter((e) => e.type === 'end' && e.taskId === id).length > 1).length };
    out.summary = { kill_to_pickup_ms: lib.summarize(out.trials.map((t) => t.kill_to_pickup_ms)), kill_to_done_ms: lib.summarize(out.trials.map((t) => t.kill_to_done_ms)) };
    out.finished_utc = new Date().toISOString();
    lib.writeJson(name + '.json', out);
  } finally {
    await lib.stopWorkers(live); await client.close(); await lib.dropMailbox(kind, queue);
  }
  process.exit(0);
})().catch((e) => { console.error('M4 failed', e); process.exit(1); });
