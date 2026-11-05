// Loads the built ESM bundle and checks the public surface without calling the API.
import assert from 'node:assert/strict';
import { createPopNow, popnow, PopNowTaskError, VERSION } from '../dist/index.js';

assert.equal(typeof createPopNow, 'function');
assert.equal(popnow.image('google/nano-banana-2.1/text-to-image').specificationVersion, 'v4');
assert.equal(popnow.speech('openai/tts-1/text-to-speech').provider, 'popnow.speech');
assert.equal(popnow.transcription('openai/whisper-1/speech-to-text').provider, 'popnow.transcription');
assert.equal(typeof popnow('anthropic/claude-haiku-5.5/chat').doGenerate, 'function');
assert.equal(typeof PopNowTaskError.isInstance, 'function');
assert.match(VERSION, /^\d+\.\d+\.\d+/);
console.log(`ESM smoke test passed (${VERSION})`);
