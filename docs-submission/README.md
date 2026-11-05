# Docs submission for vercel/ai

Draft files for a pull request to [vercel/ai](https://github.com/vercel/ai) that lists this
package among the AI SDK community providers. Nothing here is published with the npm package.

| File in this folder           | Destination in vercel/ai                                              |
| ----------------------------- | --------------------------------------------------------------------- |
| `59-popnow.mdx`               | `content/providers/05-community-providers/59-popnow.mdx` (new file)    |
| `providers-and-models.patch`  | One line added to `content/docs/02-foundations/02-providers-and-models.mdx`, in the community provider list |

Recent community provider pull requests (for example ZeroGPU, #24263) changed exactly these two
files. The number prefix only orders the sidebar; use the next free number when the pull request
is opened (58 was the highest in use on 2026-11-05). Submit after the npm package is published,
because the page links to it.

## Tools Registry entry

`tools-registry-entry.ts` holds the object to add to the `tools` array in
`content/tools-registry/registry.ts` of vercel/ai, which feeds the
[AI SDK Tools Registry](https://ai-sdk.dev/resources/tools). Paste only the object literal (from
`{ slug: 'popnow'` to the closing `}`), appended after the last entry, and follow
`contributing/add-new-tool-to-registry.md`: branch `feat/add-tool-popnow`, pull request title
`feat(tools-registry): add popnow`. The code example is the same as `test/registry-example.ts`,
which `npm run typecheck` compiles against the package. Open it after 0.2.0 is on npm and the
`docsUrl` page (https://popnow.ai/docs/ai-sdk) describes the agent tools.
