// Loads the built CommonJS bundle and checks the public surface without calling the API.
const assert = require('node:assert/strict');
const { createPopNow, popnow, popnowTools, createVideoTool, VERSION } = require('../dist/index.cjs');

assert.equal(typeof createPopNow, 'function');
assert.equal(popnow.imageModel('google/nano-banana-2.1/edit').provider, 'popnow.image');
assert.equal(typeof popnowTools().generateVideo.execute, 'function');
assert.equal(typeof createVideoTool({ maxUsdPerCall: '1' }).inputSchema, 'object');
assert.match(VERSION, /^\d+\.\d+\.\d+/);
console.log(`CJS smoke test passed (${VERSION})`);
