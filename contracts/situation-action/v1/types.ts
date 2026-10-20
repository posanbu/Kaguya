/** 框架无关的情境—行动契约。两端可复制类型和样例，不共享运行时实现。 */
export const CONTRACT_VERSION = "1.0.0" as const;

export interface EvidenceInput {
  id: string;
  sceneId: string;
  source:
    "onebot" | "composer" | "clock" | "recall" | "tool" | "delivery" | "system";
  actorId: string;
  occurredAt: string;
  kind:
    "message" | "correction" | "clock" | "recall" | "tool-result" | "delivery";
  text: string;
  replaces: string[];
}

export interface EvidenceRecord extends EvidenceInput {
  sequence: number;
  receivedAt: string;
}

export interface RecallSnapshot {
  sceneId: string;
  revision: string;
  items: { id: string; text: string; evidenceIds: string[] }[];
}

export interface SituationFrame {
  contractVersion: typeof CONTRACT_VERSION;
  id: string;
  agentId: string;
  frozenAt: string;
  background: {
    through: number;
    evidence: EvidenceRecord[];
    continuation: boolean;
  };
  current: {
    sceneId: string;
    evidence: EvidenceRecord[];
  };
  recalls: RecallSnapshot[];
  selection?:
    | {
        backgroundHistoryOmitted: boolean;
        omittedRecalls: { sceneId: string; revision: string }[];
      }
    | undefined;
  changes: {
    baseManifestId: string | null;
    evidenceIds: string[];
    invalidatedEvidenceIds: string[];
  };
}

export type ActionStatus =
  | "planned"
  | "queued"
  | "running"
  | "waiting"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded"
  | "unknown"
  | "silent";

export interface ActionRecord {
  id: string;
  sequence: number;
  revision: number;
  manifestId: string;
  frameId: string;
  sceneId: string;
  kind: "message" | "tool" | "wait" | "silent";
  text: string;
  basis: { evidenceId: string; sceneId: string; text: string }[];
  dependencies: string[];
  status: ActionStatus;
  result: string | null;
  receiptId: string | null;
  processed: boolean;
  commitment: string | null;
  dueAt: string | null;
  tool: {
    callId: string;
    name: string;
    arguments: string;
    result: string | null;
  } | null;
}

export interface ContinuityCheckpoint {
  id: string;
  revision: number;
  previousId: string | null;
  coveredRanges: { from: number; through: number }[];
  outcomes: {
    actionId: string;
    status: ActionStatus;
    result: string | null;
    receiptId: string | null;
  }[];
  openActionIds: string[];
  commitments: { actionId: string; text: string }[];
  waits: { actionId: string; dueAt: string | null }[];
}

export interface ContextManifest {
  contractVersion: typeof CONTRACT_VERSION;
  id: string;
  agentId: string;
  sessionEpoch: string;
  stepKey: string;
  policyVersion: string;
  budget: { maxBytes: number; reservedBytes: number };
  frame: SituationFrame;
  checkpoint: ContinuityCheckpoint;
  actions: ActionRecord[];
  rules: string;
  rendered: string;
}
