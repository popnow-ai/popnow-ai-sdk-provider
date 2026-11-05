import { generateSpeech, generateText, transcribe } from 'ai';
import { describe, expect, it } from 'vitest';
import { bytes, envelope, mockFetch, provider, schema, succeededTask } from './helpers';

const AUDIO_URL = 'https://media.popnow.ai/out/speech.mp3';

describe('speech model', () => {
  it('maps text, voice and speed to the schema fields and returns the audio', async () => {
    const m = mockFetch()
      .on('GET', '/models/openai/tts-1/text-to-speech', schema({ text: {}, voice_id: {}, speed: {}, output_format: {} }))
      .on('POST', '/jobs/createTask', envelope(succeededTask([{ url: AUDIO_URL, mime: 'audio/mpeg', durationSeconds: 2.5 }])))
      .on('GET', AUDIO_URL, bytes([7, 7], 'audio/mpeg'));

    const result = await generateSpeech({
      model: provider(m.fetch).speech('openai/tts-1/text-to-speech'),
      text: 'Hello from PopNow',
      voice: 'nova',
      speed: 1.25,
      instructions: 'Calm',
    });

    expect(Array.from(result.audio.uint8Array)).toEqual([7, 7]);
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({
      text: 'Hello from PopNow',
      voice_id: 'nova',
      speed: 1.25,
    });
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'unsupported', feature: 'instructions' })]);
  });
});

describe('transcription model', () => {
  it('uploads the audio, sends its popnow:// URI and maps word timings', async () => {
    const m = mockFetch()
      .on(
        'POST',
        '/common/upload-url',
        envelope({
          fileId: 'fil_1',
          uploadUrl: 'https://upload.example.com/put/fil_1?sig=abc',
          method: 'PUT',
          headers: { 'Content-Type': 'audio/wav', 'Content-Length': '12' },
        }),
      )
      .on('PUT', 'https://upload.example.com/put/fil_1', new Response(null, { status: 200 }))
      .on('POST', '/files/fil_1/commit', envelope({ fileId: 'fil_1', status: 'ready', uri: 'popnow://f/fil_1' }))
      .on(
        'POST',
        '/jobs/createTask',
        envelope({
          ...succeededTask([]),
          output: {
            text: 'hello world',
            transcript: {
              languageCode: 'en',
              durationSeconds: 1.2,
              words: [
                { text: 'hello', start: 0, end: 0.5, type: 'word' },
                { text: ' ', start: 0.5, end: 0.6, type: 'spacing' },
                { text: 'world', start: 0.6, end: 1.1, type: 'word' },
              ],
            },
          },
        }),
      );

    const result = await transcribe({
      model: provider(m.fetch).transcription('openai/whisper-1/speech-to-text'),
      audio: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    });

    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    expect(result.durationInSeconds).toBe(1.2);

    const [ticket] = m.callsTo('POST', '/common/upload-url');
    expect(ticket!.body).toEqual({ contentType: 'audio/wav', bytes: 12 });
    const [put] = m.callsTo('PUT', 'upload.example.com');
    expect(put!.headers.authorization).toBeUndefined();
    expect(put!.headers['content-length']).toBeUndefined();
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({
      audio_url: 'popnow://f/fil_1',
    });
  });

  it('passes a public HTTPS audio URL straight through', async () => {
    const m = mockFetch().on('POST', '/jobs/createTask', envelope({ ...succeededTask([]), output: { text: 'hi' } }));

    const result = await transcribe({
      model: provider(m.fetch).transcription('openai/whisper-1/speech-to-text'),
      audio: new URL('https://example.com/talk.mp3'),
      providerOptions: { popnow: { language: 'en' } },
    });

    expect(result.text).toBe('hi');
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({
      audio_url: 'https://example.com/talk.mp3',
      language: 'en',
    });
    expect(m.callsTo('GET', 'example.com')).toHaveLength(0);
  });
});

describe('chat model', () => {
  it('calls the OpenAI-compatible endpoint with the PopNow key', async () => {
    const m = mockFetch().on(
      'POST',
      'https://api.popnow.ai/v1/chat/completions',
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'anthropic/claude-haiku-5.5/chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Kites!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { text } = await generateText({
      model: provider(m.fetch)('anthropic/claude-haiku-5.5/chat'),
      prompt: 'Say kites',
    });

    expect(text).toBe('Kites!');
    const [call] = m.calls;
    expect(call!.headers.authorization).toBe('Bearer sk-popnow-test');
    expect(call!.body).toMatchObject({ model: 'anthropic/claude-haiku-5.5/chat' });
  });
});
