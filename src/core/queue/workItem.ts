export type WorkItemState =
  | 'pending'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'retryable_failed'
  | 'permanent_failed'
  | 'partial'
  | 'cancelled';

export interface WorkItemRow {
  work_item_id: string;
  source: string;
  queue: string;
  entity_type: string;
  scope_key: string;
  params_json: string;
  priority: number;
  state: WorkItemState;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  depends_on: string | null;
}

export interface EnqueueSpec {
  source: string;
  queue: string;
  entityType: string;
  scopeKey: string;
  params?: unknown;
  priority?: number;
  maxAttempts?: number;
  dependsOn?: string;
}

export function workItemId(source: string, queue: string, scopeKey: string): string {
  return `${source}::${queue}::${scopeKey}`;
}

export function leaseOwnerId(runId: string): string {
  return `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'host'}:${process.pid}:${runId}`;
}
