/**
 * Kaiban Distributed — Shared Viewer Base
 *
 * Read-only live board for monitoring agent workflows.
 * Exposes window.KaibanViewer with a createBoard(config) factory.
 *
 * This file is shared by all example viewers. Each viewer passes a
 * small config object to customise labels and example-specific rendering.
 *
 * No HITL commands are sent from this viewer — it is strictly read-only.
 * HITL decisions must be made through the React board (board/ directory).
 *
 * Usage in each example's board.js:
 *   window.KaibanViewer.createBoard({ title, inputLabel, onFinishMsg, extraMeta });
 */

/* global io */
(function () {
  'use strict';

  // ── XSS defence ─────────────────────────────────────────────────────────

  /** Escape HTML special characters to prevent XSS when inserting server data into innerHTML. */
  function escHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // ── Result parser ────────────────────────────────────────────────────────

  /** Extract display text from a task result — handles KaibanHandlerResult JSON. */
  function parseTaskResult(raw) {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.answer === 'string') {
        return obj.answer.trim() || null;
      }
    } catch (_) { /* not JSON — return raw text */ }
    return raw;
  }

  // ── Duration formatter ───────────────────────────────────────────────────

  function formatDuration(startTime, endTime) {
    if (!startTime) return '—';
    const startMs  = Number(new Date(startTime));
    const endMs    = endTime ? Number(new Date(endTime)) : Date.now();
    const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // ── Gateway URL resolver ─────────────────────────────────────────────────

  /** Resolve gateway URL from query param, body data attribute, window global, or localhost fallback. */
  function resolveGatewayUrl() {
    const fromQuery = new URLSearchParams(location.search).get('gateway');
    if (fromQuery) {
      try { return new URL(fromQuery).href; } catch (_) { /* fall through */ }
    }
    const fromDataAttr = document.body && document.body.dataset.gateway;
    if (fromDataAttr) {
      try { return new URL(fromDataAttr).href; } catch (_) { /* fall through */ }
    }
    if (window.GATEWAY_URL) {
      try { return new URL(window.GATEWAY_URL).href; } catch (_) { /* fall through */ }
    }
    return 'http://localhost:3000';
  }

  // ── Board factory ────────────────────────────────────────────────────────

  /**
   * Create and wire a live Kanban board viewer.
   *
   * @param {object} config
   * @param {string} [config.inputLabel]   - Label used in the workflow bar input field (e.g. "Topic", "Query")
   * @param {string} [config.finishLabel]  - Label used in the FINISHED banner (e.g. "Blog post published")
   * @param {function} [config.renderExtraMeta] - Optional fn(meta, escHTML) to render example-specific meta HTML
   */
  function createBoard(config) {
    const cfg = {
      inputLabel: config.inputLabel || 'Topic',
      finishLabel: config.finishLabel || 'Workflow complete',
      renderExtraMeta: config.renderExtraMeta || null,
    };

    const GATEWAY_URL = resolveGatewayUrl();

    // ── Board state ────────────────────────────────────────────────────────

    const state = {
      agents: [],
      tasks: [],
      workflowStatus: 'INITIAL',
      metadata: null,
    };

    // Live-duration timer — ticks every second while workflow is RUNNING
    let durationTimer = null;

    // ── Event log ──────────────────────────────────────────────────────────

    function addLog(type, msg, highlight) {
      const now = new Date();
      const hh  = now.getHours().toString().padStart(2, '0');
      const mm  = now.getMinutes().toString().padStart(2, '0');
      const ss  = now.getSeconds().toString().padStart(2, '0');

      const box   = document.getElementById('log-box');
      if (!box) return;
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.setAttribute('role', 'listitem');
      entry.innerHTML = [
        `<span class="log-time">${hh}:${mm}:${ss}</span>`,
        `<span class="log-type lt-${escHTML(type)}">${escHTML(type)}</span>`,
        `<span class="log-msg${highlight ? ' highlight' : ''}">${escHTML(msg)}</span>`,
      ].join('');
      box.insertBefore(entry, box.firstChild);
      // Keep at most 200 entries (circular buffer) to prevent memory growth
      if (box.children.length > 200) box.removeChild(box.lastChild);
    }

    // ── Render helpers ─────────────────────────────────────────────────────

    function renderAgents() {
      const grid = document.getElementById('agents-grid');
      if (!grid) return;
      if (!state.agents.length) {
        grid.innerHTML = '<div class="empty" role="status">Waiting for agent state…</div>';
        return;
      }
      grid.innerHTML = state.agents.map(a => {
        const statusClass = escHTML((a.status || 'idle').toLowerCase());
        const taskRef = a.currentTaskId
          ? `<div class="agent-task">Task: ${escHTML(a.currentTaskId.slice(-8))}</div>`
          : '';
        return `
          <div class="agent-card" role="article" aria-label="${escHTML(a.name || a.agentId || 'Agent')} agent">
            <div class="agent-name">${escHTML(a.name || a.agentId || 'Agent')}</div>
            <div class="agent-role">${escHTML(a.role || '')}</div>
            <span class="agent-status status-${statusClass}" role="status">${escHTML(a.status || 'IDLE')}</span>
            ${taskRef}
          </div>`;
      }).join('');
    }

    function makeTaskCard(task) {
      const statusUpper = (task.status || 'TODO').toUpperCase();
      const isAwaiting  = statusUpper === 'AWAITING_VALIDATION';
      const isBlocked   = statusUpper === 'BLOCKED';

      const badge = isAwaiting
        ? '<span class="task-badge task-badge-hitl" aria-label="Awaiting human decision">⏸ AWAITING</span>'
        : isBlocked
        ? '<span class="task-badge task-badge-error" aria-label="Task blocked">⛔ ERROR</span>'
        : '';

      const resultClass = isBlocked ? ' blocked' : isAwaiting ? ' awaiting' : '';
      const resultText  = parseTaskResult(task.result);
      const resultHtml  = resultText
        ? resultText.length > 400
          // Long results use a collapsible <details> — full text always accessible
          ? `<details class="task-result${resultClass}">
               <summary aria-expanded="false">${escHTML(resultText.slice(0, 120))}…</summary>
               <div class="task-result-full">${escHTML(resultText)}</div>
             </details>`
          : `<div class="task-result${resultClass}">${escHTML(resultText)}</div>`
        : '';

      const title      = task.title || (task.description || '').slice(0, 40) || task.taskId || 'Task';
      const assignedTo = (task.agent && task.agent.name) || task.assignedToAgentId || '—';
      const tokensHtml = task.tokens != null
        ? `<div class="task-tokens" aria-label="Token usage">${Number(task.tokens).toLocaleString()} tok · $${Number(task.cost || 0).toFixed(4)}</div>`
        : '';

      return `
        <div class="task-card ${escHTML((task.status || 'todo').toLowerCase())}"
             role="article"
             aria-label="Task: ${escHTML(title)}, Status: ${escHTML(task.status || 'TODO')}">
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
      const set = (id, arr) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = arr.map(makeTaskCard).join('') || empty;
      };
      const cnt = (id, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = n;
      };
      set('col-todo',    cols.TODO);
      set('col-doing',   cols.DOING);
      set('col-await',   cols.AWAITING_VALIDATION);
      set('col-done',    cols.DONE);
      set('col-blocked', cols.BLOCKED);
      cnt('cnt-todo',    cols.TODO.length);
      cnt('cnt-doing',   cols.DOING.length);
      cnt('cnt-await',   cols.AWAITING_VALIDATION.length);
      cnt('cnt-done',    cols.DONE.length);
      cnt('cnt-blocked', cols.BLOCKED.length);
    }

    function renderWorkflow() {
      const el = document.getElementById('workflow-status');
      if (!el) return;
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

      // Hide all banners first
      [bannerHitl, bannerError, bannerFinished, bannerStopped]
        .forEach(b => { if (b) b.style.display = 'none'; });

      if (ws === 'FINISHED' && bannerFinished) {
        bannerFinished.style.display = 'block';
        const pub = doneTasks.find(t => String(t.result || '').length > 10);
        const msgEl = document.getElementById('banner-finished-msg');
        if (msgEl) {
          msgEl.textContent = pub ? `"${pub.title}" — ${cfg.finishLabel}` : cfg.finishLabel;
        }
        const econSection = document.querySelector('.swarm-meta');
        if (econSection) econSection.classList.add('economics-finished');

      } else if (ws === 'STOPPED' && bannerStopped) {
        bannerStopped.style.display = 'block';
        const stopped = state.tasks.find(t => t.title === 'Workflow ended');
        const msgEl = document.getElementById('banner-stopped-msg');
        if (msgEl) {
          msgEl.textContent = stopped
            ? String(stopped.result || '').replace('🗑 ', '').slice(0, 200)
            : 'Workflow ended';
        }

      } else if (awaitingTasks.length > 0 && bannerHitl) {
        // Show notification only — no interactive HITL buttons (this is a read-only viewer)
        bannerHitl.style.display = 'block';
        const msgEl = document.getElementById('banner-hitl-msg');
        if (msgEl) {
          msgEl.textContent = awaitingTasks.length === 1
            ? (awaitingTasks[0].result || 'Awaiting human decision via the React board')
            : `${awaitingTasks.length} tasks awaiting human decision — use the React board to respond`;
        }

      } else if (blockedTasks.length > 0 && bannerError) {
        bannerError.style.display = 'block';
        const msgEl = document.getElementById('banner-error-msg');
        if (msgEl) {
          msgEl.textContent = blockedTasks
            .map(t => `• ${t.title}: ${String(t.result || '').replace('ERROR:', '').trim().slice(0, 200)}`)
            .join('\n');
        }
      }
    }

    function renderEconomics() {
      const meta = state.metadata;
      if (!meta) return;

      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.textContent = val;
      };

      if (meta.totalTokens !== undefined) set('meta-tokens', Number(meta.totalTokens).toLocaleString());
      if (meta.estimatedCost !== undefined) set('meta-cost', `$${Number(meta.estimatedCost).toFixed(4)}`);
      if (meta.startTime) set('meta-start', new Date(meta.startTime).toLocaleTimeString());
      if (meta.endTime)   set('meta-end',   new Date(meta.endTime).toLocaleTimeString());
      set('meta-duration', formatDuration(meta.startTime, meta.endTime || null));

      // Let example override render extra meta-items (e.g. swarm nodes)
      if (cfg.renderExtraMeta) cfg.renderExtraMeta(meta, escHTML);
    }

    function render() {
      renderAgents();
      renderTasks();
      renderWorkflow();
      renderBanners();
      renderEconomics();
    }

    // ── State merge ────────────────────────────────────────────────────────

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
          const icon      = TASK_ICONS[t.status] || '📋';
          const result    = parseTaskResult(t.result);
          const preview   = result ? ` — ${result.slice(0, 80)}` : '';
          const hi        = t.status === 'DONE' || t.status === 'BLOCKED' || t.status === 'AWAITING_VALIDATION';
          const tokSuffix = (t.tokens != null) ? ` [${Number(t.tokens).toLocaleString()} tok]` : '';
          addLog('TASK', `${icon} ${(t.title || t.taskId).slice(0, 50)} → ${t.status}${preview}${tokSuffix}`, hi);
        }
      }
    }

    function applyDelta(delta) {
      if (delta.teamWorkflowStatus) {
        const incoming = delta.teamWorkflowStatus;
        const prev     = state.workflowStatus;

        // New run starting: clear state so board shows fresh data
        if (incoming === 'RUNNING' && (prev === 'FINISHED' || prev === 'STOPPED' || prev === 'ERRORED')) {
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
          map.set(agent.agentId, Object.assign({}, map.get(agent.agentId), agent));
        }
        state.agents = Array.from(map.values());
      }

      if (Array.isArray(delta.tasks)) {
        const map = new Map(state.tasks.map(t => [t.taskId, t]));
        for (const task of delta.tasks) {
          map.set(task.taskId, Object.assign({}, map.get(task.taskId), task));
        }
        state.tasks = Array.from(map.values());
      }

      if (delta.metadata) {
        state.metadata = Object.assign({}, state.metadata || {}, delta.metadata);
      }

      // Update input label (topic / query / etc.)
      const inputValue = (delta.inputs && (delta.inputs.query || delta.inputs.topic)) || null;
      if (inputValue) {
        const el = document.getElementById('input-label');
        if (el) el.textContent = `${cfg.inputLabel}: "${inputValue}"`;
      }
    }

    // ── Socket.io connection ───────────────────────────────────────────────

    // Display gateway URL in the connection info footer
    const gatewayDisplay = document.getElementById('gateway-url-display');
    if (gatewayDisplay) gatewayDisplay.textContent = GATEWAY_URL;

    addLog('INIT', `Connecting to ${GATEWAY_URL}`);

    // Exponential backoff reconnection: starts at 1s, doubles up to 30s
    const socket = io(GATEWAY_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay:    1000,
      reconnectionDelayMax: 30000,
      randomizationFactor:  0.5,
    });

    socket.on('connect', () => {
      // Reset state before receiving gateway snapshot to avoid stale data
      state.agents         = [];
      state.tasks          = [];
      state.workflowStatus = 'INITIAL';
      state.metadata       = null;
      if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }

      // Request current state snapshot from gateway — never shows stale state after reconnect
      socket.emit('state:request');

      const badge = document.getElementById('conn-badge');
      if (badge) { badge.className = 'badge badge-live'; badge.textContent = '● LIVE'; }
      const detail = document.getElementById('conn-detail');
      if (detail) detail.textContent = `id: ${(socket.id || '').slice(0, 8)}`;
      addLog('CONNECT', `Connected to ${GATEWAY_URL}`, true);
      render();
    });

    socket.on('disconnect', reason => {
      const badge = document.getElementById('conn-badge');
      if (badge) { badge.className = 'badge badge-error'; badge.textContent = '✕ Disconnected'; }
      const detail = document.getElementById('conn-detail');
      if (detail) detail.textContent = reason;
      addLog('DISCONNECT', reason, false);
    });

    socket.on('connect_error', err => {
      const badge = document.getElementById('conn-badge');
      if (badge) { badge.className = 'badge badge-error'; badge.textContent = '✕ Error'; }
      const detail = document.getElementById('conn-detail');
      if (detail) detail.textContent = err.message;
      addLog('ERROR', err.message, true);
    });

    socket.on('state:update', delta => {
      applyDelta(delta);
      logDelta(delta);
      render();
    });

    socket.on('task:completed', data => {
      addLog('DONE', `Task ${data.taskId} completed by ${data.agentId}`, true);
    });

    return { state, socket, addLog };
  }

  // Expose the factory on window so each example's board.js can call it
  window.KaibanViewer = { createBoard: createBoard };

}());
