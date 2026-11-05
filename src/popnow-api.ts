import { APICallError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertBase64ToUint8Array,
  convertUint8ArrayToBase64,
  createBinaryResponseHandler,
  createStatusCodeErrorResponseHandler,
  delay,
  generateId,
  getFromApi,
  isAbortError,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import type { PopNowConfig, PopNowModelInfo } from './popnow-config';
import {
  PopNowTaskError,
  PopNowTaskTimeoutError,
  popnowEnvelopeResponseHandler,
  popnowFailedResponseHandler,
} from './popnow-error';

export type PopNowTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export interface PopNowTaskAsset {
  key?: string;
  /** Signed GET URL, valid for about 20 minutes. Fetched without the API key. */
  url?: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  bytes?: number;
  role?: string;
  pending?: boolean;
  unavailable?: boolean;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface PopNowTranscriptWord {
  text: string;
  start: number;
  end: number;
  type?: string;
  speakerId?: string;
}

export interface PopNowTaskRecord {
  taskId: string;
  model?: string;
  state: PopNowTaskState | (string & {});
  input?: Record<string, unknown>;
  output?: {
    text?: string;
    transcript?: {
      text?: string;
      language?: string;
      languageCode?: string;
      durationSeconds?: number;
      words?: PopNowTranscriptWord[];
    };
    assets?: PopNowTaskAsset[];
    [key: string]: unknown;
  };
  errorCode?: string;
  errorMessage?: string;
  costUsd?: string;
  settled?: boolean;
  createdAt?: string;
  deadlineAt?: string;
  completedAt?: string;
}

/** Options every PopNow model reads from `providerOptions.popnow`. Other keys go into the model input. */
export interface PopNowTaskOptions {
  /** First delay between status polls, in milliseconds. Default 2000; grows by 1.5x up to 15000. */
  pollIntervalMs?: number;
  /**
   * Overall polling budget in milliseconds. Defaults to the task's `deadlineAt` plus two
   * minutes, or one hour when the deadline is unknown.
   */
  pollTimeoutMs?: number;
  /** Seconds (0 to 60) the create call holds the connection open for a fast result. Default 60. */
  waitSeconds?: number;
  /**
   * Stable key for one logical generation. When omitted a new key is generated per call,
   * and the provider's own retries reuse it so they never create a second charge.
   */
  idempotencyKey?: string;
  /** Your own labels stored with the task (up to 16 string values). Not sent to the model. */
  metadata?: Record<string, string>;
}

export const TASK_OPTION_KEYS = new Set([
  'pollIntervalMs',
  'pollTimeoutMs',
  'waitSeconds',
  'idempotencyKey',
  'metadata',
]);

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const CREATE_MAX_RETRIES = 2;
const POLL_MAX_CONSECUTIVE_ERRORS = 3;
const MAX_POLL_INTERVAL_MS = 15_000;
const DEADLINE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const SCHEMA_TTL_MS = 10 * 60 * 1000;
/** Largest image PopNow accepts as an inline data URI (1 MiB decoded). */
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function isTaskDone(task: PopNowTaskRecord): boolean {
  if (!TERMINAL_STATES.has(task.state)) return false;
  return !(task.output?.assets ?? []).some((asset) => asset.pending && !asset.unavailable);
}

function isFullRecord(value: unknown): value is PopNowTaskRecord {
  return typeof value === 'object' && value !== null && 'settled' in value && 'createdAt' in value;
}

function retryAfterMs(error: APICallError): number | undefined {
  const value = error.responseHeaders?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : undefined;
}

export class PopNowApi {
  constructor(private readonly config: PopNowConfig) {}

  private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    const sleep = this.config._internal?.sleep;
    return sleep ? sleep(ms, abortSignal) : delay(ms, { abortSignal });
  }

  private headers(extra?: Record<string, string | undefined>) {
    const base = this.config.headers();
    const merged = combineHeaders(base, extra);
    // Keep this package's user agent when the AI SDK passes its own.
    const ownAgent = base['user-agent'];
    const callerAgent = extra?.['user-agent'];
    if (ownAgent && callerAgent && callerAgent !== ownAgent) merged['user-agent'] = `${callerAgent} ${ownAgent}`;
    return merged;
  }

  /** `GET /models/{model}` with its input schema, cached per provider for ten minutes. */
  getModel(modelId: string, abortSignal?: AbortSignal): Promise<PopNowModelInfo> {
    const cached = this.config.schemaCache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const path = modelId.split('/').map(encodeURIComponent).join('/');
    const promise = getFromApi({
      url: `${this.config.apiURL}/models/${path}`,
      headers: this.headers(),
      validateUrl: false,
      failedResponseHandler: popnowFailedResponseHandler,
      successfulResponseHandler: popnowEnvelopeResponseHandler<PopNowModelInfo>(),
      abortSignal,
      fetch: this.config.fetch,
    }).then((res) => res.value);
    this.config.schemaCache.set(modelId, { expiresAt: Date.now() + SCHEMA_TTL_MS, promise });
    // Do not keep failed lookups around.
    promise.catch(() => this.config.schemaCache.delete(modelId));
    return promise;
  }

  /**
   * `POST /jobs/createTask`. Sends an `Idempotency-Key` and retries connection errors,
   * 429 and retryable 5xx with the same key, so a retry never creates a second task.
   */
  async createTask({
    model,
    input,
    options,
    headers,
    abortSignal,
  }: {
    model: string;
    input: Record<string, unknown>;
    options: PopNowTaskOptions;
    headers?: Record<string, string | undefined>;
    abortSignal?: AbortSignal;
  }): Promise<{ value: PopNowTaskRecord; responseHeaders?: Record<string, string> }> {
    const idempotencyKey = options.idempotencyKey ?? generateId();
    const wait = Math.max(0, Math.min(60, Math.floor(options.waitSeconds ?? 60)));
    const url = `${this.config.apiURL}/jobs/createTask${wait > 0 ? `?wait=${wait}` : ''}`;
    const body: Record<string, unknown> = { model, input };
    if (options.metadata) body.metadata = options.metadata;

    for (let attempt = 0; ; attempt++) {
      try {
        return await postJsonToApi({
          url,
          headers: this.headers({ ...headers, 'Idempotency-Key': idempotencyKey }),
          body,
          failedResponseHandler: popnowFailedResponseHandler,
          successfulResponseHandler: popnowEnvelopeResponseHandler<PopNowTaskRecord>(),
          abortSignal,
          fetch: this.config.fetch,
        });
      } catch (error) {
        if (isAbortError(error) || !APICallError.isInstance(error) || !error.isRetryable) throw error;
        if (attempt >= CREATE_MAX_RETRIES) {
          // A caller-level retry would send a new key and could start a second task, so
          // only report the error as retryable when the caller supplied a stable key.
          if (options.idempotencyKey) throw error;
          throw new APICallError({
            message: error.message,
            url: error.url,
            requestBodyValues: error.requestBodyValues,
            statusCode: error.statusCode,
            responseHeaders: error.responseHeaders,
            responseBody: error.responseBody,
            data: error.data,
            cause: error,
            isRetryable: false,
          });
        }
        await this.sleep(retryAfterMs(error) ?? Math.min(500 * 2 ** attempt, 8000), abortSignal);
      }
    }
  }

  /** `GET /jobs/recordInfo`: the current task record. */
  async getTask(taskId: string, headers?: Record<string, string | undefined>, abortSignal?: AbortSignal) {
    return getFromApi({
      url: `${this.config.apiURL}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      headers: this.headers(headers),
      validateUrl: false,
      failedResponseHandler: popnowFailedResponseHandler,
      successfulResponseHandler: popnowEnvelopeResponseHandler<PopNowTaskRecord>(),
      abortSignal,
      fetch: this.config.fetch,
    });
  }

  /**
   * Creates a task and polls it until it is final and its files are ready. Throws
   * `PopNowTaskError` unless the task succeeded.
   */
  async runTask(args: {
    model: string;
    input: Record<string, unknown>;
    options: PopNowTaskOptions;
    headers?: Record<string, string | undefined>;
    abortSignal?: AbortSignal;
  }): Promise<{ task: PopNowTaskRecord; responseHeaders?: Record<string, string> }> {
    const { options, headers, abortSignal } = args;
    const created = await this.createTask(args);
    let task = created.value;
    let responseHeaders = created.responseHeaders;

    if (!(isFullRecord(task) && isTaskDone(task))) {
      const started = Date.now();
      let budget = options.pollTimeoutMs;
      let interval = Math.max(0, options.pollIntervalMs ?? 2000);
      let errors = 0;
      const taskId = task.taskId;

      for (;;) {
        if (budget === undefined) {
          const deadline = task.deadlineAt ? Date.parse(task.deadlineAt) : NaN;
          budget = Number.isFinite(deadline)
            ? Math.max(deadline + DEADLINE_GRACE_MS - started, DEADLINE_GRACE_MS)
            : DEFAULT_POLL_TIMEOUT_MS;
        }
        const remaining = budget - (Date.now() - started);
        if (remaining <= 0) {
          throw new PopNowTaskTimeoutError({ taskId, state: task.state, waitedMs: Date.now() - started });
        }
        await this.sleep(Math.min(interval, remaining), abortSignal);
        interval = Math.min(Math.max(interval * 1.5, 1), MAX_POLL_INTERVAL_MS);

        try {
          const res = await this.getTask(taskId, headers, abortSignal);
          task = res.value;
          responseHeaders = res.responseHeaders;
          errors = 0;
        } catch (error) {
          // Reading a task is safe to repeat; tolerate a few transient failures in a row.
          if (isAbortError(error) || !APICallError.isInstance(error) || !error.isRetryable) throw error;
          if (++errors >= POLL_MAX_CONSECUTIVE_ERRORS) throw error;
          continue;
        }
        if (isTaskDone(task)) break;
      }
    }

    if (task.state !== 'succeeded') throw new PopNowTaskError(task);
    return { task, responseHeaders };
  }

  /** Downloads an output file from its signed URL. The API key is never sent there. */
  async download(url: string, abortSignal?: AbortSignal): Promise<Uint8Array> {
    const { value } = await getFromApi({
      url,
      // The URL comes from a response body, so let provider-utils validate it.
      validateUrl: true,
      abortSignal,
      failedResponseHandler: createStatusCodeErrorResponseHandler(),
      successfulResponseHandler: createBinaryResponseHandler(),
      fetch: this.config.fetch,
    });
    return value;
  }

  /**
   * Turns bytes into something a media field accepts: a data URI for small images,
   * otherwise an upload (ticket, PUT, commit) that yields a `popnow://f/...` URI.
   */
  async toMediaReference(
    data: Uint8Array | string,
    mediaType: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const bytes = typeof data === 'string' ? convertBase64ToUint8Array(data) : data;
    const contentType = normalizeContentType(mediaType);
    if (INLINE_IMAGE_TYPES.has(contentType) && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
      const base64 = typeof data === 'string' ? data : convertUint8ArrayToBase64(bytes);
      return `data:${contentType};base64,${base64}`;
    }
    return this.upload(bytes, contentType, abortSignal);
  }

  /** Uploads a file in three calls and returns its `popnow://f/...` URI. */
  async upload(bytes: Uint8Array, contentType: string, abortSignal?: AbortSignal): Promise<string> {
    const { value: ticket } = await postJsonToApi({
      url: `${this.config.apiURL}/common/upload-url`,
      headers: this.headers(),
      body: { contentType, bytes: bytes.byteLength },
      failedResponseHandler: popnowFailedResponseHandler,
      successfulResponseHandler: popnowEnvelopeResponseHandler<{
        fileId: string;
        uploadUrl: string;
        method?: string;
        headers?: Record<string, string>;
      }>(),
      abortSignal,
      fetch: this.config.fetch,
    });

    // The upload URL is presigned: send the ticket's headers exactly, and never the API key.
    const putHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(ticket.headers ?? {})) {
      if (!['content-length', 'host', 'connection'].includes(key.toLowerCase())) putHeaders[key] = value;
    }
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const put = await fetchImpl(ticket.uploadUrl, {
      method: ticket.method || 'PUT',
      headers: putHeaders,
      body: bytes as BodyInit,
      signal: abortSignal,
    });
    if (!put.ok) {
      const text = await put.text().catch(() => '');
      throw new APICallError({
        message: `PopNow upload failed with HTTP ${put.status}: ${text.slice(0, 200)}`,
        url: ticket.uploadUrl,
        requestBodyValues: { contentType, bytes: bytes.byteLength },
        statusCode: put.status,
        responseBody: text,
        isRetryable: false,
      });
    }

    const { value: committed } = await postJsonToApi({
      url: `${this.config.apiURL}/files/${encodeURIComponent(ticket.fileId)}/commit`,
      headers: this.headers(),
      body: {},
      failedResponseHandler: popnowFailedResponseHandler,
      successfulResponseHandler: popnowEnvelopeResponseHandler<{ uri: string }>(),
      abortSignal,
      fetch: this.config.fetch,
    });
    return committed.uri;
  }
}

/** Maps common aliases to the media types PopNow uploads accept. */
export function normalizeContentType(mediaType: string): string {
  const type = mediaType.split(';')[0]!.trim().toLowerCase();
  switch (type) {
    case 'image/jpg':
      return 'image/jpeg';
    case 'audio/mp3':
    case 'audio/mpeg3':
      return 'audio/mpeg';
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/vnd.wave':
      return 'audio/wav';
    default:
      return type;
  }
}

/** Splits `providerOptions.popnow` into task options and model input fields. */
export function splitProviderOptions(raw: unknown): {
  taskOptions: PopNowTaskOptions;
  inputOverrides: Record<string, unknown>;
} {
  const taskOptions: Record<string, unknown> = {};
  const inputOverrides: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (TASK_OPTION_KEYS.has(key)) taskOptions[key] = value;
      else inputOverrides[key] = value;
    }
  }
  return { taskOptions: taskOptions as PopNowTaskOptions, inputOverrides };
}
