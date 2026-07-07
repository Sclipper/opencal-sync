# Contributing

PRs welcome. Before opening one:

1. `npm install`
2. `npx vitest run && npx tsc --noEmit && npm run build` must pass.
3. Keep Composio tool slugs/payloads inside `src/lib/providers/` only.
4. New sync logic needs a unit test (see `src/lib/sync/*.test.ts` for the style).

To verify a Composio tool's live parameter schema against the code:
`COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.mts GOOGLECALENDAR_CREATE_EVENT`
