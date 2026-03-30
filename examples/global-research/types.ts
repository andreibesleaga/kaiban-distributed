/**
 * ResearchState defines the lifecycle of the intent
 * as it moves through the Actor mesh.
 */
export type ResearchStatus =
  | 'INITIALIZED'
  | 'SEARCHING'
  | 'AGGREGATING'
  | 'REVIEWING'
  | 'AWAITING_VALIDATION'
  | 'COMPLETED'
  | 'FAILED';

export interface SearchResult {
  sourceUrl: string;
  title: string;
  snippet: string;
  relevanceScore: number;
  agentId: string;
  timestamp: string;
}

export interface ReviewFeedback {
  isApproved: boolean;
  critique: string;
  complianceViolations: string[];
  suggestedFixes?: string;
}

/**
 * The ResearchContext is the "Message" passed between Actors.
 * It must be fully serializable to JSON for Redis storage.
 */
export interface ResearchContext {
  // 1. Identity & Intent
  id: string;
  originalQuery: string;
  status: ResearchStatus;

  // 2. Data Aggregation (Fan-out/Fan-in)
  rawSearchData: SearchResult[];
  consolidatedDraft?: string;

  // 3. Governance & HITL
  feedback?: ReviewFeedback;
  editorApproval: boolean;

  // 4. Metadata (Economics & Traceability)
  metadata: {
    totalTokens: number;
    estimatedCost: number;
    startTime: string;
    endTime?: string;
    activeNodes: string[];
  };
}
