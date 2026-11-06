// SPDX-License-Identifier: GPL-3.0-only
/* global io */

// ── XSS defence ──────────────────────────────────────────────────────────

/** Escape HTML special characters before inserting server data into innerHTML. */
function escHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Config ───────────────────────────────────────────────────────────────

// Board token for a gateway that sets BOARD_JWT_SECRET (and for STOP ALL): read from the URL
// fragment #token=... or window.BOARD_TOKEN. The fragment is removed from the address bar at once.
// The token is kept only in this constant: never logged, never in a query string, never stored.
const TOKEN_FROM_HASH = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
if (TOKEN_FROM_HASH) window.history.replaceState(null, '', location.pathname + location.search);
const BOARD_TOKEN = TOKEN_FROM_HASH || window.BOARD_TOKEN || '';

// A link must not choose where a configured token goes. With a window.BOARD_TOKEN, ?gateway= is
// ignored (set window.GATEWAY_URL instead). A #token= belongs to the gateway named in that same address.
const QUERY_GATEWAY = new URLSearchParams(location.search).get('gateway');
const QUERY_GATEWAY_IGNORED = Boolean(QUERY_GATEWAY && BOARD_TOKEN && !TOKEN_FROM_HASH);
const GATEWAY_URL = window.GATEWAY_URL
  || (QUERY_GATEWAY_IGNORED ? '' : QUERY_GATEWAY)
  || 'http://localhost:3000';

document.getElementById('gateway-url-display').textContent = GATEWAY_URL;

// ── State ────────────────────────────────────────────────────────────────

const state = {
  agents: [],
  tasks: [],
  workflowStatus: 'INITIAL',
  metadata: null,
  controlPlane: null, // set by the gateway only when the control plane is on
};

// Live-duration timer — active while workflow is RUNNING
let durationTimer = null;

// ── Log ──────────────────────────────────────────────────────────────────

function addLog(type, msg, highlight = false) {
  const now = new Date();
  const hh  = now.getHours().toString().padStart(2, '0');
  const mm  = now.getMinutes().toString().padStart(2, '0');
  const ss  = now.getSeconds().toString().padStart(2, '0');

  const box   = document.getElementById('log-box');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = [
    `<span class="log-time">${hh}:${mm}:${ss}</span>`,
    `<span class="log-type lt-${escHTML(type)}">${escHTML(type)}</span>`,
    `<span class="log-msg${highlight ? ' highlight' : ''}">${escHTML(msg)}</span>`,
  ].join('');
  box.insertBefore(entry, box.firstChild);
  if (box.children.length > 200) box.removeChild(box.lastChild);
}

// ── Result parser ────────────────────────────────────────────────────────

/** Extract display text from a task result — handles KaibanHandlerResult JSON */
function parseTaskResult(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.answer === 'string') {
      return obj.answer.trim() || null;
    }
  } catch {}
  return raw;
}

// ── Render helpers ───────────────────────────────────────────────────────

function renderAgents() {
  const grid = document.getElementById('agents-grid');
  if (!state.agents.length) {
    grid.innerHTML = '<div class="empty">Waiting for agent state...</div>';
    return;
  }
  grid.innerHTML = state.agents.map(a => {
    const statusClass = escHTML((a.status || 'idle').toLowerCase());
    const taskRef = a.currentTaskId
      ? `<div class="agent-task">Task: ${escHTML(a.currentTaskId.slice(-8))}</div>`
      : '';
    return `
      <div class="agent-card">
        <div class="agent-name">${escHTML(a.name || a.agentId || 'Agent')}</div>
        <div class="agent-role">${escHTML(a.role || '')}</div>
        <span class="agent-status status-${statusClass}">${escHTML(a.status || 'IDLE')}</span>
        ${taskRef}
      </div>`;
  }).join('');
}

function makeTaskCard(task) {
  const statusUpper = (task.status || 'TODO').toUpperCase();
  const isAwaiting  = statusUpper === 'AWAITING_VALIDATION';
  const isBlocked   = statusUpper === 'BLOCKED';
  const isStopped = statusUpper === 'STOPPED';

  const badge = isAwaiting
    ? '<span class="task-badge task-badge-hitl">⏸ HUMAN DECISION</span>'
    : isStopped
    ? '<span class="task-badge task-badge-stopped">⏹ Stopped</span>'
    : isBlocked
    ? '<span class="task-badge task-badge-error">⛔ ERROR</span>'
    : '';

  const resultClass = (isBlocked || isStopped) ? ' blocked' : isAwaiting ? ' awaiting' : '';
  const resultText  = parseTaskResult(task.result);
  const resultHtml  = resultText
    ? resultText.length > 400
      ? `<details class="task-result${resultClass}" data-task-id="${escHTML(task.taskId)}">
           <summary>${escHTML(resultText.slice(0, 120))}…</summary>
           <div class="task-result-full">${escHTML(resultText)}</div>
         </details>`
      : `<div class="task-result${resultClass}">${escHTML(resultText)}</div>`
    : '';

  const title      = task.title || task.description?.slice(0, 40) || task.taskId || 'Task';
  const assignedTo = task.agent?.name || task.assignedToAgentId || '—';
  const tokensHtml = task.tokens != null
    ? `<div class="task-tokens">${Number(task.tokens).toLocaleString()} tok · $${Number(task.cost || 0).toFixed(4)}</div>`
    : '';

  return `
    <div class="task-card ${escHTML((task.status || 'todo').toLowerCase())}">
      <div class="task-title">${escHTML(title)}${badge}</div>
      <div class="task-agent">${escHTML(assignedTo)}</div>
      ${resultHtml}
      ${tokensHtml}
    </div>`;
}

function renderTasks() {
  // The columns are rebuilt on every update; keep the long results the user has open.
  const open = new Set(Array.from(document.querySelectorAll('details[open][data-task-id]'), d => d.dataset.taskId));
  const cols = { TODO: [], DOING: [], AWAITING_VALIDATION: [], DONE: [], BLOCKED: [] };

  for (const task of state.tasks) {
    const rawKey = (task.status || 'TODO').toUpperCase();
    // STOPPED tasks (emergency stop) are shown in the Blocked column with a Stopped badge
    const key = rawKey === 'STOPPED' ? 'BLOCKED' : rawKey;
    if (cols[key]) cols[key].push(task);
  }

  const empty = '<div class="empty">Empty</div>';
  document.getElementById('col-todo').innerHTML    = cols.TODO.map(makeTaskCard).join('') || empty;
  document.getElementById('col-doing').innerHTML   = cols.DOING.map(makeTaskCard).join('') || empty;
  document.getElementById('col-await').innerHTML   = cols.AWAITING_VALIDATION.map(makeTaskCard).join('') || empty;
  document.getElementById('col-done').innerHTML    = cols.DONE.map(makeTaskCard).join('') || empty;
  document.getElementById('col-blocked').innerHTML = cols.BLOCKED.map(makeTaskCard).join('') || empty;

  document.getElementById('cnt-todo').textContent    = cols.TODO.length;
  document.getElementById('cnt-doing').textContent   = cols.DOING.length;
  document.getElementById('cnt-await').textContent   = cols.AWAITING_VALIDATION.length;
  document.getElementById('cnt-done').textContent    = cols.DONE.length;
  document.getElementById('cnt-blocked').textContent = cols.BLOCKED.length;

  document.querySelectorAll('details[data-task-id]').forEach(d => {
    if (open.has(d.dataset.taskId)) d.open = true;
  });
}

function renderWorkflow() {
  const el = document.getElementById('workflow-status');
  const ws = state.workflowStatus || 'INITIAL';
  el.textContent = ws;
  el.className   = 'workflow-status ws-' + ws.toLowerCase().replace(/_/g, '-');
}

function renderBanners() {
  const ws            = (state.workflowStatus || '').toUpperCase();
  const awaitingTasks = state.tasks.filter(t => (t.status || '').toUpperCase() === 'AWAITING_VALIDATION');
  const blockedTasks  = state.tasks.filter(t => (t.status || '').toUpperCase() === 'BLOCKED' && String(t.result || '').includes('ERROR:'));
  const doneTasks     = state.tasks.filter(t => (t.status || '').toUpperCase() === 'DONE');

  const bannerHitl     = document.getElementById('banner-hitl');
  const bannerError    = document.getElementById('banner-error');
  const bannerFinished = document.getElementById('banner-finished');
  const bannerStopped  = document.getElementById('banner-stopped');

  [bannerHitl, bannerError, bannerFinished, bannerStopped].forEach(b => b.style.display = 'none');

  if (ws === 'FINISHED') {
    bannerFinished.style.display = 'block';
    const pub = doneTasks.find(t => String(t.result || '').includes('Published'));
    document.getElementById('banner-finished-msg').textContent =
      pub ? `"${pub.title}" was published successfully` : 'Blog post published';

  } else if (ws === 'STOPPED') {
    bannerStopped.style.display = 'block';
    const stopped = state.tasks.find(t => t.title === 'Workflow ended');
    document.getElementById('banner-stopped-msg').textContent =
      stopped ? String(stopped.result || '').replace('🗑 ', '').slice(0, 200) : 'Workflow ended';

  } else if (awaitingTasks.length > 0) {
    bannerHitl.style.display = 'block';
    document.getElementById('banner-hitl-msg').textContent =
      awaitingTasks.length === 1
        ? (awaitingTasks[0].result || 'Awaiting human decision')
        : `${awaitingTasks.length} tasks awaiting human decision`;

    // Re-render per-task button groups on every call (task list may have changed)
    const oldContainer = document.getElementById('hitl-tasks-container');
    if (oldContainer) oldContainer.remove();
    const container = document.createElement('div');
    container.id = 'hitl-tasks-container';

    awaitingTasks.forEach((task) => {
      const group = document.createElement('div');
      group.className = 'hitl-task-group';

      const label = document.createElement('div');
      label.className = 'hitl-task-label';
      label.textContent = task.title || task.taskId;
      group.appendChild(label);

      container.appendChild(group);
    });

    bannerHitl.appendChild(container);

  } else if (blockedTasks.length > 0) {
    const oldContainer = document.getElementById('hitl-tasks-container');
    if (oldContainer) oldContainer.remove();

    bannerError.style.display = 'block';
    document.getElementById('banner-error-msg').textContent =
      blockedTasks.map(t => `• ${t.title}: ${String(t.result || '').replace('ERROR:', '').trim().slice(0, 200)}`).join('\n');

  } else {
    const oldContainer = document.getElementById('hitl-tasks-container');
    if (oldContainer) oldContainer.remove();
  }
}

function setMeta(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** Fill the panel from state.metadata; a field the run has not produced yet shows "—". */
function renderEconomics() {
  const meta = state.metadata || {};
  const running = state.workflowStatus === 'RUNNING';
  setMeta('meta-tokens', meta.totalTokens !== undefined ? Number(meta.totalTokens).toLocaleString() : '—');
  setMeta('meta-cost', meta.estimatedCost !== undefined ? `$${Number(meta.estimatedCost).toFixed(4)}` : '—');
  setMeta('meta-start', meta.startTime ? new Date(meta.startTime).toLocaleTimeString() : '—');
  setMeta('meta-end', meta.endTime ? new Date(meta.endTime).toLocaleTimeString() : running ? 'running…' : '—');
  // Duration — live while running, fixed once ended
  let duration = '—';
  if (meta.startTime) {
    const endMs = meta.endTime ? Number(new Date(meta.endTime)) : Date.now();
    const totalSec = Math.max(0, Math.floor((endMs - Number(new Date(meta.startTime))) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    duration = m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  setMeta('meta-duration', duration);
  // The green "finished" highlight belongs to a finished run only
  const section = document.getElementById('economics-section') || document.querySelector('.swarm-meta');
  if (section) section.classList.toggle('economics-finished', state.workflowStatus === 'FINISHED');
}

function render() {
  renderAgents();
  renderTasks();
  renderWorkflow();
  renderBanners();
  renderControl();
  renderEconomics();
}

// ── State merge ──────────────────────────────────────────────────────────

function applyDelta(delta) {
  if (delta.teamWorkflowStatus) {
    const incoming = delta.teamWorkflowStatus;
    const prev = state.workflowStatus;

    // New workflow run: clear tasks and metadata from previous run so board starts fresh
    if (incoming === 'RUNNING' &&
        (prev === 'FINISHED' || prev === 'STOPPED' || prev === 'ERRORED')) {
      state.tasks    = [];
      state.metadata = null;
    }

    // Manage live-duration timer
    if (incoming === 'RUNNING' && !durationTimer) {
      durationTimer = setInterval(() => renderEconomics(), 1000);
    } else if (incoming !== 'RUNNING' && durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }

    state.workflowStatus = incoming;
  }

  if (Array.isArray(delta.agents)) {
    const map = new Map(state.agents.map(a => [a.agentId, a]));
    for (const agent of delta.agents) {
      map.set(agent.agentId, { ...map.get(agent.agentId), ...agent });
    }
    state.agents = Array.from(map.values());
  }

  if (Array.isArray(delta.tasks)) {
    const map = new Map(state.tasks.map(t => [t.taskId, t]));
    for (const task of delta.tasks) {
      map.set(task.taskId, { ...map.get(task.taskId), ...task });
    }
    state.tasks = Array.from(map.values());
  }

  if (delta.metadata) {
    state.metadata = { ...(state.metadata || {}), ...delta.metadata };
  }

  if (delta.controlPlane) {
    state.controlPlane = { ...delta.controlPlane };
  }
  if (delta.control && state.controlPlane) {
    state.controlPlane = applyControlAck(state.controlPlane, delta.control);
  }

  if (delta.inputs?.topic) {
    document.getElementById('topic-label').textContent = `Topic: "${delta.inputs.topic}"`;
  }
}

// ── Log delta events ─────────────────────────────────────────────────────

const AGENT_ICONS = { IDLE: '⚪', EXECUTING: '🟢', THINKING: '🔵', ERROR: '🔴' };
const TASK_ICONS  = { DOING: '🔵', DONE: '✅', BLOCKED: '🔴', AWAITING_VALIDATION: '⏸', STOPPED: '⏹' };

function logDelta(delta) {
  if (delta.control) {
    addLog('CONTROL', controlMessage(delta.control), true);
  }

  if (delta.teamWorkflowStatus) {
    addLog('WORKFLOW', `Status → ${delta.teamWorkflowStatus}`, true);
  }

  if (Array.isArray(delta.agents)) {
    for (const a of delta.agents) {
      // A worker heartbeat repeats an unchanged agent state every 15 s: not an event.
      const before = state.agents.find(x => x.agentId === a.agentId);
      if (before && before.status === a.status && before.currentTaskId === a.currentTaskId) continue;
      const icon    = AGENT_ICONS[a.status] || '⬡';
      const taskRef = a.currentTaskId ? ` [${a.currentTaskId.slice(-8)}]` : '';
      const hi      = a.status === 'EXECUTING' || a.status === 'ERROR';
      if (a.status === 'THINKING') {
        addLog('LLM', `🤖 ${a.name || a.agentId} — LLM call in progress${taskRef}`, false);
      } else {
        addLog('AGENT', `${icon} ${a.name || a.agentId} → ${a.status}${taskRef}`, hi);
      }
    }
  }

  if (Array.isArray(delta.tasks)) {
    for (const t of delta.tasks) {
      const icon    = TASK_ICONS[t.status] || '📋';
      const preview = parseTaskResult(t.result) ? ` — ${parseTaskResult(t.result).slice(0, 80)}` : '';
      const hi      = t.status === 'DONE' || t.status === 'BLOCKED' || t.status === 'AWAITING_VALIDATION';
      const tokSuffix = (t.tokens != null) ? ` [${Number(t.tokens).toLocaleString()} tok]` : '';
      addLog('TASK', `${icon} ${(t.title || t.taskId).slice(0, 50)} → ${t.status}${preview}${tokSuffix}`, hi);
    }
  }
}

// ── Emergency STOP ALL (ADR-025) ─────────────────────────────────────────
// The button, the confirmation and the banner exist only while the gateway snapshot
// says the control plane is on (CONTROL_PLANE_ENABLED). Same behaviour as the React board.

const STOP_ACK_TIMEOUT_MS = 8000;

function timeOf(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

/** Count node acknowledgements for the latest stop; a newer stop resets the count. */
function applyControlAck(plane, ack) {
  const { commandId, issuedAt, issuedBy, reason } = ack;
  const next = !plane.lastStop || issuedAt > plane.lastStop.issuedAt
    ? { enabled: true, lastStop: { commandId, issuedAt, issuedBy, ...(reason ? { reason } : {}) }, acks: 0 }
    : { ...plane };
  if (ack.outcome !== 'issued' && commandId === next.lastStop?.commandId) next.acks++;
  return next;
}

/** One event-log line for a control ack. */
function controlMessage(ack) {
  if (ack.outcome === 'issued') {
    return `STOP ALL issued by ${ack.issuedBy}${ack.reason ? ` — ${ack.reason}` : ''}`;
  }
  const who = ack.agentId ? `${ack.agentId} on ${ack.nodeId}` : ack.nodeId;
  return `${who}: ${ack.outcome}, ${ack.aborted} task(s) killed`;
}

function renderControl() {
  const plane = state.controlPlane;
  const stop = plane?.lastStop;
  document.getElementById('stop-all-btn').hidden = !plane?.enabled;
  document.getElementById('banner-control').hidden = !stop;
  if (!stop) return;
  document.getElementById('banner-control-msg').textContent =
    `Emergency stop at ${timeOf(stop.issuedAt)} by ${stop.issuedBy}` + (stop.reason ? ` — ${stop.reason}` : '');
  const acks = plane.acks || 0;
  document.getElementById('banner-control-acks').textContent =
    `${acks} node acknowledgement${acks === 1 ? '' : 's'}`;
}

function showControlError(message) {
  addLog('ERROR', message, true);
  const el = document.getElementById('control-error');
  el.textContent = message;
  el.hidden = false;
}

function clearControlError() {
  const el = document.getElementById('control-error');
  el.textContent = '';
  el.hidden = true;
}

function sendStopAll(reason) {
  clearControlError();
  if (!socket.connected) {
    showControlError('Cannot send STOP ALL — not connected to the gateway. Run npm run stop-all instead.');
    return;
  }
  addLog('CONTROL', 'Sending STOP ALL…', true);
  let answered = false;
  const timer = setTimeout(() => {
    if (!answered) {
      showControlError(`STOP ALL not confirmed by the gateway within ${STOP_ACK_TIMEOUT_MS / 1000}s — check the gateway, or run npm run stop-all`);
    }
  }, STOP_ACK_TIMEOUT_MS);

  socket.emit('control:stop-all', reason ? { reason } : {}, response => {
    answered = true;
    window.clearTimeout(timer);
    if (response?.ok) {
      clearControlError(); // a late confirmation replaces the timeout alert
      addLog('CONTROL', `STOP ALL issued (command ${String(response.commandId).slice(0, 8)})`, true);
    } else {
      showControlError(`STOP ALL refused: ${response?.error ?? 'gateway error'}`);
    }
  });
}

function wireStopAll() {
  const dialog = document.getElementById('stop-all-dialog');
  const reasonInput = document.getElementById('stop-all-reason');
  document.getElementById('stop-all-btn').addEventListener('click', () => {
    reasonInput.value = '';
    dialog.showModal();
  });
  document.getElementById('stop-all-cancel').addEventListener('click', () => dialog.close());
  document.getElementById('stop-all-form').addEventListener('submit', event => {
    event.preventDefault();
    const reason = reasonInput.value.trim();
    dialog.close();
    sendStopAll(reason || undefined);
  });
}

// ── Socket.io ────────────────────────────────────────────────────────────

addLog('INIT', `Connecting to ${GATEWAY_URL}`);
if (QUERY_GATEWAY_IGNORED) {
  addLog('INIT', 'Ignoring ?gateway=: a board token is configured. Set window.GATEWAY_URL to change the gateway.', true);
}

const socket = io(GATEWAY_URL, {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  ...(BOARD_TOKEN ? { auth: { token: BOARD_TOKEN } } : {}),
});

socket.on('connect', () => {
  // Reset all workflow state before the gateway snapshot arrives — prevents stale leftovers
  state.agents = [];
  state.tasks  = [];
  state.workflowStatus = 'INITIAL';
  state.controlPlane = null;
  state.metadata = null;
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
  // No 'state:request': the gateway sends the snapshot on connection, and asking again
  // would apply (and log) it twice.

  document.getElementById('conn-badge').className    = 'badge badge-live';
  document.getElementById('conn-badge').textContent  = '● LIVE';
  document.getElementById('conn-detail').textContent = `id: ${socket.id?.slice(0, 8)}`;
  addLog('CONNECT', `Connected to ${GATEWAY_URL}`, true);
  render();
});

socket.on('disconnect', reason => {
  document.getElementById('conn-badge').className    = 'badge badge-error';
  document.getElementById('conn-badge').textContent  = '✕ Disconnected';
  document.getElementById('conn-detail').textContent = reason;
  addLog('DISCONNECT', reason);
});

socket.on('connect_error', err => {
  document.getElementById('conn-badge').className    = 'badge badge-error';
  document.getElementById('conn-badge').textContent  = '✕ Error';
  document.getElementById('conn-detail').textContent = err.message;
  addLog('ERROR', err.message);
});

socket.on('state:update', delta => {
  logDelta(delta); // first: a heartbeat is told from a change by the previous agent state
  applyDelta(delta);
  render();
});

wireStopAll();
