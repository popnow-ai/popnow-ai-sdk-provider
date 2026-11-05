import type { FetchFunction } from '@ai-sdk/provider-utils';

/** Shared configuration handed from the provider to every model it creates. */
export interface PopNowConfig {
  /** Provider name for logging, for example `popnow.image`. */
  provider: string;
  /** Native task API root, for example `https://api.popnow.ai/api/v1`. */
  apiURL: string;
  /** Returns the auth and custom headers for PopNow API requests. */
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  /** Shared cache of model input schemas, keyed by model ID. */
  schemaCache: Map<string, { expiresAt: number; promise: Promise<PopNowModelInfo> }>;
  _internal?: {
    currentDate?: () => Date;
    /** Overrides the delay used for retries and polling (tests). */
    sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
  };
}

/** The subset of `GET /api/v1/models/{model}` this package reads. */
export interface PopNowModelInfo {
  model: string;
  modality?: string;
  available?: boolean;
  inputSchema?: PopNowJsonSchema;
}

export interface PopNowJsonSchema {
  type?: string | string[];
  properties?: Record<string, PopNowJsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: PopNowJsonSchema;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  [key: string]: unknown;
}
