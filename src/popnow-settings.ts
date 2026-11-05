// Model IDs follow `<maker>/<model>/<task>`. These lists are examples for editor
// autocompletion only; any ID from `GET https://api.popnow.ai/api/v1/models` works.

export type PopNowImageModelId =
  | 'google/nano-banana-2.1/text-to-image'
  | 'google/nano-banana-2.1/edit'
  | 'google/nano-banana-pro/text-to-image'
  | 'google/nano-banana-pro/edit'
  | 'openai/gpt-image-2/text-to-image'
  | 'openai/gpt-image-2/edit'
  | 'bytedance/seedream-5.0-pro/text-to-image'
  | 'bytedance/seedream-5.0-pro/edit'
  | 'black-forest-labs/flux-2-pro/text-to-image'
  | 'black-forest-labs/flux-2-pro/edit'
  | 'alibaba/qwen-image-2.1-pro/text-to-image'
  | 'alibaba/qwen-image-2.1-pro/edit'
  | 'alibaba/z-image-turbo/text-to-image'
  | (string & {});

export type PopNowSpeechModelId =
  | 'openai/tts-1/text-to-speech'
  | 'openai/tts-1-hd/text-to-speech'
  | 'minimax/speech-2.8-hd/text-to-speech'
  | 'minimax/speech-2.8-turbo/text-to-speech'
  | 'google/gemini-3.8-flash-tts/text-to-speech'
  | (string & {});

export type PopNowTranscriptionModelId =
  | 'openai/whisper-1/speech-to-text'
  | 'openai/gpt-4o-transcribe/speech-to-text'
  | 'openai/gpt-4o-mini-transcribe/speech-to-text'
  | 'openai/gpt-transcribe/speech-to-text'
  | (string & {});

export type PopNowChatModelId =
  | 'anthropic/claude-haiku-5.5/chat'
  | 'anthropic/claude-sonnet-5.5/chat'
  | 'anthropic/claude-opus-5.5/chat'
  | 'google/gemini-3.7-flash/chat'
  | 'deepseek/v4-pro/chat'
  | 'moonshot/kimi-k3/chat'
  | 'openai/gpt-5.5/chat'
  | (string & {});
