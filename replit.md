# Laizysink Butler

A prompt-first assistant that plans multi-step research in parallel, shows cited evidence, asks for consent when needed, and pauses before external booking actions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/butler-assistant` — Stitch-matched React app
- `artifacts/api-server/src/routes/butler.ts` — task, source, memory, handoff, and SSE endpoints
- `artifacts/api-server/src/lib/butler.ts` — research orchestration, Exa retrieval, demo fallback, and task aggregation
- `lib/api-spec/openapi.yaml` — API contract and generated client source
- `lib/db/src/schema/butler.ts` — task, branch, source, question, and consented-memory tables
- `artifacts/butler-assistant/src/index.css` — visual theme and layout

## Architecture decisions

- Exa retrieval runs only on the server through the connected Replit integration; each branch has an eight-second timeout and a short query cache.
- Failed or unavailable live retrieval uses explicitly labeled demo references, never an Exa badge.
- Task updates are delivered to the task view with server-sent events; source and task records persist in PostgreSQL.
- Only “Remember always” and “Don’t ask again” create cross-task memory. Payment details are never requested or stored.

## Product

Users can start a task by typing or speaking, follow its parallel research branches, inspect clickable source snippets, answer structured questions with consent choices, manage remembered facts, and approve or cancel a safe booking handoff.

## User preferences

- The supplied Stitch screenshot is the source of truth for the app’s layout and styling; do not redesign it.

## Gotchas

- If the API contract changes, regenerate the clients with `pnpm --filter @workspace/api-spec run codegen`.
- Seed examples are visibly marked as demo references; they are not live search results.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
