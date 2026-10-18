import type { Platform } from "../../src/index";

export interface EvalCase {
  id: string;
  repo: string;
  commit: string | null;
  expect: {
    unsupported?: boolean;
    minTools?: number;
    maxTools?: number;
    forbiddenFlags?: string[];
    gpu?: "none" | "any" | "nvidia" | "apple";
    excludesPlatforms?: Platform[];
    requiresSystem?: string[];
  };
  requests: { text: string; tool: string | null; args?: Record<string, string> }[];
}

export interface LevelResult {
  level: 1 | 2 | 3;
  passed: number;
  total: number;
  failures: string[];
}

export interface CaseReport {
  id: string;
  levels: LevelResult[];
  filesSent: number;
  totalFiles: number;
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}
