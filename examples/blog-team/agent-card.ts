/**
 * AgentCard skill parsing (A2A v0.3, ADR-015).
 *
 * A2A v0.3 turned `capabilities` into an OBJECT and moved an agent's discrete
 * abilities into `skills: Array<{ id?, name? }>` (the legacy v0.2 card exposed a
 * flat `capabilities: string[]`). The blog-team orchestrator used to do
 * `card.capabilities.join(', ')`, which on a v0.3 card threw the live crash
 * `card.capabilities.join is not a function` because `capabilities` is now `{}`.
 *
 * This pure helper reads ONLY `skills[]` (never `capabilities`) and returns the
 * joined human label (`name ?? id`) for each entry, ignoring blank ones. A v0.3
 * card with no `skills` (capabilities is an object) yields '' rather than throwing.
 */
export interface AgentCardSkills {
  skills?: Array<{ id?: string; name?: string }>;
}

/** Join an AgentCard's `skills[]` into a `name ?? id` comma-separated label. */
export function parseAgentCardSkills(card: AgentCardSkills): string {
  return (card.skills ?? [])
    .map((s) => s.name ?? s.id)
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
