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

  return `
    <div class="task-card ${escHTML((task.status || 'todo').toLowerCase())}">
      <div class="task-title">${escHTML(title)}${badge}</div>
      <div class="task-agent">${escHTML(assignedTo)}</div>
      ${resultHtml}
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

function renderSwarmMetadata() {
  const meta = state.metadata;
  if (!meta) return;

  const nodesEl = document.getElementById('meta-nodes');
  if (meta.activeNodes?.length) {
    nodesEl.innerHTML = meta.activeNodes.map(n => `<span class="node-badge">${n}</span>`).join('');
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
}

function renderBanners() {
  const ws           = (state.workflowStatus || '').toUpperCase();
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

  } else if (ws === 'STOPPED') {
    bannerStopped.style.display = 'block';
    const stopped = state.tasks.find(t => t.title === 'Workflow ended');
    document.getElementById('banner-stopped-msg').textContent =
      stopped ? String(stopped.result || '').slice(0, 200) : 'Research workflow ended';

  } else if (awaitingTasks.length > 0) {
    bannerHitl.style.display = 'block';
    document.getElementById('banner-hitl-msg').textContent =
      awaitingTasks[0].result || 'Check the orchestrator terminal for options [1/2/3/4]';

  } else if (blockedTasks.length > 0) {
    bannerError.style.display = 'block';
    document.getElementById('banner-error-msg').textContent =
      blockedTasks.map(t => `* ${t.title}: ${String(t.result || '').replace('ERROR:', '').trim().slice(0, 200)}`).join('\n');
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
    state.workflowStatus = delta.teamWorkflowStatus;
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

const AGENT_ICONS = { IDLE: '[IDLE]', EXECUTING: '[EXEC]', THINKING: '[THINK]', ERROR: '[ERR]' };
const TASK_ICONS  = { DOING: '[DO]', DONE: '[DONE]', BLOCKED: '[FAIL]', AWAITING_VALIDATION: '[WAIT]' };

function logDelta(delta) {
  if (delta.teamWorkflowStatus) {
    addLog('WORKFLOW', `Status → ${delta.teamWorkflowStatus}`, true);
  }

  if (Array.isArray(delta.agents)) {
    for (const a of delta.agents) {
      const icon    = AGENT_ICONS[a.status] || '[?]';
      const taskRef = a.currentTaskId ? ` [${a.currentTaskId.slice(-8)}]` : '';
      const hi      = a.status === 'EXECUTING' || a.status === 'ERROR';
      addLog('AGENT', `${icon} ${a.name || a.agentId} -> ${a.status}${taskRef}`, hi);
    }
  }

  if (Array.isArray(delta.tasks)) {
    for (const t of delta.tasks) {
      const icon    = TASK_ICONS[t.status] || '[?]';
      const preview = parseTaskResult(t.result) ? ` — ${parseTaskResult(t.result).slice(0, 80)}` : '';
      const hi      = t.status === 'DONE' || t.status === 'BLOCKED' || t.status === 'AWAITING_VALIDATION';
      addLog('TASK', `${icon} ${(t.title || t.taskId).slice(0, 50)} -> ${t.status}${preview}`, hi);
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
  document.getElementById('conn-badge').className   = 'badge badge-live';
  document.getElementById('conn-badge').textContent = '● LIVE';
  document.getElementById('conn-detail').textContent = `id: ${socket.id?.slice(0, 8)}`;
  addLog('CONNECT', `Connected to ${GATEWAY_URL}`, true);
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
