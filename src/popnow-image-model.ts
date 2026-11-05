import type { ImageModelV4, ImageModelV4File, SharedV4Warning } from '@ai-sdk/provider';
import { PopNowApi, splitProviderOptions } from './popnow-api';
import type { PopNowConfig, PopNowJsonSchema } from './popnow-config';
import type { PopNowImageModelId } from './popnow-settings';

/** Input fields that set how many images one task returns, in order of preference. */
const COUNT_FIELDS = ['num_outputs', 'num_images'];

type CallOptions = Parameters<ImageModelV4['doGenerate']>[0];
type CallResult = Awaited<ReturnType<ImageModelV4['doGenerate']>>;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export class PopNowImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';
  private readonly api: PopNowApi;

  /**
   * Reads the model's input schema: models with a count field (such as `num_outputs`)
   * make several images per task, every other model makes one.
   */
  readonly maxImagesPerCall = async (): Promise<number> => {
    const properties = await this.properties();
    const field = COUNT_FIELDS.find((name) => properties[name]);
    if (!field) return 1;
    const max = properties[field]!.maximum;
    return typeof max === 'number' && max >= 1 ? Math.floor(max) : 1;
  };

  get provider(): string {
    return this.config.provider;
  }

  get supportsFileInputs(): Promise<boolean> {
    return this.properties().then((p) => Boolean(p.image_urls || p.image_url));
  }

  get supportsMaskInputs(): Promise<boolean> {
    return this.properties().then((p) => Boolean(p.mask_url));
  }

  constructor(
    readonly modelId: PopNowImageModelId,
    private readonly config: PopNowConfig,
  ) {
    this.api = new PopNowApi(config);
  }

  private async properties(abortSignal?: AbortSignal): Promise<Record<string, PopNowJsonSchema>> {
    const info = await this.api.getModel(this.modelId, abortSignal);
    return info.inputSchema?.properties ?? {};
  }

  private async fileReference(file: ImageModelV4File, abortSignal?: AbortSignal): Promise<string> {
    if (file.type === 'url') return file.url;
    return this.api.toMediaReference(file.data, file.mediaType, abortSignal);
  }

  async doGenerate(options: CallOptions): Promise<CallResult> {
    const { prompt, n, size, aspectRatio, seed, files, mask, abortSignal, headers } = options;
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const warnings: SharedV4Warning[] = [];
    const properties = await this.properties(abortSignal);
    const input: Record<string, unknown> = {};

    if (prompt != null) {
      if (properties.prompt) input.prompt = prompt;
      else warnings.push({ type: 'unsupported', feature: 'prompt', details: `${this.modelId} takes no prompt.` });
    }

    if (aspectRatio != null) {
      if (properties.aspect_ratio) input.aspect_ratio = aspectRatio;
      else warnings.push({ type: 'unsupported', feature: 'aspectRatio' });
    }

    if (size != null) {
      const [width, height] = size.split('x').map(Number) as [number, number];
      if (properties.width && properties.height) {
        input.width = width;
        input.height = height;
      } else if (properties.aspect_ratio && aspectRatio == null && width > 0 && height > 0) {
        // PopNow image models size their output with `aspect_ratio` plus a `resolution` tier.
        const d = gcd(width, height);
        const ratio = `${width / d}:${height / d}`;
        const allowed = properties.aspect_ratio.enum;
        if (!allowed || allowed.includes(ratio)) {
          input.aspect_ratio = ratio;
          warnings.push({
            type: 'compatibility',
            feature: 'size',
            details:
              `size was mapped to aspect_ratio ${ratio}. Choose the output size tier with ` +
              'providerOptions.popnow.resolution where the model has one.',
          });
        } else {
          warnings.push({
            type: 'unsupported',
            feature: 'size',
            details: `Aspect ratio ${ratio} is not offered by ${this.modelId}. Use aspectRatio instead.`,
          });
        }
      } else {
        warnings.push({ type: 'unsupported', feature: 'size', details: 'Use aspectRatio instead.' });
      }
    }

    if (seed != null) {
      if (properties.seed) input.seed = seed;
      else warnings.push({ type: 'unsupported', feature: 'seed' });
    }

    if (n > 1) {
      const field = COUNT_FIELDS.find((name) => properties[name]);
      if (field) input[field] = n;
      else warnings.push({ type: 'unsupported', feature: 'n', details: `${this.modelId} returns one image per task.` });
    }

    if (files != null && files.length > 0) {
      if (properties.image_urls) {
        input.image_urls = await Promise.all(files.map((file) => this.fileReference(file, abortSignal)));
      } else if (properties.image_url) {
        input.image_url = await this.fileReference(files[0]!, abortSignal);
        if (files.length > 1) {
          warnings.push({
            type: 'other',
            message: `${this.modelId} takes one input image; only the first file was sent.`,
          });
        }
      } else {
        warnings.push({
          type: 'unsupported',
          feature: 'files',
          details: `${this.modelId} takes no input images. Edit models use IDs that end in /edit.`,
        });
      }
    }

    if (mask != null) {
      if (properties.mask_url) input.mask_url = await this.fileReference(mask, abortSignal);
      else warnings.push({ type: 'unsupported', feature: 'mask' });
    }

    // Model-specific fields (snake_case, exactly as in the model's input schema) win.
    const { taskOptions, inputOverrides } = splitProviderOptions(options.providerOptions?.popnow);
    Object.assign(input, inputOverrides);

    const { task, responseHeaders } = await this.api.runTask({
      model: this.modelId,
      input,
      options: taskOptions,
      headers,
      abortSignal,
    });

    const assets = (task.output?.assets ?? []).filter(
      (asset) =>
        asset.url &&
        !asset.deleted &&
        !asset.unavailable &&
        (asset.mime ? asset.mime.startsWith('image/') : true) &&
        asset.role !== 'segment',
    );
    const images = await Promise.all(assets.map((asset) => this.api.download(asset.url!, abortSignal)));

    return {
      images,
      warnings,
      response: {
        timestamp: currentDate,
        modelId: task.model ?? this.modelId,
        headers: responseHeaders,
      },
      providerMetadata: {
        popnow: {
          // generateImage keeps only `images` from provider metadata, so task details go per image.
          images: assets.map((asset) => ({
            taskId: task.taskId,
            costUsd: task.costUsd ?? null,
            settled: task.settled ?? null,
            mediaType: asset.mime ?? null,
            width: asset.width ?? null,
            height: asset.height ?? null,
            role: asset.role ?? null,
          })),
        },
      },
    };
  }
}
