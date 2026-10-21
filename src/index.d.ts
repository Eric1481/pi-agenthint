import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export interface AgentHintReportingConfig {
  enabled: boolean;
  endpoint: string;
  tokenEnv: string;
  timeoutMs: number;
  maxRetries: number;
  queueLimit: number;
}

export interface AgentHintConfig {
  enabled: boolean;
  agentType: string;
  suspendAfterMs: number;
  humanApprovalWaitMs: number;
  humanInputWaitMs: number;
  cacheControl: boolean;
  /** null derives the retention window from runtime signals; 0 sends only the pin. */
  cacheTtlS: number | null;
  priority: boolean;
  prediction: boolean;
  predictionWindow: number;
  predictionPolicy: 'mean' | 'p90' | 'max';
  predictionMinSamples: number;
  strictPriority: boolean;
  strictPriorityEnv: string;
  reporting: AgentHintReportingConfig;
}

export declare const DEFAULT_CONFIG: Readonly<AgentHintConfig>;
export declare class ConfigError extends Error {
  path: string;
}
export declare function parseConfig(value?: unknown): AgentHintConfig;
export declare function resolveConfig(options?: {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}): { config: AgentHintConfig; source: string; error?: string };
export declare function createAgentHintExtension(options?: {
  config?: AgentHintConfig;
  env?: Record<string, string | undefined>;
  now?: () => number;
  strictPriority?: { level: number; reason?: string };
  statusFetch?: typeof fetch;
}): ExtensionFactory;
