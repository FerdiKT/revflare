## What and why

<!-- What does this change and why? Link related issues: "Fixes #123". -->

## How it was tested

<!-- Tests added, manual checks (signed test notifications, sandbox purchases, simulator...). -->

## Checklist

- [ ] `npm run typecheck`, `npm test`, `npx vite build` and `npm run cli:build` pass
- [ ] PR title follows Conventional Commits (`feat: ...`, `fix(scope): ...`, `feat!: ...` for breaking changes; see CONTRIBUTING.md)
- [ ] Queries scoped by workspace and routes guarded by permissions
- [ ] Fits the Workers Free plan: subrequests per invocation, CPU, and the daily database budget (no `transactions` scans in recurring work)
- [ ] `docs/api.md`, `shared/types.ts` (+ `ios/Revflare/Core/Models.swift`, `cli/src/types.ts`), the MCP tools and the skill in sync with API changes
- [ ] Docs / README updated for user-visible changes
- [ ] No secrets, tokens, personal domains, bundle ids or real revenue / customer data in the diff (synthetic fixtures only)
