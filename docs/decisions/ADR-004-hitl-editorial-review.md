# ADR-004: Human-in-the-Loop (HITL) — Editorial Review Gate

**Date:** 2026-03-10
**Status:** Accepted
**Deciders:** Engineering Team

---

## Context

The blog-team example demonstrates a multi-agent pipeline (Researcher → Writer → Editor). After the editor agent (Morgan) produces a review, a decision must be made about whether to publish, revise, or reject the content. This decision is high-stakes and benefits from human judgment.

## Decision

Add a mandatory HITL gate after Morgan's editorial review in the orchestrator (`examples/blog-team/orchestrator.ts`):

1. Orchestrator **pauses** execution after receiving Morgan's review
2. Displays the full structured review (accuracy score, issues, recommendation)
3. Prompts the human with four options: **PUBLISH**, **REVISE**, **REJECT**, or **VIEW** (draft)
4. Based on human choice:
   - **PUBLISH** → prints final blog post
   - **REVISE** → re-submits draft + editor notes to the writer; presents revised draft for confirmation
   - **REJECT** → displays rationale and ends workflow

## Considered Alternatives

| Option | Pros | Cons |
|--------|------|------|
| Auto-publish on Morgan's PUBLISH recommendation | Fully automated | Risk of factual errors reaching production |
| Auto-reject on any HIGH severity issue | Conservative | Too rigid; kills legitimate content |
| **Human decision with AI recommendation** ✓ | Human judgment + AI efficiency | Requires interactive terminal |

## Consequences

- `orchestrator.ts` uses Node.js `readline` for HITL prompt (no new dependencies)
- The REVISE path re-uses existing writer queue infrastructure
- Constitution Article VI ("HITL for high-stakes decisions") is satisfied
- The editor's `background` field enforces strict output format (Markdown with `Recommendation:` line) for reliable parsing by `parseRecommendation()`
