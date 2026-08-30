export const PIPELINE_STAGES = [
  'preflight',
  'catalogue-check',
  'ebay-ingest',
  'ebay-match',
  'psa-cert',
  'ebay-rematch',
  'psa-identity',
  'psa-fetch',
  'assemble',
  'validate',
  'publish',
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];
export type PipelineRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PipelineStageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PipelineConfig {
  queries: string[];
  marketplaces: string[];
  maxItems: number;
  pageLimit: number;
  concurrency: number;
  psaMaxAgeDays: number;
  salesAuditDays: number;
  allSales: boolean;
}

export interface PipelineRun {
  pipelineRunId: string;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  status: PipelineRunStatus;
  activeStage: PipelineStage | null;
  config: PipelineConfig;
  errorMessage: string | null;
}

export interface PipelineStageResult {
  pipelineRunId: string;
  stage: PipelineStage;
  status: PipelineStageStatus;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface MatchDecisionRevision {
  revisionId: number;
  sourceRecordId: number;
  observationId: number | null;
  matcherVersion: string;
  tier: string;
  status: string;
  targetType: 'card' | 'variant' | null;
  targetId: number | null;
}

export interface CoverageState {
  status: 'in_progress' | 'complete' | 'cutoff' | 'unknown';
  evidence: string | null;
  updatedAt: string;
}

export interface PublicationGeneration {
  generationId: string;
  pipelineRunId: string | null;
  status: 'assembling' | 'validated' | 'published' | 'failed';
  snapshotPath: string | null;
  createdAt: string;
  publishedAt: string | null;
}
