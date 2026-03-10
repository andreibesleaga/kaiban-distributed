/**
 * Blog Team Orchestrator
 *
 * Event-driven orchestration of the three-agent distributed blog pipeline:
 *
 *   Ava (researcher) ──> Kai (writer) ──> Morgan (editor)
 *                                              │
 *                                    ┌─────────▼──────────┐
 *                                    │  EDITORIAL REVIEW   │
 *                                    │  Accuracy: X.X/10   │
 *                                    │  Issues: [...]      │
 *                                    │  Recommendation:    │
 *                                    │  PUBLISH|REVISE|    │
 *                                    │  REJECT             │
 *                                    └─────────┬──────────┘
 *                                              │
 *                                   ┌──────────▼───────────┐
 *                                   │  Human Decision (HITL) │
 *                                   │  a) Accept + PUBLISH   │
 *                                   │  b) Send back to REVISE │
 *                                   │  c) REJECT + discard   │
 *                                   └────────────────────────┘
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:3000 TOPIC="AI Agents" ts-node orchestrator.ts
 *
 * Environment variables:
 *   GATEWAY_URL  — Edge Gateway URL (default: http://localhost:3000)
 *   TOPIC        — Blog post topic (default: "Latest developments in AI agents")
 *   RESEARCH_WAIT_MS — Time to wait for research (default: 45000)
 *   WRITE_WAIT_MS    — Time to wait for writing  (default: 60000)
 *   EDIT_WAIT_MS     — Time to wait for editing  (default: 45000)
 */
import 'dotenv/config';
import readline from 'readline';
import { io, type Socket } from 'socket.io-client';
import { BullMQDriver } from '../../src/infrastructure/messaging/bullmq-driver';
import { COMPLETED_QUEUE } from './team-config';

const GATEWAY_URL      = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const REDIS_URL        = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TOPIC            = process.env['TOPIC'] ?? 'Latest developments in AI agents';
const RESEARCH_WAIT_MS = parseInt(process.env['RESEARCH_WAIT_MS'] ?? '45000', 10);
const WRITE_WAIT_MS    = parseInt(process.env['WRITE_WAIT_MS'] ?? '60000', 10);
const EDIT_WAIT_MS     = parseInt(process.env['EDIT_WAIT_MS'] ?? '45000', 10);

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY_URL}/a2a/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.json() as { result: Record<string, unknown>; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function parseRecommendation(review: string): 'PUBLISH' | 'REVISE' | 'REJECT' | 'UNKNOWN' {
  const match = /Recommendation:\s*(PUBLISH|REVISE|REJECT)/i.exec(review);
  if (!match) return 'UNKNOWN';
  return match[1].toUpperCase() as 'PUBLISH' | 'REVISE' | 'REJECT';
}

function parseAccuracyScore(review: string): string {
  const match = /Accuracy Score:\s*([0-9.]+\/10)/i.exec(review);
  return match ? match[1] : 'N/A';
}

/**
 * Waits for a task to complete by polling kaiban-events-completed.
 * Returns the data.result field from the completion event.
 */
async function waitForTaskResult(
  driver: BullMQDriver,
  taskId: string,
  timeoutMs: number,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error(`[Orchestrator] Timeout waiting for ${label} (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    void driver.subscribe(COMPLETED_QUEUE, async (payload) => {
      if (payload.taskId === taskId && !resolved) {
        resolved = true;
        clearTimeout(timer);
        const result = payload.data['result'];
        resolve(typeof result === 'string' ? result : JSON.stringify(result));
      }
    });
  });
}

// ──────────────────────────────────────────────────
// Main orchestration flow
// ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const redisUrl = new URL(REDIS_URL);

  // BullMQ driver for receiving completion events
  const driver = new BullMQDriver({
    connection: { host: redisUrl.hostname, port: parseInt(redisUrl.port || '6379', 10) },
  });

  // Socket.io for real-time state board updates
  let socket: Socket | null = null;

  const cleanup = async (): Promise<void> => {
    socket?.disconnect();
    await driver.disconnect();
    rl.close();
  };

  try {
    // ── Gateway check ──────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log(' KAIBAN DISTRIBUTED — BLOG TEAM ORCHESTRATOR');
    console.log(`${'═'.repeat(60)}\n`);

    const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json()) as { data: { status: string } };
    console.log(`✓ Gateway: ${health.data.status.toUpperCase()} at ${GATEWAY_URL}`);

    const card = await fetch(`${GATEWAY_URL}/.well-known/agent-card.json`).then((r) => r.json()) as {
      name: string; capabilities: string[];
    };
    console.log(`✓ Agent:   ${card.name} — [${card.capabilities.join(', ')}]\n`);

    // ── Socket.io board monitor ────────────────────
    socket = io(GATEWAY_URL, { transports: ['websocket'] });
    socket.on('state:update', (delta: Record<string, unknown>) => {
      const status = delta['teamWorkflowStatus'] ?? delta['status'];
      if (status) process.stdout.write(`  ⬡ Board: ${String(status)}\n`);
    });

    console.log(`📋 Topic: "${TOPIC}"\n`);

    // ──────────────────────────────────────────────
    // STEP 1 — Research
    // ──────────────────────────────────────────────
    console.log('─'.repeat(60));
    console.log('STEP 1 — Ava (Researcher) is gathering information...');
    console.log('─'.repeat(60));

    const researchTask = await rpc('tasks.create', {
      agentId: 'researcher',
      instruction: `Research the latest news, key developments, and verifiable facts on the topic: "${TOPIC}". Include specific data points, statistics, and source references where possible.`,
      expectedOutput: 'A detailed research summary with key facts, trends, notable developments, and source references. Clearly distinguish confirmed facts from speculation.',
      inputs: { topic: TOPIC },
    });
    const researchTaskId = String(researchTask['taskId']);
    console.log(`  ↳ Task queued: ${researchTaskId}`);
    console.log(`  ↳ Waiting up to ${RESEARCH_WAIT_MS / 1000}s for research...\n`);

    const researchSummary = await waitForTaskResult(driver, researchTaskId, RESEARCH_WAIT_MS, 'research');

    console.log('\n✅ RESEARCH COMPLETE');
    console.log('─'.repeat(60));
    console.log(researchSummary.slice(0, 600) + (researchSummary.length > 600 ? '\n  [...truncated...]' : ''));
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────
    // STEP 2 — Write
    // ──────────────────────────────────────────────
    console.log('STEP 2 — Kai (Writer) is drafting the blog post...');
    console.log('─'.repeat(60));

    const writeTask = await rpc('tasks.create', {
      agentId: 'writer',
      instruction: `Write an engaging, well-structured blog post about: "${TOPIC}". Use the research provided in the context. Structure: compelling headline, introduction, 3-4 substantive sections, conclusion. Stick to the verified facts from research.`,
      expectedOutput: 'A complete blog post in Markdown format, 500–800 words, with a headline, sections, and conclusion. Only include claims supported by the research.',
      inputs: { topic: TOPIC },
      context: researchSummary,
    });
    const writeTaskId = String(writeTask['taskId']);
    console.log(`  ↳ Task queued: ${writeTaskId}`);
    console.log(`  ↳ Waiting up to ${WRITE_WAIT_MS / 1000}s for draft...\n`);

    const blogDraft = await waitForTaskResult(driver, writeTaskId, WRITE_WAIT_MS, 'writing');

    console.log('\n✅ DRAFT COMPLETE');
    console.log('─'.repeat(60));
    console.log(blogDraft.slice(0, 800) + (blogDraft.length > 800 ? '\n  [...truncated — full draft sent to editor...]' : ''));
    console.log('─'.repeat(60) + '\n');

    // ──────────────────────────────────────────────
    // STEP 3 — Editorial Review
    // ──────────────────────────────────────────────
    console.log('STEP 3 — Morgan (Editor) is reviewing for accuracy...');
    console.log('─'.repeat(60));

    const editTask = await rpc('tasks.create', {
      agentId: 'editor',
      instruction: `You are reviewing a blog post draft for factual accuracy. Cross-reference every claim in the draft against the research summary provided. Identify unsupported claims, factual errors, misleading statements, and missing important context. Output your review using the structured format from your background instructions.`,
      expectedOutput: 'A structured editorial review in the exact format specified in your background: accuracy score, issues list with severity, required changes, and PUBLISH/REVISE/REJECT recommendation.',
      inputs: { topic: TOPIC },
      context: `--- RESEARCH SUMMARY ---\n${researchSummary}\n\n--- BLOG DRAFT ---\n${blogDraft}`,
    });
    const editTaskId = String(editTask['taskId']);
    console.log(`  ↳ Task queued: ${editTaskId}`);
    console.log(`  ↳ Waiting up to ${EDIT_WAIT_MS / 1000}s for editorial review...\n`);

    const editorialReview = await waitForTaskResult(driver, editTaskId, EDIT_WAIT_MS, 'editorial review');

    const recommendation = parseRecommendation(editorialReview);
    const accuracyScore  = parseAccuracyScore(editorialReview);

    console.log('\n');
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  📝 EDITORIAL REVIEW BY MORGAN                          ║');
    console.log('╠' + '═'.repeat(58) + '╣');
    console.log(editorialReview.split('\n').map((l) => `║  ${l.padEnd(56)}║`).join('\n'));
    console.log('╚' + '═'.repeat(58) + '╝');

    console.log(`\n  Accuracy Score:  ${accuracyScore}`);
    console.log(`  Recommendation:  ${recommendation}\n`);

    // ──────────────────────────────────────────────
    // STEP 4 — Human-in-the-Loop Decision
    // ──────────────────────────────────────────────
    console.log('═'.repeat(60));
    console.log(' HUMAN REVIEW REQUIRED (HITL)');
    console.log('═'.repeat(60));

    if (recommendation === 'PUBLISH') {
      console.log(`\n🟢 Editor recommends PUBLISH (Accuracy: ${accuracyScore})\n`);
    } else if (recommendation === 'REVISE') {
      console.log(`\n🟡 Editor recommends REVISE (Accuracy: ${accuracyScore})\n`);
    } else if (recommendation === 'REJECT') {
      console.log(`\n🔴 Editor recommends REJECT (Accuracy: ${accuracyScore})\n`);
    }

    console.log('Options:');
    console.log('  [1] PUBLISH — Accept the post as-is and publish');
    console.log('  [2] REVISE  — Send back to writer with editor notes');
    console.log('  [3] REJECT  — Discard this post entirely');
    console.log('  [4] VIEW    — View full blog draft before deciding\n');

    let decision = '';
    while (!['1', '2', '3'].includes(decision)) {
      decision = (await ask(rl, 'Your decision [1/2/3/4]: ')).trim();
      if (decision === '4') {
        console.log('\n─── FULL BLOG DRAFT ───────────────────────────────────');
        console.log(blogDraft);
        console.log('───────────────────────────────────────────────────────\n');
      }
    }

    // ──────────────────────────────────────────────
    // STEP 5 — Execute Decision
    // ──────────────────────────────────────────────
    if (decision === '1') {
      // ── PUBLISH ─────────────────────────────────
      console.log('\n');
      console.log('╔' + '═'.repeat(58) + '╗');
      console.log('║  🚀 PUBLISHED — FINAL BLOG POST                        ║');
      console.log('╠' + '═'.repeat(58) + '╣');
      blogDraft.split('\n').forEach((l) => console.log(`║  ${l.padEnd(56)}║`));
      console.log('╚' + '═'.repeat(58) + '╝');
      console.log(`\n✅ Blog post published. Accuracy score: ${accuracyScore}\n`);

    } else if (decision === '2') {
      // ── REVISE ──────────────────────────────────
      console.log('\n🔄 Sending back to writer with editorial notes...\n');

      const revisionTask = await rpc('tasks.create', {
        agentId: 'writer',
        instruction: `Revise your blog post about "${TOPIC}" based on the editorial feedback below. Address each issue listed and make the required changes. Maintain the same structure and length.`,
        expectedOutput: 'A revised, fully corrected blog post in Markdown format addressing all editorial issues.',
        inputs: { topic: TOPIC },
        context: `--- ORIGINAL DRAFT ---\n${blogDraft}\n\n--- EDITORIAL FEEDBACK ---\n${editorialReview}\n\n--- ORIGINAL RESEARCH ---\n${researchSummary}`,
      });
      const revisionTaskId = String(revisionTask['taskId']);
      console.log(`  ↳ Revision task queued: ${revisionTaskId}`);
      console.log(`  ↳ Waiting up to ${WRITE_WAIT_MS / 1000}s for revised draft...\n`);

      const revisedDraft = await waitForTaskResult(driver, revisionTaskId, WRITE_WAIT_MS, 'revision');

      console.log('╔' + '═'.repeat(58) + '╗');
      console.log('║  ✏️  REVISED DRAFT                                      ║');
      console.log('╠' + '═'.repeat(58) + '╣');
      revisedDraft.split('\n').forEach((l) => console.log(`║  ${l.padEnd(56)}║`));
      console.log('╚' + '═'.repeat(58) + '╝');

      const publishRevised = (await ask(rl, '\nPublish the revised draft? [y/n]: ')).trim().toLowerCase();
      if (publishRevised === 'y') {
        console.log('\n✅ Revised blog post published.\n');
      } else {
        console.log('\n⏸  Revised draft saved but not published. Review it and re-run if needed.\n');
      }

    } else {
      // ── REJECT ──────────────────────────────────
      console.log('\n🗑  Post rejected and discarded.\n');
      console.log('Reason from editorial review:');
      const rationaleMatch = /Rationale\s*\n([\s\S]+)$/i.exec(editorialReview);
      if (rationaleMatch) console.log(rationaleMatch[1].trim());
      console.log('');
    }

    console.log('─'.repeat(60));
    console.log('Orchestration complete. View full execution trace at:');
    console.log(`  ${GATEWAY_URL}  (kaiban-board Socket.io: ws://${new URL(GATEWAY_URL).host})`);
    console.log('─'.repeat(60) + '\n');

  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error('[Orchestrator] Fatal error:', err);
  process.exit(1);
});
