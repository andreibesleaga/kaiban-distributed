/**
 * Blog Team Configuration — mirrors the kaibanjs-node-demo pattern.
 * Three agents: Ava (Researcher) → Kai (Writer) → Morgan (Editor)
 *
 * LLM configuration from environment variables:
 *
 *   Standard OpenAI:
 *     OPENAI_API_KEY=sk-...
 *     LLM_MODEL=gpt-4o-mini  (optional, default)
 *
 *   OpenRouter (https://openrouter.ai):
 *     OPENROUTER_API_KEY=sk-or-v1-...
 *     LLM_MODEL=openai/gpt-4o-mini  (or any model on https://openrouter.ai/models)
 *
 *   Any OpenAI-compatible endpoint:
 *     OPENAI_API_KEY=your-key
 *     OPENAI_BASE_URL=http://your-endpoint/v1
 *     LLM_MODEL=your-model
 */
import type { KaibanAgentConfig } from '../../src/infrastructure/kaibanjs/kaiban-agent-bridge';

export const RESEARCHER_QUEUE = 'kaiban-agents-researcher';
export const WRITER_QUEUE     = 'kaiban-agents-writer';
export const EDITOR_QUEUE     = 'kaiban-agents-editor';
export const COMPLETED_QUEUE  = 'kaiban-events-completed';
export const STATE_CHANNEL    = 'kaiban-state-events';

/**
 * Resolve LLM config from environment variables.
 * Priority: OPENROUTER_API_KEY → OPENAI_API_KEY → undefined
 */
function buildLLMConfig(): KaibanAgentConfig['llmConfig'] | undefined {
  // OpenRouter (uses openai provider with apiBaseUrl override)
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (openrouterKey) {
    return {
      provider: 'openai',
      model: process.env['LLM_MODEL'] ?? 'openai/gpt-4o-mini',
      apiKey: openrouterKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apiBaseUrl: 'https://openrouter.ai/api/v1',
    } as any;
  }

  // Standard OpenAI or custom compatible endpoint
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    const config: KaibanAgentConfig['llmConfig'] = {
      provider: 'openai',
      model: process.env['LLM_MODEL'] ?? 'gpt-4o-mini',
      apiKey: openaiKey,
    };
    const baseUrl = process.env['OPENAI_BASE_URL'];
    if (baseUrl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ...config, apiBaseUrl: baseUrl } as any;
    }
    return config;
  }

  return undefined; // KaibanJS will use process.env.OPENAI_API_KEY as fallback
}

const llmConfig = buildLLMConfig();

/** Ava — finds facts and key developments on a topic */
export const researcherConfig: KaibanAgentConfig = {
  name: 'Ava',
  role: 'News Researcher',
  goal: 'Find and summarize the latest verifiable information on a given topic, citing sources where possible',
  background: 'Experienced data analyst and information gatherer with expertise in web research and fact verification. Always distinguishes confirmed facts from speculation.',
  maxIterations: 10,
  ...(llmConfig ? { llmConfig } : {}),
};

/** Kai — transforms research into engaging long-form content */
export const writerConfig: KaibanAgentConfig = {
  name: 'Kai',
  role: 'Content Creator',
  goal: 'Create engaging, well-structured blog posts based on provided research, making complex topics accessible',
  background: 'Skilled content writer specialising in technical and AI topics. Uses clear, direct language. Structures posts with a compelling headline, introduction, body sections, and conclusion.',
  maxIterations: 15,
  forceFinalAnswer: true,
  ...(llmConfig ? { llmConfig } : {}),
};

/** Morgan — editorial fact-checker and quality gate (PUBLISH / REVISE / REJECT) */
export const editorConfig: KaibanAgentConfig = {
  name: 'Morgan',
  role: 'Editorial Fact-Checker',
  goal: 'Review blog post drafts for factual accuracy and provide a concise editorial verdict',
  background: `You are a senior editorial fact-checker. Review the blog post against the research summary.
Your final answer MUST follow this exact format (no deviations):

## EDITORIAL REVIEW
**Topic:** [topic]
**Accuracy Score:** [0.0-10.0]/10
### Factual Assessment
[2-3 sentences on overall accuracy]
### Issues Found
- [main issue] — Severity: [HIGH|MEDIUM|LOW]
### Required Changes
- [one specific change]
### Recommendation: [PUBLISH|REVISE|REJECT]
### Rationale
[one sentence explaining the recommendation]`,
  maxIterations: 20,
  forceFinalAnswer: true,
  ...(llmConfig ? { llmConfig } : {}),
};
