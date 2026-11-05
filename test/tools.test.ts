import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  createImageTool,
  createMusicTool,
  createSpeechTool,
  createVideoTool,
  getTaskTool,
  listModelsTool,
  popnowTools,
  type PopNowToolsSettings,
} from '../src';
import { envelope, mockFetch, schema } from './helpers';

const API = 'https://api.popnow.ai/api/v1';
const OUT = 'https://media.popnow.ai/out/1.png';
const noSleep = { sleep: async () => {} };

function settings(fetch: typeof globalThis.fetch, extra: PopNowToolsSettings = {}): PopNowToolsSettings {
  return { apiKey: 'sk-popnow-test', fetch, _internal: noSleep, ...extra };
}

function quote(maxChargeUsd: string, extra: Record<string, unknown> = {}) {
  return envelope({ quoteId: 'q_1', maxChargeUsd, expectedChargeUsd: maxChargeUsd, currency: 'USD', ...extra });
}

function task(state: string, extra: Record<string, unknown> = {}) {
  return {
    taskId: 'job_1',
    model: 'test/model',
    state,
    settled: state !== 'running' && state !== 'queued',
    createdAt: '2026-11-05T00:00:00Z',
    ...extra,
  };
}

const options = (id = 'call_1') => ({ toolCallId: id, messages: [], context: {} }) as never;

async function run<T>(t: { execute?: unknown }, input: T, id?: string) {
  const execute = t.execute as (input: T, options: never) => Promise<Record<string, unknown>>;
  return execute(input, options(id));
}

describe('agent tools', () => {
  it('quotes, then creates the image task with the quote and returns URLs and popnow:// references', async () => {
    const m = mockFetch()
      .on('GET', '/models/google/nano-banana-2.1/text-to-image', schema({ prompt: {}, aspect_ratio: {}, resolution: {} }))
      .on('POST', '/jobs/quote', quote('0.048'))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(
          task('succeeded', {
            model: 'google/nano-banana-2.1/text-to-image',
            costUsd: '0.048',
            output: {
              assets: [{ url: OUT, mime: 'image/png', width: 1024, height: 1024, expiresAt: '2026-11-05T00:20:00Z' }],
            },
          }),
        ),
      );

    const result = await run(createImageTool(settings(m.fetch)), { prompt: 'A paper whale', aspectRatio: '1:1' });

    expect(result).toMatchObject({
      status: 'succeeded',
      taskId: 'job_1',
      model: 'google/nano-banana-2.1/text-to-image',
      costUsd: '0.048',
      outputs: [{ url: OUT, uri: 'popnow://g/job_1/0', mime: 'image/png', width: 1024, height: 1024 }],
    });

    const [q] = m.callsTo('POST', '/jobs/quote');
    expect(q!.url).toBe(`${API}/jobs/quote`);
    expect(q!.body).toEqual({
      model: 'google/nano-banana-2.1/text-to-image',
      input: { prompt: 'A paper whale', aspect_ratio: '1:1' },
    });
    const [create] = m.callsTo('POST', '/jobs/createTask');
    expect(create!.url).toBe(`${API}/jobs/createTask?wait=30`);
    expect(create!.body).toEqual({
      model: 'google/nano-banana-2.1/text-to-image',
      input: { prompt: 'A paper whale', aspect_ratio: '1:1' },
      quoteId: 'q_1',
      expectedCostUsd: '0.048',
    });
    expect(create!.headers['idempotency-key']).toMatch(/.+/);
    expect(create!.headers.authorization).toBe('Bearer sk-popnow-test');
  });

  it('uses the edit model for source images and leaves out fields the model does not have', async () => {
    const m = mockFetch()
      .on('GET', '/models/google/nano-banana-2.1/edit', schema({ prompt: {}, image_url: {} }))
      .on('POST', '/jobs/quote', quote('0.048'))
      .on('POST', '/jobs/createTask', envelope(task('succeeded', { output: { assets: [{ url: OUT }] } })));

    const result = await run(createImageTool(settings(m.fetch)), {
      prompt: 'Make the jacket green',
      imageUrls: ['popnow://g/job_0/0'],
      aspectRatio: '16:9',
      extraInput: { output_format: 'png' },
    });

    expect(result.ignoredFields).toEqual(['aspect_ratio']);
    expect(m.callsTo('POST', '/jobs/createTask')[0]!.body).toMatchObject({
      model: 'google/nano-banana-2.1/edit',
      input: { prompt: 'Make the jacket green', image_url: 'popnow://g/job_0/0', output_format: 'png' },
    });
  });

  it('refuses a quote above maxUsdPerCall without creating a task', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.74'));

    const result = await run(createVideoTool(settings(m.fetch)), { prompt: 'A long cinematic shot', durationSeconds: 20 });

    expect(result).toMatchObject({
      status: 'over_limit',
      limit: 'per_call',
      limitUsd: '0.5',
      maxChargeUsd: '0.74',
    });
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(0);
  });

  it('honours a custom per-call limit exactly and can remove it', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.100000001'), quote('5'))
      .always('POST', '/jobs/createTask', envelope(task('succeeded', { output: { assets: [] } })));

    const capped = await run(createImageTool(settings(m.fetch, { maxUsdPerCall: '0.1' })), { prompt: 'x' });
    expect(capped.status).toBe('over_limit');

    const uncapped = await run(createImageTool(settings(m.fetch, { maxUsdPerCall: null })), { prompt: 'x' });
    expect(uncapped.status).toBe('succeeded');

    expect(() => popnowTools(settings(m.fetch, { maxUsdPerCall: '-1' }))).toThrow(/maxUsdPerCall/);
  });

  it('keeps a total budget across the tool set and does not count failed tasks', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .always('POST', '/jobs/quote', quote('0.04'))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(task('failed', { errorCode: 'upstream_failed' })),
        envelope(task('succeeded', { costUsd: '0.04', output: { assets: [] } })),
        envelope(task('succeeded', { costUsd: '0.04', output: { assets: [] } })),
      );
    const tools = popnowTools(settings(m.fetch, { maxUsdTotal: '0.08' }));

    expect((await run(tools.generateImage, { prompt: 'a' })).status).toBe('failed');
    expect((await run(tools.generateMusic, { prompt: 'b' })).status).toBe('succeeded');
    expect((await run(tools.generateSpeech, { text: 'c' })).status).toBe('succeeded');
    const refused = await run(tools.generateImage, { prompt: 'd' });
    expect(refused).toMatchObject({ status: 'over_limit', limit: 'total', limitUsd: '0.08', remainingUsd: '0' });
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(3);
  });

  it('lets onQuote decline a call before anything is created', async () => {
    const seen: unknown[] = [];
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.2'));

    const result = await run(
      createMusicTool(
        settings(m.fetch, {
          onQuote: (event) => {
            seen.push({ tool: event.toolName, model: event.model, usd: event.quote.maxChargeUsd, id: event.toolCallId });
            return false;
          },
        }),
      ),
      { prompt: 'lofi', instrumental: true },
      'call_9',
    );

    expect(result).toMatchObject({ status: 'declined', maxChargeUsd: '0.2' });
    expect(seen).toEqual([{ tool: 'generateMusic', model: 'suno/v6/text-to-audio', usd: '0.2', id: 'call_9' }]);
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(0);
  });

  it('polls a video task until it succeeds', async () => {
    const m = mockFetch()
      .on('GET', '/models/minimax/h3/image-to-video', schema({ prompt: {}, image_url: {}, aspect_ratio: {}, duration_seconds: {} }))
      .on('POST', '/jobs/quote', quote('0.222'))
      .on('POST', '/jobs/createTask', envelope({ taskId: 'job_v', state: 'queued', estimatedCostUsd: '0.222' }, { status: 202 }))
      .on(
        'GET',
        '/jobs/recordInfo',
        envelope(task('running', { taskId: 'job_v' })),
        envelope(task('succeeded', { taskId: 'job_v', output: { assets: [{ url: OUT, pending: true }] } })),
        envelope(
          task('succeeded', {
            taskId: 'job_v',
            model: 'minimax/h3/image-to-video',
            costUsd: '0.222',
            output: { assets: [{ url: OUT, mime: 'video/mp4', durationSeconds: 6 }] },
          }),
        ),
      );

    const result = await run(createVideoTool(settings(m.fetch)), {
      prompt: 'The whale swims away',
      imageUrl: 'popnow://g/job_1/0',
      aspectRatio: '9:16',
      durationSeconds: 6,
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      taskId: 'job_v',
      outputs: [{ url: OUT, uri: 'popnow://g/job_v/0', mime: 'video/mp4', durationSeconds: 6 }],
    });
    // MiniMax H3 image to video follows the image's aspect ratio.
    expect(m.callsTo('POST', '/jobs/quote')[0]!.body).toEqual({
      model: 'minimax/h3/image-to-video',
      input: { prompt: 'The whale swims away', image_url: 'popnow://g/job_1/0', duration_seconds: 6 },
    });
    expect(m.callsTo('GET', '/jobs/recordInfo')).toHaveLength(3);
    expect(m.callsTo('GET', '/jobs/recordInfo')[0]!.url).toBe(`${API}/jobs/recordInfo?taskId=job_v`);
  });

  it('returns the task id when the wait runs out, and getTask collects the result later', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.3'))
      .on('POST', '/jobs/createTask', envelope({ taskId: 'job_slow', state: 'queued', estimatedCostUsd: '0.3' }, { status: 202 }));

    const result = await run(createVideoTool(settings(m.fetch, { waitTimeoutMs: 0 })), { prompt: 'storm' });
    expect(result).toMatchObject({ status: 'running', taskId: 'job_slow', state: 'queued', maxChargeUsd: '0.3' });
    expect(m.callsTo('POST', '/jobs/createTask')[0]!.url).toBe(`${API}/jobs/createTask`);
    expect(m.callsTo('GET', '/jobs/recordInfo')).toHaveLength(0);

    m.on(
      'GET',
      '/jobs/recordInfo',
      envelope(task('running', { taskId: 'job_slow' })),
      envelope(task('succeeded', { taskId: 'job_slow', output: { assets: [{ url: OUT, mime: 'video/mp4' }] } })),
    );
    const collected = await run(getTaskTool(settings(m.fetch)), { taskId: 'job_slow', waitSeconds: 60 });
    expect(collected).toMatchObject({ status: 'succeeded', taskId: 'job_slow', outputs: [{ uri: 'popnow://g/job_slow/0' }] });
  });

  it('stops polling at the timeout with real delays', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.3'))
      .on('POST', '/jobs/createTask', envelope({ taskId: 'job_t', state: 'queued' }, { status: 202 }))
      .always('GET', '/jobs/recordInfo', envelope(task('running', { taskId: 'job_t' })));

    const started = Date.now();
    const result = await run(
      createVideoTool({ apiKey: 'sk-popnow-test', fetch: m.fetch, waitTimeoutMs: 60, pollIntervalMs: 5 }),
      { prompt: 'storm' },
    );
    expect(result).toMatchObject({ status: 'running', taskId: 'job_t', state: 'running' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(m.callsTo('GET', '/jobs/recordInfo').length).toBeGreaterThan(0);
  });

  it('reports a failed task without throwing', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', quote('0.01'))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(task('failed', { errorCode: 'content_rejected', errorMessage: 'Rejected by the safety check' })),
      );

    const result = await run(createSpeechTool(settings(m.fetch)), { text: 'Hello', voiceId: 'Kore', style: 'warm' });
    expect(result).toMatchObject({
      status: 'failed',
      state: 'failed',
      errorCode: 'content_rejected',
      errorMessage: 'Rejected by the safety check',
    });
    expect(m.callsTo('POST', '/jobs/quote')[0]!.body).toEqual({
      model: 'google/gemini-3.8-flash-tts/text-to-speech',
      input: { text: 'Hello', voice_id: 'Kore', style: 'warm' },
    });
  });

  it('turns API errors into actionable messages and releases the budget of a rejected create', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .always('POST', '/jobs/quote', quote('0.05'))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(null, { status: 402, code: 40201, msg: 'Insufficient API balance' }),
        envelope(task('succeeded', { output: { assets: [] } })),
      );
    const tools = popnowTools(settings(m.fetch, { maxUsdTotal: '0.05' }));

    await expect(run(tools.generateImage, { prompt: 'a' })).rejects.toThrow(/Insufficient API balance.*console\/billing/);
    expect((await run(tools.generateImage, { prompt: 'a' })).status).toBe('succeeded');
  });

  it('does not create a task when the quote is rejected', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({}))
      .on('POST', '/jobs/quote', envelope(null, { status: 400, code: 400, msg: 'input.duration_seconds must be 6 or 10' }));

    await expect(run(createVideoTool(settings(m.fetch)), { prompt: 'x', durationSeconds: 7 })).rejects.toThrow(
      /duration_seconds.*list models tool/,
    );
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(0);
  });

  it('can pin the model', async () => {
    const m = mockFetch();
    const pinned = createImageTool(settings(m.fetch, { allowModelOverride: false }));
    await expect(run(pinned, { prompt: 'x', model: 'openai/gpt-image-2/text-to-image' })).rejects.toThrow(/configured to use/);
    expect(m.calls).toHaveLength(0);
  });

  it('lists models and returns one model with its input schema', async () => {
    const m = mockFetch()
      .on(
        'GET',
        '/models?',
        envelope({
          total: 2,
          items: [
            { model: 'kling/3.0/text-to-video', displayName: 'Kling 3.0', modality: 'video', tasks: ['text-to-video'], usd: { unit: 'per_second', perUnit: '0.07' }, available: true, family: 'kling' },
            { model: 'minimax/h3/text-to-video', displayName: 'MiniMax H3', modality: 'video', tasks: ['text-to-video'], available: true },
          ],
        }),
      )
      .on('GET', '/models/kling/3.0/text-to-video', envelope({ model: 'kling/3.0/text-to-video', displayName: 'Kling 3.0', available: true, inputSchema: { type: 'object', properties: { prompt: {} } } }));
    const t = listModelsTool(settings(m.fetch));

    const list = await run(t, { modality: 'video', search: 'kling', limit: 1 });
    expect(list).toEqual({
      total: 2,
      returned: 1,
      models: [{ model: 'kling/3.0/text-to-video', name: 'Kling 3.0', modality: 'video', tasks: ['text-to-video'], usd: { unit: 'per_second', perUnit: '0.07' }, available: true }],
    });
    expect(m.calls[0]!.url).toBe(`${API}/models?modality=video&search=kling`);

    const detail = await run(t, { model: 'kling/3.0/text-to-video' });
    expect(detail).toMatchObject({ model: 'kling/3.0/text-to-video', inputSchema: { properties: { prompt: {} } } });
  });

  it('works inside generateText', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({ prompt: {} }))
      .on('POST', '/jobs/quote', quote('0.048'))
      .on('POST', '/jobs/createTask', envelope(task('succeeded', { output: { assets: [{ url: OUT }] } })));

    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'generateImage', input: JSON.stringify({ prompt: 'fox' }) }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'Here is your fox.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });

    const result = await generateText({
      model,
      prompt: 'Draw a fox',
      tools: popnowTools(settings(m.fetch)),
      stopWhen: isStepCount(3),
    });

    expect(result.text).toBe('Here is your fox.');
    const toolResult = result.steps[0]!.toolResults[0]!;
    expect(toolResult.output).toMatchObject({ status: 'succeeded', outputs: [{ url: OUT, uri: 'popnow://g/job_1/0' }] });
  });
});
