// Entry for the AI SDK Tools Registry (https://ai-sdk.dev/resources/tools).
// Add this object to the `tools` array in content/tools-registry/registry.ts of vercel/ai.
// The code example is type-checked in this repository as test/registry-example.ts.
import type { Tool } from './registry';

export const popnowRegistryEntry: Tool = {
  slug: 'popnow',
  name: 'PopNow',
  description:
    'Give agents media generation tools: create images, videos, songs and speech with Nano Banana, GPT Image, Seedream, FLUX, MiniMax H3, Kling, Seedance, Veo, Suno, Gemini TTS and more through one PopNow API key. Every paid call is priced first and only runs within a USD limit you set; long videos return a task id the agent can check later.',
  packageName: '@popnow/ai-sdk-provider',
  tags: ['image-generation', 'video-generation', 'audio', 'text-to-speech', 'media'],
  apiKeyEnvName: 'POPNOW_API_KEY',
  installCommand: {
    pnpm: 'pnpm add @popnow/ai-sdk-provider ai zod',
    npm: 'npm install @popnow/ai-sdk-provider ai zod',
    yarn: 'yarn add @popnow/ai-sdk-provider ai zod',
    bun: 'bun add @popnow/ai-sdk-provider ai zod',
  },
  codeExample: `import { generateText, isStepCount } from 'ai';
import { popnowTools } from '@popnow/ai-sdk-provider';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'Create a 16:9 poster of a paper whale drifting over a night city, then animate it into a short video.',
  // Every paid call is priced first and only runs at or below this USD limit.
  tools: popnowTools({ maxUsdPerCall: '0.50' }),
  stopWhen: isStepCount(5),
});

console.log(text);`,
  docsUrl: 'https://popnow.ai/docs/ai-sdk',
  apiKeyUrl: 'https://popnow.ai/api/console/keys',
  websiteUrl: 'https://popnow.ai',
  npmUrl: 'https://www.npmjs.com/package/@popnow/ai-sdk-provider',
};
