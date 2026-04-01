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

const GATEWAY_URL = window.GATEWAY_URL
  || new URLSearchParams(location.search).get('gateway')
  || 'http://localhost:3000';

document.getElementById('gateway-url-display').textContent = GATEWAY_URL;

// ── State ────────────────────────────────────────────────────────────────

const state = {
  agents: [],
  tasks: [],
  workflowStatus: 'INITIAL',
  metadata: null,
};

// (hitlTaskId retained for backward compat with any external code, but no longer drives rendering)
let hitlTaskId = null;

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

// ── HITL Decision ────────────────────────────────────────────────────────

/**
 * Send a HITL decision to the gateway via Socket.io.
 * Mirrors the React board's sendHitlDecision() in socketClient.ts.
 * Uses acknowledgement callback with 8-second timeout guard.
 */
function sendHitlDecision(taskId, decision) {
  if (!socket.connected) {
    addLog('ERROR', `Cannot send decision — not connected (${decision})`, true);
    return;
  }
  addLog('HITL', `Sending decision: ${decision} for task ${taskId.slice(-8)}…`, false);

  const ACK_TIMEOUT_MS = 8000;
  let ackReceived = false;

  const timer = setTimeout(() => {
    if (!ackReceived) {
      addLog('ERROR', `Decision not confirmed by gateway within ${ACK_TIMEOUT_MS / 1000}s — try again`, true);
    }
  }, ACK_TIMEOUT_MS);

  socket.emit('hitl:decision', { taskId, decision }, (response) => {
    ackReceived = true;
    clearTimeout(timer);
    if (response?.ok) {
      addLog('HITL', `Decision confirmed: ${decision} for task ${taskId.slice(-8)}`, true);
    } else {
      const reason = response?.error ?? 'gateway error';
      addLog('ERROR', `Decision rejected by gateway: ${reason}`, true);
    }
  });
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

  const badge = isAwaiting
    ? '<span class="task-badge task-badge-hitl">⏸ HUMAN DECISION</span>'
    : isBlocked
    ? '<span class="task-badge task-badge-error">⛔ ERROR</span>'
    : '';

  const resultClass = isBlocked ? ' blocked' : isAwaiting ? ' awaiting' : '';
  const resultText  = parseTaskResult(task.result);
  // Long results (e.g. research reports) use a collapsible <details> so the card stays compact
  // but the full text is always accessible without truncation.
  const resultHtml  = resultText
    ? resultText.length > 400
      ? `<details class="task-result${resultClass}">
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
  const cols = { TODO: [], DOING: [], AWAITING_VALIDATION: [], DONE: [], BLOCKED: [] };

  for (const task of state.tasks) {
    const key = (task.status || 'TODO').toUpperCase();
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
    const pub = doneTasks.find(t => String(t.result || '').includes('Published') || String(t.result || '').includes('Tokens'));
    document.getElementById('banner-finished-msg').textContent =
      pub ? `"${pub.title}" research was published successfully` : 'Research report published';
    // Highlight economics section on completion
    const econSection = document.getElementById('economics-section') || document.querySelector('.swarm-meta');
    if (econSection) econSection.classList.add('economics-finished');

  } else if (ws === 'STOPPED') {
    bannerStopped.style.display = 'block';
    const stopped = state.tasks.find(t => t.title === 'Workflow ended');
    document.getElementById('banner-stopped-msg').textContent =
      stopped ? String(stopped.result || '').slice(0, 200) : 'Research workflow ended';

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

      const btns = document.createElement('div');
      btns.className = 'hitl-buttons';
      const tid = task.taskId; // closure capture

      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn-hitl btn-approve';
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => sendHitlDecision(tid, 'PUBLISH'));

      const reviseBtn = document.createElement('button');
      reviseBtn.className = 'btn-hitl btn-revise';
      reviseBtn.textContent = 'Revise';
      reviseBtn.addEventListener('click', () => sendHitlDecision(tid, 'REVISE'));

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-hitl btn-reject';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', () => sendHitlDecision(tid, 'REJECT'));

      btns.appendChild(approveBtn);
      btns.appendChild(reviseBtn);
      btns.appendChild(rejectBtn);
      group.appendChild(btns);
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

function renderSwarmMetadata() {
  const meta = state.metadata;
  if (!meta) return;

  const nodesEl = document.getElementById('meta-nodes');
  if (nodesEl && meta.activeNodes?.length) {
    nodesEl.innerHTML = meta.activeNodes.map(n => `<span class="node-badge">${escHTML(n)}</span>`).join('');
  }

  if (meta.totalTokens !== undefined) {
    document.getElementById('meta-tokens').textContent = Number(meta.totalTokens).toLocaleString();
  }
  if (meta.estimatedCost !== undefined) {
    document.getElementById('meta-cost').textContent = `$${Number(meta.estimatedCost).toFixed(4)}`;
  }
  if (meta.startTime) {
    document.getElementById('meta-start').textContent = new Date(meta.startTime).toLocaleTimeString();
  }
  if (meta.endTime) {
    document.getElementById('meta-end').textContent = new Date(meta.endTime).toLocaleTimeString();
  }
  // Duration — live while running, fixed once ended
  const durEl = document.getElementById('meta-duration');
  if (durEl && meta.startTime) {
    const startMs  = Number(new Date(meta.startTime));
    const endMs    = meta.endTime ? Number(new Date(meta.endTime)) : Date.now();
    const totalSec = Math.floor((endMs - startMs) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    durEl.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}

function render() {
  renderAgents();
  renderTasks();
  renderWorkflow();
  renderBanners();
  renderSwarmMetadata();
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
      durationTimer = setInterval(() => renderSwarmMetadata(), 1000);
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

  if (delta.inputs?.query || delta.inputs?.topic) {
    const q = delta.inputs.query || delta.inputs.topic;
    document.getElementById('query-label').textContent = `Query: "${q}"`;
  }
}

// ── Log delta events ─────────────────────────────────────────────────────

const AGENT_ICONS = { IDLE: '⚪', EXECUTING: '🟢', THINKING: '🔵', ERROR: '🔴' };
const TASK_ICONS  = { DOING: '🔵', DONE: '✅', BLOCKED: '🔴', AWAITING_VALIDATION: '⏸' };

function logDelta(delta) {
  if (delta.teamWorkflowStatus) {
    addLog('WORKFLOW', `Status → ${delta.teamWorkflowStatus}`, true);
  }

  if (Array.isArray(delta.agents)) {
    for (const a of delta.agents) {
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

  if (delta.metadata?.activeNodes?.length) {
    const m = delta.metadata;
    addLog('META', `Nodes: [${m.activeNodes.join(', ')}] | Tokens: ${m.totalTokens || 0} | Cost: $${Number(m.estimatedCost || 0).toFixed(4)}`);
  }
}

// ── Socket.io ────────────────────────────────────────────────────────────

addLog('INIT', `Connecting to ${GATEWAY_URL}`);

const socket = io(GATEWAY_URL, {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
});

socket.on('connect', () => {
  // Reset all workflow state before the gateway snapshot arrives — prevents stale leftovers
  state.agents = [];
  state.tasks  = [];
  state.workflowStatus = 'INITIAL';
  state.metadata = null;
  hitlTaskId = null;
  if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
  // Request full snapshot replay from gateway
  socket.emit('state:request');

  document.getElementById('conn-badge').className   = 'badge badge-live';
  document.getElementById('conn-badge').textContent = '● LIVE';
  document.getElementById('conn-detail').textContent = `id: ${socket.id?.slice(0, 8)}`;
  addLog('CONNECT', `Connected to ${GATEWAY_URL}`, true);
  render();
});

socket.on('disconnect', reason => {
  document.getElementById('conn-badge').className   = 'badge badge-error';
  document.getElementById('conn-badge').textContent = 'Disconnected';
  document.getElementById('conn-detail').textContent = reason;
  addLog('DISCONNECT', reason);
});

socket.on('connect_error', err => {
  document.getElementById('conn-badge').className   = 'badge badge-error';
  document.getElementById('conn-badge').textContent = 'Error';
  document.getElementById('conn-detail').textContent = err.message;
  addLog('ERROR', err.message);
});

socket.on('state:update', delta => {
  applyDelta(delta);
  logDelta(delta);
  render();
});

socket.on('task:completed', data => {
  addLog('DONE', `Task ${data.taskId} completed by ${data.agentId}`, true);
});
