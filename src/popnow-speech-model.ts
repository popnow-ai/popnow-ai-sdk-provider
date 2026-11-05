import { NoContentGeneratedError, type SharedV4Warning, type SpeechModelV4 } from '@ai-sdk/provider';
import { PopNowApi, splitProviderOptions } from './popnow-api';
import type { PopNowConfig } from './popnow-config';
import type { PopNowSpeechModelId } from './popnow-settings';

type CallOptions = Parameters<SpeechModelV4['doGenerate']>[0];
type CallResult = Awaited<ReturnType<SpeechModelV4['doGenerate']>>;

export class PopNowSpeechModel implements SpeechModelV4 {
  readonly specificationVersion = 'v4';
  private readonly api: PopNowApi;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: PopNowSpeechModelId,
    private readonly config: PopNowConfig,
  ) {
    this.api = new PopNowApi(config);
  }

  async doGenerate(options: CallOptions): Promise<CallResult> {
    const { text, voice, outputFormat, instructions, speed, language, abortSignal, headers } = options;
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const warnings: SharedV4Warning[] = [];
    const info = await this.api.getModel(this.modelId, abortSignal);
    const properties = info.inputSchema?.properties ?? {};
    const input: Record<string, unknown> = {};

    // Speech models take the words in `text`; a few audio models call it `prompt`.
    input[properties.text || !properties.prompt ? 'text' : 'prompt'] = text;

    // Each AI SDK setting maps to the shared PopNow field name when the model has it.
    const mappings: Array<[string, unknown, string[]]> = [
      ['voice', voice, ['voice_id', 'voice']],
      ['outputFormat', outputFormat, ['output_format']],
      ['instructions', instructions, ['instructions']],
      ['speed', speed, ['speed']],
      ['language', language, ['language']],
    ];
    for (const [feature, value, fields] of mappings) {
      if (value == null) continue;
      const field = fields.find((name) => properties[name]);
      if (field) input[field] = value;
      else warnings.push({ type: 'unsupported', feature, details: `${this.modelId} has no ${fields[0]} field.` });
    }

    const { taskOptions, inputOverrides } = splitProviderOptions(options.providerOptions?.popnow);
    Object.assign(input, inputOverrides);

    const { task, responseHeaders } = await this.api.runTask({
      model: this.modelId,
      input,
      options: taskOptions,
      headers,
      abortSignal,
    });

    const assets = (task.output?.assets ?? []).filter((a) => a.url && !a.deleted && !a.unavailable);
    const asset = assets.find((a) => a.mime?.startsWith('audio/') || a.role === 'audio') ?? assets[0];
    if (!asset) {
      throw new NoContentGeneratedError({
        message: `PopNow task ${task.taskId} succeeded but returned no audio file.`,
      });
    }
    const audio = await this.api.download(asset.url!, abortSignal);

    return {
      audio,
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
          mediaType: asset.mime ?? null,
          durationSeconds: asset.durationSeconds ?? null,
        },
      },
    };
  }
}
