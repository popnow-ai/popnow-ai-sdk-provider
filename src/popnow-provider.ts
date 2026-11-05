import {
  NoSuchModelError,
  type ImageModelV4,
  type LanguageModelV4,
  type ProviderV4,
  type SpeechModelV4,
  type TranscriptionModelV4,
} from '@ai-sdk/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  loadApiKey,
  loadOptionalSetting,
  withUserAgentSuffix,
  withoutTrailingSlash,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import type { PopNowConfig } from './popnow-config';
import { PopNowImageModel } from './popnow-image-model';
import type {
  PopNowChatModelId,
  PopNowImageModelId,
  PopNowSpeechModelId,
  PopNowTranscriptionModelId,
} from './popnow-settings';
import { PopNowSpeechModel } from './popnow-speech-model';
import { PopNowTranscriptionModel } from './popnow-transcription-model';
import { VERSION } from './version';

export interface PopNowProviderSettings {
  /**
   * PopNow API key (`sk-popnow-...`). Defaults to the `POPNOW_API_KEY` environment variable.
   * Create one at https://popnow.ai/api/console/keys.
   */
  apiKey?: string;
  /**
   * API origin. Defaults to `POPNOW_BASE_URL` or `https://api.popnow.ai`. The task API is
   * served under `/api/v1` and the OpenAI-compatible chat API under `/v1`.
   */
  baseURL?: string;
  /** Extra headers sent with every PopNow API request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation, for example as middleware or for tests. */
  fetch?: FetchFunction;
}

export interface PopNowProvider extends ProviderV4 {
  /** Creates a chat model through the OpenAI-compatible endpoint. */
  (modelId: PopNowChatModelId): LanguageModelV4;
  /** Creates a chat model through the OpenAI-compatible endpoint. */
  chat(modelId: PopNowChatModelId): LanguageModelV4;
  languageModel(modelId: PopNowChatModelId): LanguageModelV4;
  /** Creates an image model, for example `google/nano-banana-2.1/text-to-image`. */
  image(modelId: PopNowImageModelId): ImageModelV4;
  imageModel(modelId: PopNowImageModelId): ImageModelV4;
  /** Creates a text-to-speech model, for example `openai/tts-1/text-to-speech`. */
  speech(modelId: PopNowSpeechModelId): SpeechModelV4;
  speechModel(modelId: PopNowSpeechModelId): SpeechModelV4;
  /** Creates a speech-to-text model, for example `openai/whisper-1/speech-to-text`. */
  transcription(modelId: PopNowTranscriptionModelId): TranscriptionModelV4;
  transcriptionModel(modelId: PopNowTranscriptionModelId): TranscriptionModelV4;
}

const DEFAULT_BASE_URL = 'https://api.popnow.ai';

/** Resolves settings shared by the provider and the agent tools. @internal */
export function resolvePopNowSettings(options: PopNowProviderSettings = {}) {
  const baseURL =
    withoutTrailingSlash(
      loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: 'POPNOW_BASE_URL' }),
    ) ?? DEFAULT_BASE_URL;

  // The key is read lazily so that importing the default instance never throws.
  const getApiKey = () =>
    loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: 'POPNOW_API_KEY',
      description: 'PopNow',
    });

  const getHeaders = () =>
    withUserAgentSuffix(
      { Authorization: `Bearer ${getApiKey()}`, ...options.headers },
      `popnow-ai-sdk-provider/${VERSION}`,
    );

  const schemaCache: PopNowConfig['schemaCache'] = new Map();
  const config = (provider: string): PopNowConfig => ({
    provider,
    apiURL: `${baseURL}/api/v1`,
    headers: getHeaders,
    fetch: options.fetch,
    schemaCache,
  });

  return { baseURL, getApiKey, config };
}

/** Creates a PopNow provider instance. */
export function createPopNow(options: PopNowProviderSettings = {}): PopNowProvider {
  const { baseURL, getApiKey, config } = resolvePopNowSettings(options);

  const chatProvider = createOpenAICompatible({
    name: 'popnow',
    baseURL: `${baseURL}/v1`,
    apiKey: getApiKey,
    headers: withUserAgentSuffix(options.headers, `popnow-ai-sdk-provider/${VERSION}`),
    fetch: options.fetch,
    includeUsage: true,
  });

  const createChatModel = (modelId: PopNowChatModelId) => chatProvider.chatModel(modelId);
  const createImageModel = (modelId: PopNowImageModelId) => new PopNowImageModel(modelId, config('popnow.image'));
  const createSpeechModel = (modelId: PopNowSpeechModelId) => new PopNowSpeechModel(modelId, config('popnow.speech'));
  const createTranscriptionModel = (modelId: PopNowTranscriptionModelId) =>
    new PopNowTranscriptionModel(modelId, config('popnow.transcription'));

  const provider = function (modelId: PopNowChatModelId) {
    if (new.target) {
      throw new Error('The PopNow model function cannot be called with the new keyword.');
    }
    return createChatModel(modelId);
  } as PopNowProvider;

  Object.assign(provider, {
    specificationVersion: 'v4' as const,
    chat: createChatModel,
    languageModel: createChatModel,
    image: createImageModel,
    imageModel: createImageModel,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
    transcription: createTranscriptionModel,
    transcriptionModel: createTranscriptionModel,
    embeddingModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
    },
  });

  return provider;
}

/** Default PopNow provider instance. Reads `POPNOW_API_KEY` when a model is first called. */
export const popnow = createPopNow();
