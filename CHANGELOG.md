# Changelog

## 0.2.0

- Agent tools: `popnowTools()` returns AI SDK tools for `generateText`, `streamText` and agents
  that create images, videos, music and speech, list models and collect running tasks
  (`generateImage`, `generateVideo`, `generateMusic`, `generateSpeech`, `listModels`, `getTask`).
  Each factory is also exported on its own.
- Spending limits for the tools: every paid call is quoted first and only created, with that
  quote, when the price is within `maxUsdPerCall` (default $0.50) and the optional
  `maxUsdTotal`; `onQuote` can decline a call. Over-limit calls create nothing.
- Long tasks return their `taskId` after `waitTimeoutMs`; the `getTask` tool collects them.
- `zod` is now used at runtime (it was already a peer dependency).

## 0.1.1

- First release published from GitHub Actions with npm provenance. No code changes.

## 0.1.0

- First release: image models (`generateImage`, including editing), speech models
  (`generateSpeech`), transcription models (`transcribe`) and chat models through the
  OpenAI-compatible endpoint, for AI SDK 7.
