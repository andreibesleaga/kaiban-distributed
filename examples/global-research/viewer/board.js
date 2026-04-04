/**
 * Kaiban Distributed — Global Research Swarm Viewer
 *
 * Thin config layer for the global-research example.
 * All shared Kanban board logic lives in ../../shared/viewer/board-base.js.
 *
 * This is a READ-ONLY viewer. It receives state updates but never sends
 * commands back to the gateway. HITL decisions must be made through the
 * React board (board/ directory).
 *
 * The only difference from the blog-team viewer is renderExtraMeta:
 * this example shows "Active Nodes" badges in the swarm metadata panel.
 */

// window.KaibanViewer is provided by board-base.js (loaded before this script)
window.KaibanViewer.createBoard({
  // Label shown next to the workflow input value (e.g. "Query: Climate Change Impact")
  inputLabel: 'Query',

  // Message shown in the FINISHED banner
  finishLabel: 'Research report published successfully',

  /**
   * Render swarm-specific metadata: active node badges.
   * Called by board-base.js after rendering standard economics fields.
   * @param {object} meta - Current workflow metadata object
   * @param {function} escHTML - HTML escape utility from board-base.js
   */
  renderExtraMeta: function (meta, escHTML) {
    var nodesEl = document.getElementById('meta-nodes');
    if (!nodesEl) return;

    if (!Array.isArray(meta.activeNodes) || meta.activeNodes.length === 0) return;

    nodesEl.innerHTML = meta.activeNodes
      .map(function (n) { return '<span class="node-badge" role="listitem">' + escHTML(n) + '</span>'; })
      .join('');

    // Log node activity update to the event stream
    if (meta.totalTokens !== undefined) {
      // This is handled by logDelta in board-base.js — no duplicate logging needed here
    }
  },
});
