import { AISDKError, APICallError } from '@ai-sdk/provider';
import { extractResponseHeaders, type ResponseHandler } from '@ai-sdk/provider-utils';

/** The `{ code, msg, data, request_id }` envelope every native PopNow JSON response uses. */
export interface PopNowEnvelope<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
  request_id?: string;
}

/** Business codes the PopNow docs list as safe to retry with the same Idempotency-Key. */
const RETRYABLE_CODES = new Set([429, 500, 503, 50301]);
/** HTTP statuses worth retrying when the body is not a PopNow envelope (edge and proxy errors). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function isEnvelope(value: unknown): value is PopNowEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'number'
  );
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function buildApiCallError({
  response,
  url,
  requestBodyValues,
  text,
  json,
}: {
  response: Response;
  url: string;
  requestBodyValues: unknown;
  text: string;
  json: unknown;
}): APICallError {
  const responseHeaders = extractResponseHeaders(response);
  const requestId =
    (isEnvelope(json) ? json.request_id : undefined) ?? response.headers.get('x-request-id') ?? undefined;
  const suffix = requestId ? ` (request_id: ${requestId})` : '';

  if (isEnvelope(json)) {
    // A 2xx response can still carry a non-200 business code.
    const code = json.code === 200 ? response.status : json.code;
    return new APICallError({
      message: `PopNow API error ${code}: ${json.msg || response.statusText || 'Request failed'}${suffix}`,
      url,
      requestBodyValues,
      statusCode: response.status,
      responseHeaders,
      responseBody: text,
      isRetryable: RETRYABLE_CODES.has(code),
      data: json,
    });
  }

  return new APICallError({
    message: `Unexpected response from PopNow (HTTP ${response.status}): ${text.slice(0, 200)}${suffix}`,
    url,
    requestBodyValues,
    statusCode: response.status,
    responseHeaders,
    responseBody: text,
    isRetryable: RETRYABLE_STATUSES.has(response.status),
  });
}

/** Unwraps a successful envelope (`code === 200`) and throws `APICallError` for anything else. */
export function popnowEnvelopeResponseHandler<T>(): ResponseHandler<T> {
  return async ({ response, url, requestBodyValues }) => {
    const text = await response.text();
    const json = parseJson(text);
    if (isEnvelope(json) && json.code === 200) {
      return {
        value: json.data as T,
        rawValue: json,
        responseHeaders: extractResponseHeaders(response),
      };
    }
    throw buildApiCallError({ response, url, requestBodyValues, text, json });
  };
}

/** Maps a non-2xx PopNow response to `APICallError`, using the envelope's business code. */
export const popnowFailedResponseHandler: ResponseHandler<APICallError> = async ({
  response,
  url,
  requestBodyValues,
}) => {
  const text = await response.text();
  const json = parseJson(text);
  return {
    value: buildApiCallError({ response, url, requestBodyValues, text, json }),
    rawValue: json,
    responseHeaders: extractResponseHeaders(response),
  };
};

const taskErrorMarker = 'vercel.ai.error.AI_PopNowTaskError';
const taskErrorSymbol = Symbol.for(taskErrorMarker);

/**
 * A PopNow task reached a final state other than `succeeded`. Only succeeded tasks are
 * charged: for `failed` and `expired` tasks the USD hold is released in full.
 */
export class PopNowTaskError extends AISDKError {
  private readonly [taskErrorSymbol] = true;

  readonly taskId: string;
  readonly state: string;
  /** Task failure code, for example `content_rejected` or `upstream_failed`. */
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
  /** USD decimal string: the final charge once `settled` is true. */
  readonly costUsd: string | undefined;
  readonly settled: boolean | undefined;

  constructor(task: {
    taskId: string;
    state: string;
    errorCode?: string;
    errorMessage?: string;
    costUsd?: string;
    settled?: boolean;
  }) {
    const detail = task.errorCode
      ? `${task.errorCode}: ${task.errorMessage ?? 'no detail'}`
      : task.errorMessage ?? 'no detail';
    super({
      name: 'AI_PopNowTaskError',
      message:
        `PopNow task ${task.taskId} ended as ${task.state} (${detail}). ` +
        'Tasks that do not succeed are not charged; the USD hold is released.',
    });
    this.taskId = task.taskId;
    this.state = task.state;
    this.errorCode = task.errorCode;
    this.errorMessage = task.errorMessage;
    this.costUsd = task.costUsd;
    this.settled = task.settled;
  }

  static isInstance(error: unknown): error is PopNowTaskError {
    return AISDKError.hasMarker(error, taskErrorMarker);
  }
}

const timeoutErrorMarker = 'vercel.ai.error.AI_PopNowTaskTimeoutError';
const timeoutErrorSymbol = Symbol.for(timeoutErrorMarker);

/**
 * Polling gave up before the task reached a final state. The task keeps running on
 * PopNow; read it later with `GET /api/v1/jobs/recordInfo?taskId=...`.
 */
export class PopNowTaskTimeoutError extends AISDKError {
  private readonly [timeoutErrorSymbol] = true;

  readonly taskId: string;
  readonly state: string;

  constructor({ taskId, state, waitedMs }: { taskId: string; state: string; waitedMs: number }) {
    super({
      name: 'AI_PopNowTaskTimeoutError',
      message: `PopNow task ${taskId} is still ${state} after waiting ${waitedMs} ms. The task keeps running.`,
    });
    this.taskId = taskId;
    this.state = state;
  }

  static isInstance(error: unknown): error is PopNowTaskTimeoutError {
    return AISDKError.hasMarker(error, timeoutErrorMarker);
  }
}
