import { APICallError } from '@ai-sdk/provider';
import { generateImage } from 'ai';
import { describe, expect, it } from 'vitest';
import { PopNowTaskError, PopNowTaskTimeoutError } from '../src';
import { bytes, envelope, mockFetch, provider, schema, succeededTask } from './helpers';

const NANO = 'google/nano-banana-2.1/text-to-image';
const API = 'https://api.popnow.ai/api/v1';
const FILE_URL = 'https://media.popnow.ai/out/1.png';

const nanoSchema = {
  prompt: { type: 'string' },
  aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
  resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
};

describe('image model', () => {
  it('fetches the schema, creates a task with mapped input and returns the downloaded bytes', async () => {
    const m = mockFetch()
      .on('GET', `/models/google/nano-banana-2.1/text-to-image`, schema(nanoSchema))
      .on('POST', '/jobs/createTask', envelope(succeededTask([{ url: FILE_URL, mime: 'image/png', width: 1024, height: 576 }])))
      .on('GET', FILE_URL, bytes([1, 2, 3]));

    const result = await generateImage({
      model: provider(m.fetch).image(NANO),
      prompt: 'A paper whale in a library',
      aspectRatio: '16:9',
      providerOptions: { popnow: { resolution: '2k', metadata: { order: '42' } } },
    });

    expect(Array.from(result.image.uint8Array)).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);

    const [create] = m.callsTo('POST', '/jobs/createTask');
    expect(create!.url).toBe(`${API}/jobs/createTask?wait=60`);
    expect(create!.body).toEqual({
      model: NANO,
      input: { prompt: 'A paper whale in a library', aspect_ratio: '16:9', resolution: '2k' },
      metadata: { order: '42' },
    });
    expect(create!.headers.authorization).toBe('Bearer sk-popnow-test');
    expect(create!.headers['idempotency-key']).toMatch(/.+/);
    expect(create!.headers['user-agent']).toContain('popnow-ai-sdk-provider/');

    // The signed output URL is fetched without the API key.
    const [download] = m.callsTo('GET', FILE_URL);
    expect(download!.headers.authorization).toBeUndefined();

    expect(result.providerMetadata.popnow).toMatchObject({
      images: [{ taskId: 'job_1', costUsd: '0.048', settled: true, mediaType: 'image/png', width: 1024, height: 576 }],
    });
    expect(result.responses[0]!.modelId).toBe('test/model/text-to-image');
  });

  it('polls recordInfo until the task succeeds and its files are ready', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on('POST', '/jobs/createTask', envelope({ taskId: 'job_9', state: 'queued', estimatedCostUsd: '0.048' }, { status: 202 }))
      .on(
        'GET',
        '/jobs/recordInfo',
        envelope({ ...succeededTask([]), taskId: 'job_9', state: 'running', settled: false }),
        envelope(succeededTask([{ url: FILE_URL, mime: 'image/png', pending: true }], { taskId: 'job_9' })),
        envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }], { taskId: 'job_9' })),
      )
      .on('GET', FILE_URL, bytes([9]));

    const model = provider(m.fetch).image(NANO);
    const result = await model.doGenerate({
      prompt: 'fox',
      n: 1,
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
      providerOptions: { popnow: { pollIntervalMs: 1, waitSeconds: 0 } },
    });

    expect(m.callsTo('POST', '/jobs/createTask')[0]!.url).toBe(`${API}/jobs/createTask`);
    const polls = m.callsTo('GET', '/jobs/recordInfo');
    expect(polls).toHaveLength(3);
    expect(polls[0]!.url).toBe(`${API}/jobs/recordInfo?taskId=job_9`);
    expect(Array.from(result.images[0] as Uint8Array)).toEqual([9]);
  });

  it('throws PopNowTaskError when the task fails, noting that nothing is charged', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on(
        'POST',
        '/jobs/createTask',
        envelope({
          ...succeededTask([]),
          state: 'failed',
          errorCode: 'content_rejected',
          errorMessage: 'The model declined this content',
          costUsd: '0',
        }),
      );

    const error = await generateImage({
      model: provider(m.fetch).image(NANO),
      prompt: 'x',
      maxRetries: 0,
    }).catch((e: unknown) => e);

    expect(PopNowTaskError.isInstance(error)).toBe(true);
    const taskError = error as PopNowTaskError;
    expect(taskError.taskId).toBe('job_1');
    expect(taskError.errorCode).toBe('content_rejected');
    expect(taskError.costUsd).toBe('0');
    expect(taskError.message).toContain('not charged');
  });

  it('maps an envelope error to a non-retryable APICallError', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on('POST', '/jobs/createTask', envelope(null, { status: 402, code: 40201, msg: 'Insufficient API balance' }));

    const error = await generateImage({ model: provider(m.fetch).image(NANO), prompt: 'x' }).catch((e: unknown) => e);
    const cause = APICallError.isInstance(error) ? error : (error as { lastError?: unknown }).lastError;
    expect(APICallError.isInstance(cause)).toBe(true);
    expect((cause as APICallError).statusCode).toBe(402);
    expect((cause as APICallError).isRetryable).toBe(false);
    expect((cause as APICallError).message).toContain('40201');
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(1);
  });

  it('retries a 503 with the same Idempotency-Key', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(null, { status: 503, code: 503, msg: 'Briefly unavailable' }),
        envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }])),
      )
      .on('GET', FILE_URL, bytes([5]));

    await generateImage({ model: provider(m.fetch).image(NANO), prompt: 'x', maxRetries: 0 });
    const creates = m.callsTo('POST', '/jobs/createTask');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.headers['idempotency-key']).toBe(creates[1]!.headers['idempotency-key']);
  });

  it('stops polling when the abort signal fires', async () => {
    const controller = new AbortController();
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on('POST', '/jobs/createTask', () => {
        setTimeout(() => controller.abort(), 5);
        return envelope({ taskId: 'job_2', state: 'queued' }, { status: 202 });
      })
      .always('GET', '/jobs/recordInfo', envelope({ ...succeededTask([]), state: 'running' }));

    const error = await generateImage({
      model: provider(m.fetch).image(NANO),
      prompt: 'x',
      abortSignal: controller.signal,
      providerOptions: { popnow: { pollIntervalMs: 60_000 } },
    }).catch((e: unknown) => e);

    expect((error as Error).name).toBe('AbortError');
    expect(m.callsTo('GET', '/jobs/recordInfo')).toHaveLength(0);
  });

  it('throws PopNowTaskTimeoutError when the polling budget runs out', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on('POST', '/jobs/createTask', envelope({ taskId: 'job_3', state: 'queued' }, { status: 202 }))
      .always('GET', '/jobs/recordInfo', envelope({ ...succeededTask([]), taskId: 'job_3', state: 'running' }));

    const error = await generateImage({
      model: provider(m.fetch).image(NANO),
      prompt: 'x',
      maxRetries: 0,
      providerOptions: { popnow: { pollIntervalMs: 5, pollTimeoutMs: 30 } },
    }).catch((e: unknown) => e);

    expect(PopNowTaskTimeoutError.isInstance(error)).toBe(true);
    expect((error as PopNowTaskTimeoutError).taskId).toBe('job_3');
  });

  it('warns about settings the model schema does not have', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({ prompt: { type: 'string' } }))
      .on('POST', '/jobs/createTask', envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }])))
      .on('GET', FILE_URL, bytes([1]));

    const result = await generateImage({
      model: provider(m.fetch).image('example/plain/text-to-image'),
      prompt: 'x',
      aspectRatio: '16:9',
      seed: 7,
    });

    expect(m.callsTo('POST', '/jobs/createTask')[0]!.body).toMatchObject({ input: { prompt: 'x' } });
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({ prompt: 'x' });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'unsupported', feature: 'aspectRatio' }),
        expect.objectContaining({ type: 'unsupported', feature: 'seed' }),
      ]),
    );
  });

  it('maps size to aspect_ratio with a compatibility warning', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema(nanoSchema))
      .on('POST', '/jobs/createTask', envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }])))
      .on('GET', FILE_URL, bytes([1]));

    const result = await generateImage({ model: provider(m.fetch).image(NANO), prompt: 'x', size: '1920x1080' });
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({
      prompt: 'x',
      aspect_ratio: '16:9',
    });
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'compatibility', feature: 'size' })]);
  });

  it('asks for several images in one task when the model has num_outputs', async () => {
    const m = mockFetch()
      .always('GET', '/models/', schema({ prompt: { type: 'string' }, seed: { type: 'integer' }, num_outputs: { type: 'integer', maximum: 4 } }))
      .on(
        'POST',
        '/jobs/createTask',
        envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }, { url: `${FILE_URL}?2`, mime: 'image/png' }])),
      )
      .on('GET', FILE_URL, bytes([1]), bytes([2]));

    const result = await generateImage({
      model: provider(m.fetch).image('openai/gpt-image-2/text-to-image'),
      prompt: 'x',
      n: 2,
      seed: 3,
    });

    expect(result.images).toHaveLength(2);
    expect(m.callsTo('POST', '/jobs/createTask')).toHaveLength(1);
    expect((m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: object }).input).toEqual({
      prompt: 'x',
      seed: 3,
      num_outputs: 2,
    });
    // The schema is fetched once per provider and reused.
    expect(m.callsTo('GET', '/models/')).toHaveLength(1);
  });

  it('sends small input images inline and warns about an unsupported mask', async () => {
    const m = mockFetch()
      .on('GET', '/models/', schema({ prompt: { type: 'string' }, image_urls: { type: 'array' } }))
      .on('POST', '/jobs/createTask', envelope(succeededTask([{ url: FILE_URL, mime: 'image/png' }])))
      .on('GET', FILE_URL, bytes([1]));

    const result = await generateImage({
      model: provider(m.fetch).image('google/nano-banana-2.1/edit'),
      prompt: { text: 'make it green', images: [new Uint8Array([137, 80, 78, 71]), 'https://example.com/a.png'], mask: new Uint8Array([137, 80, 78, 71]) },
    });

    const input = (m.callsTo('POST', '/jobs/createTask')[0]!.body as { input: { image_urls: string[] } }).input;
    expect(input.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(input.image_urls[1]).toBe('https://example.com/a.png');
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'unsupported', feature: 'mask' })]);
  });

  it('reports a missing API key', async () => {
    const previous = process.env.POPNOW_API_KEY;
    delete process.env.POPNOW_API_KEY;
    try {
      const m = mockFetch();
      const { createPopNow } = await import('../src');
      const error = await generateImage({ model: createPopNow({ fetch: m.fetch }).image(NANO), prompt: 'x' }).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toContain('POPNOW_API_KEY');
      expect(m.calls).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.POPNOW_API_KEY = previous;
    }
  });
});
