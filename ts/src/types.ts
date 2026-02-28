export interface Belief {
  id: string; // UUID
  content: string;
  domain: string;
  confidence: number;
  tension: number;
  reinforcement_count: number;
  importance: number;
  is_active: boolean;
  superseded_by: string | null;
  created_at: Date;
  last_reinforced: Date | null;
  last_challenged: Date | null;
  revised_at: Date | null;
}

export interface BeliefConnection {
  belief_a: string;
  belief_b: string;
  strength: number;
  relation: RelationType;
  discovery_method: DiscoveryMethod;
  discovery_reasoning: string | null;
  discovered_at: Date;
}

export type RelationType =
  | "supports"
  | "contradicts"
  | "depends_on"
  | "generalizes"
  | "tension_shares";

export type DiscoveryMethod = "seed" | "llm_revision" | "llm_evidence" | "manual";

export interface Evidence {
  claim: string;
  evidence_type: "factual" | "feedback" | "outcome";
  relevance: string;
  stance: "reinforcing" | "contradicting" | "neutral";
  belief_id: string | null;
  strength: number;
}

export interface Interaction {
  id: string;
  session_id: string;
  user_message: string;
  assistant_response: string | null;
  extracted_claims: Evidence[] | null;
  dissatisfaction_at_time: number | null;
  revision_triggered: boolean;
  created_at: Date;
}

export interface Revision {
  id: string;
  old_belief_id: string;
  new_belief_id: string;
  trigger_tension: number;
  evidence_summary: string;
  cascaded_beliefs: string[];
  reasoning: string;
  created_at: Date;
}

export interface RevisionResult {
  status: "revised" | "error" | "cascade_limit";
  old_belief?: string;
  new_belief?: string;
  analysis?: string;
  reasoning?: string;
  behavioral_changes?: string[];
  stored_connections?: number;
  discovered_connections?: number;
  discovered_details?: Array<{
    content: string;
    relation: string;
    reasoning: string;
  }>;
  cascades?: RevisionResult[];
  error?: string;
  belief_id?: string;
}

export interface InteractionResult {
  response: string;
  session_id: string;
  dissatisfaction: number;
  dissatisfaction_state: string;
  evidence_extracted: number;
  pre_revisions: RevisionResult[];
  post_revisions: RevisionResult[];
  beliefs_count: number;
  tools_used?: Array<{ name: string; input: any; output: string }>;
}
