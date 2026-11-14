# PopNow provider for the AI SDK

[![npm](https://img.shields.io/npm/v/@popnow/ai-sdk-provider)](https://www.npmjs.com/package/@popnow/ai-sdk-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use [PopNow](https://popnow.ai) models with the [Vercel AI SDK](https://ai-sdk.dev). One PopNow API key gives you:

Built by PopNow AI ([popnow.ai](https://popnow.ai)), the world's first AI studio with automatic price protection: every API call is quoted in USD before it runs, and failed tasks are refunded to your API balance automatically.

| AI SDK function   | PopNow models                                                   | Factory                 |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| `generateImage`   | Text to image and image editing (Nano Banana, GPT Image, Seedream, FLUX, Qwen Image and more) | `popnow.image(id)`      |
| `generateSpeech`  | Text to speech                                                  | `popnow.speech(id)`     |
| `transcribe`      | Speech to text                                                  | `popnow.transcription(id)` |
| `generateText`, `streamText` | Chat models through the OpenAI-compatible endpoint   | `popnow(id)`, `popnow.chat(id)` |
| `tools` in `generateText`, `streamText`, agents | Agent tools for images, video, music and speech, with spending limits | `popnowTools()` |

Requires AI SDK 7 (`ai@^7`) and Node.js 22 or later.

## Install

```bash
npm install @popnow/ai-sdk-provider ai zod
```

## Setup

Create an API key in the [PopNow API console](https://popnow.ai/api/console/keys) (see [popnow.ai/api](https://popnow.ai/api)). Keys start with `sk-popnow-`. API calls are billed in US dollars from a separate API balance that starts at $0; add funds in [API billing](https://popnow.ai/api/console/billing) before the first paid call.

```bash
export POPNOW_API_KEY="sk-popnow-..."
```

The default `popnow` instance reads `POPNOW_API_KEY`. For other settings, create your own instance:

```ts
import { createPopNow } from '@popnow/ai-sdk-provider';

const popnow = createPopNow({
  apiKey: process.env.POPNOW_API_KEY, // default: POPNOW_API_KEY
  baseURL: 'https://api.popnow.ai', // default: POPNOW_BASE_URL or https://api.popnow.ai
  headers: { 'X-PopNow-Tags': 'my-app' }, // optional, sent with every request
  fetch: customFetch, // optional
});
```

Keep the key on your server. Anyone who can read it can spend your API balance.

## Image generation

```ts
import { popnow } from '@popnow/ai-sdk-provider';
import { generateImage } from 'ai';
import fs from 'node:fs';

const { image } = await generateImage({
  model: popnow.image('google/nano-banana-2.1/text-to-image'),
  prompt: 'A cozy reading nook beside a rain-streaked window, warm lamp light',
  aspectRatio: '16:9',
  providerOptions: {
    popnow: { resolution: '2k' },
  },
});

await fs.promises.writeFile('nook.png', image.uint8Array);
```

### Image editing

Edit models have IDs that end in `/edit`. Pass the source images (and a mask, where the model takes one) in the prompt:

```ts
const { image } = await generateImage({
  model: popnow.image('google/nano-banana-2.1/edit'),
  prompt: {
    text: 'Change the jacket to deep forest green; keep the face and background',
    images: ['https://example.com/portrait.jpg'],
  },
});
```

URLs are passed through as they are. Images given as bytes or base64 are sent inline when they are JPEG, PNG, WebP or GIF of at most 1 MiB, and uploaded to PopNow otherwise.

### How settings map to PopNow

Every PopNow model validates its `input` against its own JSON Schema and rejects unknown fields. The provider reads the model's schema (`GET /api/v1/models/{model}`, cached for ten minutes) and only sends a setting when the model has the matching field:

| AI SDK setting | PopNow input field                                    |
| -------------- | ----------------------------------------------------- |
| `prompt`       | `prompt`                                              |
| `aspectRatio`  | `aspect_ratio`                                        |
| `size`         | `width` / `height`, otherwise reduced to `aspect_ratio` (with a `compatibility` warning) |
| `seed`         | `seed`                                                |
| `n`            | `num_outputs` or `num_images`; models without one make one image per task, and the AI SDK runs several tasks |
| prompt `images` | `image_urls`, or `image_url` for single-image models |
| prompt `mask`  | `mask_url`                                            |

A setting the model does not have is left out and reported in `warnings` as `unsupported`.

Any other model field goes in `providerOptions.popnow`, spelled exactly as in the model's schema (snake_case), for example `resolution`, `output_format` or `quality`. These values override the mapped ones.

## Speech

```ts
import { popnow } from '@popnow/ai-sdk-provider';
import { generateSpeech } from 'ai';
import fs from 'node:fs';

const { audio } = await generateSpeech({
  model: popnow.speech('openai/tts-1/text-to-speech'),
  text: 'Hello from PopNow.',
  voice: 'nova',
  speed: 1.1,
});

await fs.promises.writeFile('hello.mp3', audio.uint8Array);
```

`voice` maps to `voice_id`, `outputFormat` to `output_format`, and `instructions`, `speed` and `language` to fields of the same name, when the model has them. The allowed voices are listed in each model's schema.

## Transcription

```ts
import { popnow } from '@popnow/ai-sdk-provider';
import { transcribe } from 'ai';
import fs from 'node:fs';

const result = await transcribe({
  model: popnow.transcription('openai/whisper-1/speech-to-text'),
  audio: await fs.promises.readFile('meeting.mp3'),
  providerOptions: { popnow: { language: 'en' } },
});

console.log(result.text, result.words);
```

Audio bytes are uploaded to PopNow first (MP3 and WAV, up to 90 MiB). A public `https://` URL (`audio: new URL('https://...')`) is passed to PopNow directly without downloading it.

## Chat

PopNow serves chat models through an OpenAI-compatible API at `https://api.popnow.ai/v1`. The provider uses [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) for them, with the same API key and balance:

```ts
import { popnow } from '@popnow/ai-sdk-provider';
import { generateText } from 'ai';

const { text } = await generateText({
  model: popnow('anthropic/claude-haiku-5.5/chat'),
  prompt: 'Suggest three names for a kite shop by the sea.',
});
```

Chat models are priced per token, with no per-request minimum. See [Chat models](https://popnow.ai/docs/chat) for the list and the parameters each model accepts.

## Agent tools

`popnowTools()` gives any AI SDK model (from any provider) tools that create images, videos, music and speech with PopNow. Use them in `generateText`, `streamText` or a `ToolLoopAgent`:

```ts
import { generateText, isStepCount } from 'ai';
import { popnowTools } from '@popnow/ai-sdk-provider';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'Create a 16:9 poster of a paper whale drifting over a night city, then animate it into a short video.',
  // Every paid call is priced first and only runs at or below this USD limit.
  tools: popnowTools({ maxUsdPerCall: '0.50' }),
  stopWhen: isStepCount(5),
});

console.log(text);
```

| Tool key         | What it does                                                                 | Default model |
| ---------------- | ---------------------------------------------------------------------------- | ------------- |
| `generateImage`  | Text to image; with `imageUrls`, image editing                               | `google/nano-banana-2.1/text-to-image`, `google/nano-banana-2.1/edit` |
| `generateVideo`  | Text to video; with `imageUrl`, image to video                               | `minimax/h3/text-to-video`, `minimax/h3/image-to-video` |
| `generateMusic`  | Songs and instrumentals, optionally with lyrics                              | `suno/v6/text-to-audio` |
| `generateSpeech` | Text to speech                                                               | `google/gemini-3.8-flash-tts/text-to-speech` |
| `listModels`     | Lists models with ids and USD rates, or one model's input fields. Free       | |
| `getTask`        | Collects a task that was still running, such as a long video. Free           | |

The agent may pass another model id (`model`) and model-specific fields (`extraInput`, spelled as in the model's schema). Generic arguments such as `aspectRatio` are left out when the chosen model has no such field, and listed in `ignoredFields`. Each factory is also exported on its own: `createImageTool`, `createVideoTool`, `createMusicTool`, `createSpeechTool`, `listModelsTool` and `getTaskTool`, all taking the same settings.

### Spending limits

Every paid tool call first asks PopNow for a price (`POST /api/v1/jobs/quote`, free). The task is only created when the quoted maximum charge is within your limits, and it is created with that quote (`quoteId` and `expectedCostUsd`), so PopNow never holds more than the price that was checked. When a limit is exceeded, the tool returns `status: 'over_limit'` with the price, nothing is created and nothing is charged, and the model can try a cheaper option.

| Setting          | Default  | Meaning |
| ---------------- | -------- | ------- |
| `maxUsdPerCall`  | `'0.50'` | Hard ceiling for one call, as a USD decimal string. `null` removes it. |
| `maxUsdTotal`    | none     | Budget for all calls made through one `popnowTools()` set (or one factory). Running and finished tasks count; failed tasks do not. |
| `onQuote`        | none     | Called with each quote within the limits, before the task is created. Return `false` to decline (`status: 'declined'`). |
| `allowModelOverride` | `true` | Set `false` to pin each tool to its default model. |
| `models`         | see above | Default model ids: `image`, `imageEdit`, `video`, `imageToVideo`, `music`, `speech`. |
| `waitTimeoutMs`  | `300000` | How long a paid tool waits for its result. |

`maxUsdPerCall` defaults to $0.50, which covers the default image, music and speech models and a default 6 second 768p video. Raise it for longer or higher-resolution video, and set `maxUsdTotal` for unattended agents. These limits are enforced in your code and cannot be changed by the model. To have a person approve calls, combine them with the AI SDK's `toolApproval` option (for example `toolApproval: { generateVideo: 'user-approval' }`) or with `onQuote`, which sees the exact price.

The settings of `createPopNow` (`apiKey`, `baseURL`, `headers`, `fetch`) apply here too; the key defaults to `POPNOW_API_KEY`.

### Results

Paid tools return one of:

- `status: 'succeeded'` with `taskId`, `model`, `costUsd` and `outputs`. Each output has a signed `url` (valid for about 20 minutes, fetch it without the API key), a `uri` such as `popnow://g/<taskId>/0` that never expires and can be passed to another PopNow tool (for example a poster into `generateVideo`), and `mime`, `width`, `height` or `durationSeconds` where known.
- `status: 'running'` with `taskId` when the result is not ready within `waitTimeoutMs`. The task keeps running; the model calls `getTask` with the `taskId` to collect it.
- `status: 'failed'` with `errorCode` and `errorMessage`. Failed tasks are not charged.
- `status: 'over_limit'` or `status: 'declined'` with the price. Nothing was created.

API errors (for example a low balance or an invalid field) are thrown, so the AI SDK reports them to the model as tool errors with a hint on what to do.

## Model IDs

Model IDs have the form `<maker>/<model>/<task>`, for example `google/nano-banana-2.1/text-to-image`, `openai/tts-1/text-to-speech` or `openai/whisper-1/speech-to-text`. The TypeScript types suggest a few; any ID your key can call works.

- Browse every model with its parameters and prices: [popnow.ai/docs/models](https://popnow.ai/docs/models)
- List them from code, with input schemas:

  ```bash
  curl "https://api.popnow.ai/api/v1/models?modality=image&includeSchema=1" \
    -H "Authorization: Bearer $POPNOW_API_KEY"
  ```

  `modality` is `image`, `video` or `audio`. Chat models are listed at `GET https://api.popnow.ai/v1/models`.

## Pricing

Prices are in USD per image, per second or per 1,000 characters, depending on the model, and shown on each model's documentation page. Compare them on the [AI price index](https://popnow.ai/ai-price-index). Each task holds its maximum price from your API balance when it is accepted and settles the actual charge when it finishes. Tasks that fail or expire are not charged. Details: [API billing](https://popnow.ai/docs/billing).

Each image entry in `providerMetadata.popnow.images` carries the `taskId`, its `costUsd` (a USD decimal string) and whether the charge is `settled`. Speech and transcription results carry the same fields in `providerMetadata.popnow`.

## Tasks, polling and retries

PopNow generation is asynchronous. Each call creates a task, waits up to 60 seconds on the create request, then polls the task (every 2 seconds at first, growing to every 15 seconds) until it is final, and downloads the output files from their signed links. The API key is never sent to those links.

These options go in `providerOptions.popnow` and are not sent to the model:

| Option           | Default | Meaning |
| ---------------- | ------- | ------- |
| `pollIntervalMs` | `2000`  | First delay between polls |
| `pollTimeoutMs`  | task deadline plus two minutes | Give up waiting after this long (the task keeps running) |
| `waitSeconds`    | `60`    | How long the create request is held open (0 to 60) |
| `idempotencyKey` | generated per call | Stable key for one logical generation |
| `metadata`       | none    | Your own labels stored with the task |

Every create request carries an `Idempotency-Key`. Connection errors, `429` and retryable `5xx` responses are retried twice with the same key, so a retry never starts a second task. When you pass your own `idempotencyKey`, the AI SDK's own retries (`maxRetries`) reuse it too.

`abortSignal` stops waiting at once. A task that was already accepted keeps running on PopNow.

## Errors

- `APICallError` (from `@ai-sdk/provider`) for API errors. The message carries the PopNow business code, such as `40201` (not enough API balance) or `40301` (the key may not call this model). See [Error codes](https://popnow.ai/docs/errors).
- `PopNowTaskError` when a task ends as `failed` or `expired`. It has `taskId`, `state`, `errorCode` (for example `content_rejected`), `errorMessage` and `costUsd`. These tasks are not charged.
- `PopNowTaskTimeoutError` when `pollTimeoutMs` runs out. It has `taskId`; the task keeps running.

```ts
import { PopNowTaskError } from '@popnow/ai-sdk-provider';

try {
  await generateImage({ model: popnow.image('google/nano-banana-2.1/text-to-image'), prompt });
} catch (error) {
  if (PopNowTaskError.isInstance(error)) console.log(error.taskId, error.errorCode);
}
```

## Not included

- **Video model.** The AI SDK's video model interface is still experimental (`experimental_generateVideo`), so this package does not implement it yet. Agents can create video with the `generateVideo` [agent tool](#agent-tools); otherwise PopNow video models are available through the [task API](https://popnow.ai/docs/tasks), the [official SDKs](https://popnow.ai/docs/sdks) and the [OpenAI Videos compatible endpoints](https://popnow.ai/docs/openai-videos).
- **Embeddings.** `embeddingModel` throws `NoSuchModelError`.

## Links

- [PopNow](https://popnow.ai)
- [API documentation](https://popnow.ai/docs)
- [Models](https://popnow.ai/docs/models)
- [AI price index](https://popnow.ai/ai-price-index)
- [Official JavaScript SDK](https://github.com/popnow-ai/popnow-js) (`npm install popnow`)

## License

MIT
