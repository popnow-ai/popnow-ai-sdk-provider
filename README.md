# PopNow provider for the AI SDK

[![npm](https://img.shields.io/npm/v/@popnow/ai-sdk-provider)](https://www.npmjs.com/package/@popnow/ai-sdk-provider)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use [PopNow](https://popnow.ai) models with the [Vercel AI SDK](https://ai-sdk.dev). One PopNow API key gives you:

| AI SDK function   | PopNow models                                                   | Factory                 |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| `generateImage`   | Text to image and image editing (Nano Banana, GPT Image, Seedream, FLUX, Qwen Image and more) | `popnow.image(id)`      |
| `generateSpeech`  | Text to speech                                                  | `popnow.speech(id)`     |
| `transcribe`      | Speech to text                                                  | `popnow.transcription(id)` |
| `generateText`, `streamText` | Chat models through the OpenAI-compatible endpoint   | `popnow(id)`, `popnow.chat(id)` |

Requires AI SDK 7 (`ai@^7`) and Node.js 22 or later.

## Install

```bash
npm install @popnow/ai-sdk-provider ai
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

- **Video.** The AI SDK's video model interface is still experimental (`experimental_generateVideo`), so this package does not implement it yet. PopNow video models are available through the [task API](https://popnow.ai/docs/tasks), the [official SDKs](https://popnow.ai/docs/sdks) and the [OpenAI Videos compatible endpoints](https://popnow.ai/docs/openai-videos).
- **Embeddings.** `embeddingModel` throws `NoSuchModelError`.

## Links

- [PopNow](https://popnow.ai)
- [API documentation](https://popnow.ai/docs)
- [Models](https://popnow.ai/docs/models)
- [AI price index](https://popnow.ai/ai-price-index)
- [Official JavaScript SDK](https://github.com/popnow-ai/popnow-js) (`npm install popnow`)

## License

MIT
