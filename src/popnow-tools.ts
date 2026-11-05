import { APICallError } from '@ai-sdk/provider';
import { tool, type Tool } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { PopNowApi, type PopNowQuote, type PopNowTaskRecord } from './popnow-api';
import type { PopNowConfig } from './popnow-config';
import { resolvePopNowSettings, type PopNowProviderSettings } from './popnow-provider';

export const DEFAULT_IMAGE_MODEL = 'google/nano-banana-2.1/text-to-image';
export const DEFAULT_IMAGE_EDIT_MODEL = 'google/nano-banana-2.1/edit';
export const DEFAULT_VIDEO_MODEL = 'minimax/h3/text-to-video';
export const DEFAULT_IMAGE_TO_VIDEO_MODEL = 'minimax/h3/image-to-video';
export const DEFAULT_MUSIC_MODEL = 'suno/v6/text-to-audio';
export const DEFAULT_SPEECH_MODEL = 'google/gemini-3.8-flash-tts/text-to-speech';

/** Default hard ceiling for one paid tool call, in USD. */
export const DEFAULT_MAX_USD_PER_CALL = '0.50';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const SERVER_WAIT_SECONDS = 30;
const KEYS_URL = 'https://popnow.ai/api/console/keys';
const BILLING_URL = 'https://popnow.ai/api/console/billing';
const USD_PATTERN = /^\d+(\.\d{1,9})?$/;

export interface PopNowToolQuoteEvent {
  /** Which PopNow tool asked for the quote: `generateImage`, `generateVideo`, `generateMusic` or `generateSpeech`. */
  toolName: string;
  toolCallId: string;
  model: string;
  input: Record<string, unknown>;
  quote: PopNowQuote;
}

export interface PopNowToolsSettings extends PopNowProviderSettings {
  /**
   * Hard USD ceiling for one paid call, as a decimal string such as `'0.50'`. Every paid call is
   * quoted first (free); a quote whose maximum charge is above this amount is refused and
   * nothing is created or charged. Default `'0.50'`. Set `null` to remove the ceiling.
   */
  maxUsdPerCall?: string | null;
  /**
   * Optional USD budget for all paid calls made through this tool set (or this single tool).
   * Tasks are counted at their quoted maximum until they settle, at their final cost after.
   * Tasks that fail are not counted. No default.
   */
  maxUsdTotal?: string;
  /**
   * Called with every quote that is within the limits, before the task is created. Return
   * `false` to decline the call (nothing is created or charged), for example to ask a person.
   */
  onQuote?: (event: PopNowToolQuoteEvent) => boolean | void | PromiseLike<boolean | void>;
  /**
   * How long a paid tool waits for its result, in milliseconds. When it runs out the tool
   * returns `status: 'running'` with the task id; the task keeps running and the
   * `getTask` tool collects it. Default 300000 (five minutes).
   */
  waitTimeoutMs?: number;
  /** First delay between status polls, in milliseconds. Default 2000; grows by 1.5x up to 15000. */
  pollIntervalMs?: number;
  /** Let the agent pick another PopNow model id per call. Default `true`. Limits still apply. */
  allowModelOverride?: boolean;
  /** Default model ids used when the agent does not pass `model`. */
  models?: {
    image?: string;
    imageEdit?: string;
    video?: string;
    imageToVideo?: string;
    music?: string;
    speech?: string;
  };
  /** @internal Test hooks. */
  _internal?: PopNowConfig['_internal'];
}

export interface PopNowToolOutputFile {
  /** Signed download URL. It expires (see `expiresAt`); fetch it without the API key. */
  url?: string;
  /** Stable `popnow://g/<taskId>/<n>` reference that never expires and works as input to other PopNow tools. */
  uri: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  expiresAt?: string;
}

export type PopNowToolResult =
  | {
      status: 'succeeded';
      taskId: string;
      model: string;
      costUsd?: string;
      outputs: PopNowToolOutputFile[];
      text?: string;
      ignoredFields?: string[];
      note: string;
    }
  | {
      status: 'running';
      taskId: string;
      model: string;
      state: string;
      maxChargeUsd?: string;
      note: string;
    }
  | {
      status: 'failed';
      taskId: string;
      model: string;
      state: string;
      errorCode?: string;
      errorMessage?: string;
      note: string;
    }
  | {
      status: 'over_limit';
      model: string;
      maxChargeUsd: string;
      expectedChargeUsd?: string;
      limit: 'per_call' | 'total';
      limitUsd: string;
      remainingUsd?: string;
      note: string;
    }
  | {
      status: 'declined';
      model: string;
      maxChargeUsd: string;
      note: string;
    };

export interface PopNowImageToolInput {
  prompt: string;
  imageUrls?: string[];
  aspectRatio?: string;
  resolution?: string;
  model?: string;
  extraInput?: Record<string, unknown>;
}

export interface PopNowVideoToolInput {
  prompt: string;
  imageUrl?: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  model?: string;
  extraInput?: Record<string, unknown>;
}

export interface PopNowMusicToolInput {
  prompt: string;
  lyrics?: string;
  instrumental?: boolean;
  title?: string;
  model?: string;
  extraInput?: Record<string, unknown>;
}

export interface PopNowSpeechToolInput {
  text: string;
  voiceId?: string;
  style?: string;
  model?: string;
  extraInput?: Record<string, unknown>;
}

export interface PopNowListModelsToolInput {
  modality?: 'image' | 'video' | 'audio';
  search?: string;
  task?: string;
  model?: string;
  limit?: number;
}

export interface PopNowGetTaskToolInput {
  taskId: string;
  waitSeconds?: number;
}

export type PopNowListModelsToolResult =
  | { total?: number; returned: number; models: Array<Record<string, unknown>> }
  | Record<string, unknown>;

export type PopNowTools = {
  generateImage: Tool<PopNowImageToolInput, PopNowToolResult>;
  generateVideo: Tool<PopNowVideoToolInput, PopNowToolResult>;
  generateMusic: Tool<PopNowMusicToolInput, PopNowToolResult>;
  generateSpeech: Tool<PopNowSpeechToolInput, PopNowToolResult>;
  listModels: Tool<PopNowListModelsToolInput, PopNowListModelsToolResult>;
  getTask: Tool<PopNowGetTaskToolInput, PopNowToolResult>;
};

// USD amounts are handled as integer nano-dollars so that limits compare exactly.
function parseUsd(value: string, name: string): bigint {
  const text = value.trim().replace(/^\$/, '');
  if (!USD_PATTERN.test(text)) {
    throw new Error(`${name} must be a USD amount such as '0.50' with at most nine decimals (got '${value}').`);
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function formatUsd(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const fraction = (nano % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Turns an API error into an error message the agent can act on. */
function toolError(error: unknown): unknown {
  if (!APICallError.isInstance(error)) return error;
  const data = error.data as { code?: number } | undefined;
  const code = data?.code ?? error.statusCode;
  let hint = '';
  if (code === 40201) hint = ` The PopNow API balance is too low; add funds at ${BILLING_URL}.`;
  else if (code === 40202) hint = ' A spend cap on this PopNow API key was reached.';
  else if (error.statusCode === 401) hint = ` Check the PopNow API key (${KEYS_URL}).`;
  else if (code === 40901) hint = ' The quote expired or the price changed; call the tool again for a new quote.';
  else if (error.statusCode === 400 || error.statusCode === 422)
    hint = ' Check the model input fields with the list models tool (pass model=<id>).';
  return new Error(`${error.message}.${hint}`, { cause: error });
}

const MODEL_DESCRIPTION =
  'Optional PopNow model id, for example "kling/3.0/text-to-video". Leave empty for the default. Use the list models tool to find ids.';
const EXTRA_DESCRIPTION =
  'Optional extra model-specific input fields (snake_case), exactly as listed by the list models tool for that model.';
const PAID_NOTE =
  'Paid: each call is priced first and only runs when the price is within the limit set by the developer.';

function createContext(settings: PopNowToolsSettings) {
  const { config } = resolvePopNowSettings(settings);
  const toolConfig = config('popnow.tools');
  if (settings._internal) toolConfig._internal = settings._internal;
  const api = new PopNowApi(toolConfig);

  const perCall =
    settings.maxUsdPerCall === null
      ? undefined
      : parseUsd(settings.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL, 'maxUsdPerCall');
  const total = settings.maxUsdTotal === undefined ? undefined : parseUsd(settings.maxUsdTotal, 'maxUsdTotal');
  let committed = 0n;
  const waitTimeoutMs = Math.max(0, settings.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const allowOverride = settings.allowModelOverride ?? true;

  function resolveModel(requested: string | undefined, fallback: string): string {
    const chosen = requested?.trim();
    if (!chosen) return fallback;
    if (!allowOverride && chosen !== fallback) {
      throw new Error(`This tool is configured to use ${fallback} only.`);
    }
    return chosen;
  }

  /**
   * Leaves out convenience fields the model's schema does not have, so a generic argument
   * such as aspectRatio never makes a model reject the request.
   */
  async function fitToSchema(
    model: string,
    fields: Record<string, unknown>,
    extra: Record<string, unknown> | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ input: Record<string, unknown>; ignored: string[] }> {
    const present = compact(fields);
    let properties: Record<string, unknown> | undefined;
    try {
      properties = (await api.getModel(model, abortSignal)).inputSchema?.properties;
      if (properties && Object.keys(properties).length === 0) properties = undefined;
    } catch {
      // The quote reports unknown models and fields precisely; send everything.
    }
    const ignored: string[] = [];
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(present)) {
      if (!properties || key in properties) {
        input[key] = value;
      } else if (key === 'image_urls' && 'image_url' in properties && Array.isArray(value) && value.length === 1) {
        input.image_url = value[0];
      } else if (key === 'image_url' && 'image_urls' in properties) {
        input.image_urls = [value];
      } else {
        ignored.push(key);
      }
    }
    return { input: { ...input, ...(extra ?? {}) }, ignored };
  }

  function summarize(
    task: PopNowTaskRecord,
    model: string,
    extra: { ignored?: string[]; maxChargeUsd?: string } = {},
  ): PopNowToolResult {
    const taskModel = task.model ?? model;
    if (task.state === 'succeeded') {
      const outputs: PopNowToolOutputFile[] = [];
      (task.output?.assets ?? []).forEach((asset, index) => {
        if (asset.unavailable || asset.deleted) return;
        outputs.push(
          compact({
            url: asset.url,
            uri: `popnow://g/${task.taskId}/${index}`,
            mime: asset.mime,
            width: asset.width,
            height: asset.height,
            durationSeconds: asset.durationSeconds,
            expiresAt: asset.expiresAt,
          }),
        );
      });
      return compact({
        status: 'succeeded' as const,
        taskId: task.taskId,
        model: taskModel,
        costUsd: task.costUsd,
        outputs,
        text: task.output?.text,
        ignoredFields: extra.ignored?.length ? extra.ignored : undefined,
        note: 'Signed download URLs expire after about 20 minutes. The popnow:// uri never expires and can be passed to another PopNow tool.',
      });
    }
    if (['failed', 'canceled', 'expired'].includes(task.state)) {
      return compact({
        status: 'failed' as const,
        taskId: task.taskId,
        model: taskModel,
        state: task.state,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        note: 'The task did not succeed and is not charged; its USD hold is released.',
      });
    }
    return compact({
      status: 'running' as const,
      taskId: task.taskId,
      model: taskModel,
      state: task.state,
      maxChargeUsd: extra.maxChargeUsd ?? task.estimatedCostUsd,
      note: 'Still running. Call the get task tool with this taskId to collect the result.',
    });
  }

  async function runPaid(
    toolName: string,
    model: string,
    input: Record<string, unknown>,
    ignored: string[],
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<PopNowToolResult> {
    const { abortSignal } = options;
    const started = Date.now();
    try {
      const quote = await api.quote({ model, input, abortSignal });
      const priceText = quote.maxChargeUsd ?? (typeof quote.maxCharge === 'string' ? quote.maxCharge : undefined);
      // Never create a task whose price was not checked.
      if (!priceText) throw new Error('PopNow returned a quote without a price, so nothing was created.');
      const price = parseUsd(priceText, 'maxChargeUsd');
      const base = { model: quote.model ?? model, maxChargeUsd: formatUsd(price), expectedChargeUsd: quote.expectedChargeUsd };

      if (perCall !== undefined && price > perCall) {
        return compact({
          status: 'over_limit' as const,
          ...base,
          limit: 'per_call' as const,
          limitUsd: formatUsd(perCall),
          note: 'This exceeds the per-call USD limit set by the developer. Nothing was started or charged. Try a cheaper model, a shorter duration or a lower resolution.',
        });
      }
      if (total !== undefined && committed + price > total) {
        return compact({
          status: 'over_limit' as const,
          ...base,
          limit: 'total' as const,
          limitUsd: formatUsd(total),
          remainingUsd: formatUsd(total > committed ? total - committed : 0n),
          note: 'This exceeds the remaining USD budget set by the developer. Nothing was started or charged.',
        });
      }
      if (settings.onQuote) {
        const approved = await settings.onQuote({ toolName, toolCallId: options.toolCallId, model, input, quote });
        if (approved === false) {
          return {
            status: 'declined',
            model: base.model,
            maxChargeUsd: base.maxChargeUsd,
            note: 'The call was declined before it started. Nothing was started or charged.',
          };
        }
        // Another call may have used the budget while this one waited for approval.
        if (total !== undefined && committed + price > total) {
          return compact({
            status: 'over_limit' as const,
            ...base,
            limit: 'total' as const,
            limitUsd: formatUsd(total),
            remainingUsd: formatUsd(total > committed ? total - committed : 0n),
            note: 'This exceeds the remaining USD budget set by the developer. Nothing was started or charged.',
          });
        }
      }

      // Reserve the quoted maximum before creating, so parallel calls cannot overspend.
      committed += price;
      let reserved = price;
      try {
        const waitSeconds = Math.min(SERVER_WAIT_SECONDS, Math.floor(waitTimeoutMs / 1000));
        const created = await api.createTask({
          model,
          input,
          quoteId: quote.quoteId,
          expectedCostUsd: priceText,
          options: { waitSeconds },
          abortSignal,
        });
        const waited = await api.waitForTask(created.value, {
          timeoutMs: Math.max(0, waitTimeoutMs - (Date.now() - started)),
          pollIntervalMs: settings.pollIntervalMs,
          abortSignal,
        });
        const task = waited.task;
        if (waited.done && task.state !== 'succeeded') {
          committed -= reserved;
          reserved = 0n;
        } else if (waited.done && task.settled && task.costUsd && USD_PATTERN.test(task.costUsd)) {
          const actual = parseUsd(task.costUsd, 'costUsd');
          committed += actual - reserved;
          reserved = actual;
        }
        return summarize(task, model, { ignored, maxChargeUsd: base.maxChargeUsd });
      } catch (error) {
        // A create call that was rejected holds nothing. After a network error the task may
        // exist, so the reservation stays.
        if (APICallError.isInstance(error) && !error.isRetryable && error.statusCode !== undefined) {
          committed -= reserved;
        }
        throw error;
      }
    } catch (error) {
      throw toolError(error);
    }
  }

  return {
    api,
    models: {
      image: settings.models?.image ?? DEFAULT_IMAGE_MODEL,
      imageEdit: settings.models?.imageEdit ?? DEFAULT_IMAGE_EDIT_MODEL,
      video: settings.models?.video ?? DEFAULT_VIDEO_MODEL,
      imageToVideo: settings.models?.imageToVideo ?? DEFAULT_IMAGE_TO_VIDEO_MODEL,
      music: settings.models?.music ?? DEFAULT_MUSIC_MODEL,
      speech: settings.models?.speech ?? DEFAULT_SPEECH_MODEL,
    },
    resolveModel,
    fitToSchema,
    runPaid,
    summarize,
    limitText:
      perCall === undefined ? '' : ` The limit is $${formatUsd(perCall)} per call.`,
  };
}

type ToolContext = ReturnType<typeof createContext>;

const extraInputSchema = z.record(z.string(), z.unknown()).optional().describe(EXTRA_DESCRIPTION);

function imageTool(ctx: ToolContext): Tool<PopNowImageToolInput, PopNowToolResult> {
  return tool({
    description:
      'Create an image from a text prompt, or edit images given by URL, with PopNow (Nano Banana, GPT Image, Seedream, FLUX and more). ' +
      `${PAID_NOTE}${ctx.limitText} Returns download URLs and popnow:// references.`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Description of the picture to create, or the edit to make.'),
      imageUrls: z
        .array(z.string())
        .optional()
        .describe('Optional source image URLs or popnow:// references to edit. When set, the default edit model is used.'),
      aspectRatio: z.string().optional().describe('Aspect ratio such as "1:1", "16:9", "9:16", "4:3" or "3:4".'),
      resolution: z.string().optional().describe('Output size such as "1k", "2k" or "4k". Higher costs more.'),
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      extraInput: extraInputSchema,
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const editing = Boolean(args.imageUrls?.length);
      const model = ctx.resolveModel(args.model, editing ? ctx.models.imageEdit : ctx.models.image);
      const { input, ignored } = await ctx.fitToSchema(
        model,
        {
          prompt: args.prompt,
          image_urls: editing ? args.imageUrls : undefined,
          aspect_ratio: args.aspectRatio,
          resolution: args.resolution,
        },
        args.extraInput,
        abortSignal,
      );
      return ctx.runPaid('generateImage', model, input, ignored, { toolCallId, abortSignal });
    },
  });
}

function videoTool(ctx: ToolContext): Tool<PopNowVideoToolInput, PopNowToolResult> {
  return tool({
    description:
      'Create a short video from a text prompt, or animate an image given by URL or popnow:// reference, with PopNow (MiniMax H3, Kling, Seedance, Wan, Veo and more). ' +
      `${PAID_NOTE}${ctx.limitText} Video takes one to a few minutes; if it is not ready in time the tool returns a taskId to check with the get task tool.`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Description of the scene, motion and camera.'),
      imageUrl: z
        .string()
        .optional()
        .describe('Optional start frame URL or popnow:// reference to animate. When set, the default image-to-video model is used.'),
      durationSeconds: z.number().int().positive().optional().describe('Clip length in seconds, for example 6 or 10. Longer costs more.'),
      resolution: z.string().optional().describe('Resolution such as "480p", "768p" or "2k". Higher costs more.'),
      aspectRatio: z.string().optional().describe('Aspect ratio such as "16:9", "9:16" or "1:1" (text to video).'),
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      extraInput: extraInputSchema,
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const animating = Boolean(args.imageUrl);
      const model = ctx.resolveModel(args.model, animating ? ctx.models.imageToVideo : ctx.models.video);
      const { input, ignored } = await ctx.fitToSchema(
        model,
        {
          prompt: args.prompt,
          image_url: args.imageUrl,
          duration_seconds: args.durationSeconds,
          resolution: args.resolution,
          // MiniMax H3 image to video follows the picture's own aspect ratio.
          aspect_ratio: animating && model === DEFAULT_IMAGE_TO_VIDEO_MODEL ? undefined : args.aspectRatio,
        },
        args.extraInput,
        abortSignal,
      );
      return ctx.runPaid('generateVideo', model, input, ignored, { toolCallId, abortSignal });
    },
  });
}

function musicTool(ctx: ToolContext): Tool<PopNowMusicToolInput, PopNowToolResult> {
  return tool({
    description:
      'Create an original song or instrumental track from a description, optionally with lyrics, with PopNow (Suno and more). ' +
      `${PAID_NOTE}${ctx.limitText} Returns audio download URLs.`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Style, mood, instruments and topic of the song.'),
      lyrics: z.string().optional().describe('Optional lyrics to sing.'),
      instrumental: z.boolean().optional().describe('True for an instrumental track without vocals.'),
      title: z.string().optional().describe('Optional song title.'),
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      extraInput: extraInputSchema,
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const model = ctx.resolveModel(args.model, ctx.models.music);
      const { input, ignored } = await ctx.fitToSchema(
        model,
        { prompt: args.prompt, lyrics: args.lyrics, instrumental: args.instrumental, title: args.title },
        args.extraInput,
        abortSignal,
      );
      return ctx.runPaid('generateMusic', model, input, ignored, { toolCallId, abortSignal });
    },
  });
}

function speechTool(ctx: ToolContext): Tool<PopNowSpeechToolInput, PopNowToolResult> {
  return tool({
    description:
      'Read text aloud as natural speech in many voices and languages with PopNow (Gemini TTS, OpenAI TTS, MiniMax Speech and more). ' +
      `${PAID_NOTE}${ctx.limitText} Returns an audio download URL.`,
    inputSchema: z.object({
      text: z.string().min(1).describe('The text to read aloud.'),
      voiceId: z.string().optional().describe('Voice name, for example "Kore", "Puck" or "Charon" for the default model.'),
      style: z.string().optional().describe('Optional delivery style, for example "newscaster", "whisper" or "warm".'),
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      extraInput: extraInputSchema,
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const model = ctx.resolveModel(args.model, ctx.models.speech);
      const { input, ignored } = await ctx.fitToSchema(
        model,
        { text: args.text, voice_id: args.voiceId, style: args.style },
        args.extraInput,
        abortSignal,
      );
      return ctx.runPaid('generateSpeech', model, input, ignored, { toolCallId, abortSignal });
    },
  });
}

function summarizeModel(item: Record<string, unknown>): Record<string, unknown> {
  return compact({
    model: item.model,
    name: item.displayName,
    modality: item.modality,
    tasks: item.tasks,
    usd: item.usd,
    available: item.available,
  });
}

function listTool(ctx: ToolContext): Tool<PopNowListModelsToolInput, PopNowListModelsToolResult> {
  return tool({
    description:
      'List PopNow image, video and audio models with their exact model ids and USD rates, or pass model=<id> to get that model\'s input fields and pricing. Free.',
    inputSchema: z.object({
      modality: z.enum(['image', 'video', 'audio']).optional().describe('Filter by output type.'),
      search: z.string().optional().describe('Free-text search, for example "kling" or "upscale".'),
      task: z.string().optional().describe('Exact task, for example "text-to-image", "image-to-video" or "text-to-speech".'),
      model: z.string().optional().describe('A model id: return its input fields and pricing instead of a list.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of models to return. Default 30.'),
    }),
    execute: async (args, { abortSignal }): Promise<PopNowListModelsToolResult> => {
      try {
        if (args.model?.trim()) {
          const detail = (await ctx.api.getModel(args.model.trim(), abortSignal)) as unknown as Record<string, unknown>;
          return compact({
            ...summarizeModel(detail),
            inputSchema: detail.inputSchema,
            maxOutputDurationSeconds: detail.maxOutputDurationSeconds,
          });
        }
        const list = await ctx.api.listModels(
          { modality: args.modality, search: args.search, task: args.task },
          abortSignal,
        );
        const models = (list.items ?? []).slice(0, args.limit ?? 30).map(summarizeModel);
        return compact({ total: list.total, returned: models.length, models });
      } catch (error) {
        throw toolError(error);
      }
    },
  });
}

function taskTool(ctx: ToolContext, pollIntervalMs: number | undefined): Tool<PopNowGetTaskToolInput, PopNowToolResult> {
  return tool({
    description:
      'Check a PopNow task that is still running (for example a video) and return its result with download URLs once it is ready. Free.',
    inputSchema: z.object({
      taskId: z.string().min(1).describe('The taskId returned by a PopNow generation tool.'),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe('Seconds to wait for the task to finish before returning (0 to 300). Default 30.'),
    }),
    execute: async (args, { abortSignal }): Promise<PopNowToolResult> => {
      try {
        const { value } = await ctx.api.getTask(args.taskId, undefined, abortSignal);
        const waited = await ctx.api.waitForTask(value, {
          timeoutMs: (args.waitSeconds ?? 30) * 1000,
          pollIntervalMs,
          abortSignal,
        });
        return ctx.summarize(waited.task, waited.task.model ?? '');
      } catch (error) {
        throw toolError(error);
      }
    },
  });
}

/**
 * All PopNow agent tools for `generateText` / `streamText`, sharing one configuration and one
 * optional total budget:
 *
 * - `generateImage`, `generateVideo`, `generateMusic`, `generateSpeech` (paid, quoted first)
 * - `listModels`, `getTask` (free)
 */
export function popnowTools(settings: PopNowToolsSettings = {}): PopNowTools {
  const ctx = createContext(settings);
  return {
    generateImage: imageTool(ctx),
    generateVideo: videoTool(ctx),
    generateMusic: musicTool(ctx),
    generateSpeech: speechTool(ctx),
    listModels: listTool(ctx),
    getTask: taskTool(ctx, settings.pollIntervalMs),
  };
}

/** A tool that creates or edits images. Paid: quoted first, runs only within the limits. */
export function createImageTool(settings: PopNowToolsSettings = {}) {
  return imageTool(createContext(settings));
}

/** A tool that creates videos from text or an image. Paid: quoted first, runs only within the limits. */
export function createVideoTool(settings: PopNowToolsSettings = {}) {
  return videoTool(createContext(settings));
}

/** A tool that creates songs and instrumentals. Paid: quoted first, runs only within the limits. */
export function createMusicTool(settings: PopNowToolsSettings = {}) {
  return musicTool(createContext(settings));
}

/** A tool that reads text aloud. Paid: quoted first, runs only within the limits. */
export function createSpeechTool(settings: PopNowToolsSettings = {}) {
  return speechTool(createContext(settings));
}

/** A free tool that lists PopNow models, or returns one model's input fields and pricing. */
export function listModelsTool(settings: PopNowToolsSettings = {}) {
  return listTool(createContext(settings));
}

/** A free tool that checks a running task and returns its result once it is ready. */
export function getTaskTool(settings: PopNowToolsSettings = {}) {
  return taskTool(createContext(settings), settings.pollIntervalMs);
}
