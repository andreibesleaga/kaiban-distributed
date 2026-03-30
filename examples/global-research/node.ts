/**
 * Multi-process entry point for Global Research Swarm.
 *
 * Usage:
 *   NODE_TYPE=searcher  npx ts-node examples/global-research/node.ts
 *   NODE_TYPE=writer    npx ts-node examples/global-research/node.ts
 *   NODE_TYPE=reviewer  npx ts-node examples/global-research/node.ts
 *   NODE_TYPE=editor    npx ts-node examples/global-research/node.ts
 *
 * Proves Location Transparency: run Searchers locally,
 * Editor on a remote server — they collaborate via Redis backbone.
 */
import 'dotenv/config';

const NODE_TYPE = process.env['NODE_TYPE'];

async function main(): Promise<void> {
  switch (NODE_TYPE) {
    case 'searcher':
      await import('./searcher-node');
      break;
    case 'writer':
      await import('./writer-node');
      break;
    case 'reviewer':
      await import('./reviewer-node');
      break;
    case 'editor':
      await import('./editor-node');
      break;
    default:
      console.error('[Node] NODE_TYPE environment variable is required.');
      console.error('[Node] Valid values: searcher | writer | reviewer | editor');
      console.error('[Node] Example: NODE_TYPE=searcher npx ts-node examples/global-research/node.ts');
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[Node] Fatal error:', err);
  process.exit(1);
});
