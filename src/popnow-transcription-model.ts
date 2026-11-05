import type { SharedV4Warning, TranscriptionModelV4 } from '@ai-sdk/provider';
import { convertBase64ToUint8Array } from '@ai-sdk/provider-utils';
import { PopNowApi, normalizeContentType, splitProviderOptions } from './popnow-api';
import type { PopNowConfig } from './popnow-config';
import type { PopNowTranscriptionModelId } from './popnow-settings';

type CallOptions = Parameters<TranscriptionModelV4['doGenerate']>[0];
type UrlCallOptions = Parameters<NonNullable<TranscriptionModelV4['doGenerateFromUrl']>>[0];
type CallResult = Awaited<ReturnType<TranscriptionModelV4['doGenerate']>>;

export class PopNowTranscriptionModel implements TranscriptionModelV4 {
  readonly specificationVersion = 'v4';
  private readonly api: PopNowApi;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: PopNowTranscriptionModelId,
    private readonly config: PopNowConfig,
  ) {
    this.api = new PopNowApi(config);
  }

  /** Uploads the audio (PopNow does not accept inline audio) and transcribes it. */
  async doGenerate(options: CallOptions): Promise<CallResult> {
    const bytes = typeof options.audio === 'string' ? convertBase64ToUint8Array(options.audio) : options.audio;
    const uri = await this.api.upload(bytes, normalizeContentType(options.mediaType), options.abortSignal);
    return this.transcribe(uri, options);
  }

  /** PopNow fetches public HTTPS audio itself, so the SDK does not need to download it. */
  async doGenerateFromUrl(options: UrlCallOptions): Promise<CallResult | undefined> {
    if (options.audio.protocol !== 'https:') return undefined;
    return this.transcribe(options.audio.href, options);
  }

  private async transcribe(audioUrl: string, options: Omit<CallOptions, 'audio' | 'mediaType'>): Promise<CallResult> {
    const { abortSignal, headers, timestampGranularities } = options;
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const warnings: SharedV4Warning[] = [];

    const { taskOptions, inputOverrides } = splitProviderOptions(options.providerOptions?.popnow);
    const input: Record<string, unknown> = { audio_url: audioUrl, ...inputOverrides };

    const { task, responseHeaders } = await this.api.runTask({
      model: this.modelId,
      input,
      options: taskOptions,
      headers,
      abortSignal,
    });

    const transcript = task.output?.transcript;
    const words = transcript?.words
      ?.filter((word) => word.type === undefined || word.type === 'word')
      .map((word) => ({ text: word.text, startSecond: word.start, endSecond: word.end }));

    if (timestampGranularities?.includes('word') && !words?.length) {
      warnings.push({ type: 'unsupported', feature: 'timestampGranularities', details: `${this.modelId} returned no word timings.` });
    }
    if (timestampGranularities?.includes('segment')) {
      warnings.push({ type: 'unsupported', feature: 'timestampGranularities', details: 'PopNow returns word timings, not segments.' });
    }

    return {
      text: task.output?.text ?? transcript?.text ?? '',
      segments: [],
      ...(words?.length ? { words } : {}),
      language: transcript?.languageCode ?? transcript?.language,
      durationInSeconds: transcript?.durationSeconds,
      warnings,
      request: { body: JSON.stringify({ model: this.modelId, input }) },
      response: {
        timestamp: currentDate,
        modelId: task.model ?? this.modelId,
        headers: responseHeaders,
      },
      providerMetadata: {
        popnow: {
          taskId: task.taskId,
          costUsd: task.costUsd ?? null,
          settled: task.settled ?? null,
        },
      },
    };
  }
}
