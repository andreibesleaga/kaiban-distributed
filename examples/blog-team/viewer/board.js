/**
 * Kaiban Distributed — Blog Team Viewer
 *
 * Thin config layer for the blog-team example.
 * All shared Kanban board logic lives in ../../shared/viewer/board-base.js.
 *
 * This is a READ-ONLY viewer. It receives state updates but never sends
 * commands back to the gateway. HITL decisions must be made through the
 * React board (board/ directory).
 */

// window.KaibanViewer is provided by board-base.js (loaded before this script)
window.KaibanViewer.createBoard({
  // Label shown next to the workflow input value (e.g. "Topic: AI Writing Assistants")
  inputLabel: 'Topic',

  // Message shown in the FINISHED banner when the workflow completes successfully
  finishLabel: 'Blog post published successfully',

  // No extra meta for blog-team (uses default economics panel only)
  renderExtraMeta: null,
});

