// Type-checked copy of the AI SDK Tools Registry code example (docs-submission/tools-registry-entry.ts).
// It is compiled by `npm run typecheck` but never run, because it would call real models.
import { generateText, isStepCount } from 'ai';
import { popnowTools } from '../src';

export async function registryExample() {
  const { text } = await generateText({
    model: 'openai/gpt-5-mini',
    prompt: 'Create a 16:9 poster of a paper whale drifting over a night city, then animate it into a short video.',
    // Every paid call is priced first and only runs at or below this USD limit.
    tools: popnowTools({ maxUsdPerCall: '0.50' }),
    stopWhen: isStepCount(5),
  });

  console.log(text);
}
