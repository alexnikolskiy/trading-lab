# SP-6.1 — Chat Ingress Service Boundary — Design

Status: **Approved** (design) · Date: 2026-06-14 · Depends on: SP-4.6 (chat ingress: `createChatApp`, `POST /chat/messages`, intent classifier, task creation, session context, auto-chain), SP-5 (read-only API foundation: `readAuthMiddleware`, constant-time `safeEqual`, `TRADING_LAB_READ_TOKEN`)

## 1. Goal

Turn the existing `POST /chat/messages` write/ingress endpoint into a safe, stable **internal service-to-service boundary** for a future `TradingLabChatConnector` in trading-office, without changing chat behavior.

```
Browser
  → trading-office backend            (user auth lives here)
    → TradingLabChatConnector         (future, NOT in this slice)
      → trading-lab POST /chat/messages   (Authorization: Bearer <TRADING_LAB_CHAT_TOKEN>)
```

The browser never calls trading-lab directly. trading-lab only ever receives a service-to-service request from the office backend.

## 2. Scope boundary

In scope:
- A dedicated service-to-service auth gate on `POST /chat/messages`, fed by a **new, separate** token (`TRADING_LAB_CHAT_TOKEN`).
- A documented, stable request/response contract for the office connector.
- Tests proving auth separation (read token ≠ chat token) and no regression of chat behavior.

Explicitly out of scope (unchanged):
- trading-office connector implementation; browser-facing chat endpoint; streaming assistant responses; durable transcript UI; platform SDK/MCP integration; live bot health; changes to intent / research / workflow logic; any change to SP-6 SSE semantics; Boss terminology.
- **`POST /tasks`** ingress on the same port — left untouched here; it is a separate **follow-up (SP-6.2 Task Ingress Service Boundary)**.

## 3. Topology (what changes, what doesn't)

`POST /chat/messages` stays exactly where it is: served by `createChatApp` (`src/chat/chat-app.ts`), mounted at `/chat` on the **main ingress app** on `INGRESS_PORT` (default 3000) in `src/ingress/server.ts`, alongside the unrelated `POST /tasks` ingress.

No new ports. No new endpoints. No streaming. The only addition is an **auth gate in front of the chat routes**, fed by a token wholly separate from `TRADING_LAB_READ_TOKEN`.

Chat and read remain two independent Hono apps with independently-injected tokens, so a read token is never seen by the chat app and vice versa. **The separation is structural, not a runtime cross-check.**

| Boundary | App | Port | Token | Unset behavior |
|---|---|---|---|---|
| Read API | `createReadApp` `/v1/*` | `READ_API_PORT` (3100) | `TRADING_LAB_READ_TOKEN` | listener does not start |
| Chat ingress | `createChatApp` `/chat/messages` | `INGRESS_PORT` (3000) | `TRADING_LAB_CHAT_TOKEN` | route mounted, **rejects all → 503** |

## 4. Auth middleware

New `chatAuthMiddleware(token?: string)` in `src/chat/auth.ts`. It is **always registered first** inside `createChatApp` (`app.use('*', chatAuthMiddleware(deps.authToken))`), so it runs **before JSON parsing, schema validation, the size cap, and the handler** — an unauthorized request never reaches body processing. Fail-closed policy:

| Condition | Status | Body |
|---|---|---|
| `token` unset / empty | **503** | `{ error: { code: 'service_unavailable', message: 'chat ingress not configured' } }` |
| `token` set, header missing or token wrong | **401** | `{ error: { code: 'unauthorized', message: 'missing or invalid token' } }` |
| `token` set, Bearer matches (constant-time) | — | `next()` — existing flow runs unchanged |

Rationale for the 503/401 split: 503 ("boundary not configured") is a distinct **operator** signal from 401 ("bad credential" — a **caller** problem). The 401 envelope is identical to the read API's, so the office connector handles 401 uniformly across both boundaries. Because the middleware is always registered, "unset ⇒ reject" holds — there is no code path where an unconfigured chat ingress silently accepts traffic.

## 5. Shared auth helper

New `src/auth/bearer.ts` owns only **low-level, security-sensitive primitives** — no middleware, no policy:

- `parseBearer(header: string | undefined): string | null` — extracts the token after the `Bearer ` prefix; returns `null` when the header is absent or malformed.
- `safeEqual(a: string, b: string): boolean` — constant-time compare; hashes both sides to a fixed 32-byte digest first so timing is independent of input length.

Consumers:
- `src/read-api/auth.ts` **remains the owner of `readAuthMiddleware`**; it is refactored to consume `parseBearer` + `safeEqual` from `bearer.ts`, and **re-exports `safeEqual`** so the existing `import { readAuthMiddleware, safeEqual } from './auth.ts'` in `read-api/auth.test.ts` keeps working with no edit. Read API behavior is unchanged.
- `src/chat/auth.ts` owns `chatAuthMiddleware`; it consumes `parseBearer` + `safeEqual` from `bearer.ts`.
- **`chat/auth.ts` does NOT import from `read-api/auth.ts`.** The two middlewares share primitives, never policy — their semantics differ (read: listener gated on token presence; chat: route always mounted, 503 when unset).

## 6. Wiring

- `src/config/env.ts`: add `TRADING_LAB_CHAT_TOKEN?: string` to `Env` and `loadEnv` (plain pass-through, like the read token; no `?? ''` so unset stays distinguishable).
- `src/chat/chat-app.ts`: `ChatAppDeps` gains `authToken?: string`; `createChatApp` registers `app.use('*', chatAuthMiddleware(deps.authToken))` as the first middleware.
- `src/composition.ts`: `chat` deps get `authToken: env.TRADING_LAB_CHAT_TOKEN`.
- `src/ingress/server.ts`: startup `console.warn('[chat] TRADING_LAB_CHAT_TOKEN not set — /chat/messages will reject all requests (503)')` when unset, mirroring the read listener's warn-on-unset, so a misconfigured prod deploy is visible in logs.

## 7. Contract (for the future `TradingLabChatConnector`)

New `src/chat/README.md` (mirrors `read-api/README.md`) documents the stable contract:

- **Endpoint:** `POST /chat/messages` on `INGRESS_PORT`. Service-to-service only.
- **Auth:** `Authorization: Bearer <TRADING_LAB_CHAT_TOKEN>`. Distinct from `TRADING_LAB_READ_TOKEN`. `401` on missing/wrong token; `503` when the boundary is not configured.
- **Request** (`ChatMessageRequestSchema`): `{ message: string (trimmed, 1..CHAT_MAX_MESSAGE_CHARS), sessionId?: string, channel: 'web' | 'telegram' (default 'web') }`. `content-type: application/json`.
- **Response:** the `ChatResponse` discriminated union at `200` — `task_created` (with optional `plannedNextStep` auto-chain), `task_status`, `needs_clarification`, `out_of_scope`, `capability_not_available`, `help`, `rejected`, `error`. Rejection envelopes at `400`: invalid body (`{ status: 'rejected', issues }`) and oversize (`{ status: 'rejected', reason: 'message_too_long', maxMessageChars }`). Auth failures at `401` / `503` (§4).
- **Session semantics:** `sessionId` omitted → a new id is generated and echoed; provided → session context is loaded and updated. Auto-chain continuation is surfaced via `plannedNextStep`.
- **Notes:** browser never calls trading-lab directly; there is no chat streaming and no command channel; SP-6 SSE is unaffected.

## 8. `.env.example`

Add to the chat block a **dev placeholder** (non-empty so `docker compose up` chat works under fail-closed):

```
TRADING_LAB_CHAT_TOKEN=dev-chat-token   # service-to-service token for POST /chat/messages
# production MUST override this value
# MUST differ from TRADING_LAB_READ_TOKEN (read API and chat ingress are separate boundaries)
# browser never calls trading-lab directly — office backend is the only caller
# INGRESS_PORT must not be public without network protection (reverse proxy / firewall)
```

## 9. Tests

- `src/auth/bearer.test.ts` — `parseBearer` (valid / missing / malformed header) and `safeEqual` (equal match, mismatch incl. different lengths).
- `src/chat/auth.test.ts` — unset token → 503; set + missing header → 401; set + wrong token → 401; set + correct Bearer → reaches handler (200/400 as the flow dictates).
- **Separation tests** (behavioral proof of the guardrail):
  - chat app built with token `A` rejects `Bearer B` (a stand-in read token) → 401.
  - read app built with token `B` rejects `Bearer A` (the chat token) → 401.
- `src/chat/chat-app.test.ts` — update the shared `appDeps()` to set a default `authToken` and the `post()` helper to send the `Authorization: Bearer …` header, so **all existing behavior assertions** (empty / whitespace / oversize / out_of_scope / task_created) still exercise the real handler through the real auth middleware and pass — proving no regression of validation, size cap, session handling, or auto-chain.
- `test/e2e/chat-to-task.test.ts` — same fixture update (`authToken` + header).
- `src/config/env.test.ts` — assert `TRADING_LAB_CHAT_TOKEN` loads from source.

## 10. Guardrails (carried from the slice brief)

- `TRADING_LAB_READ_TOKEN` must never authorize `/chat/messages`; `TRADING_LAB_CHAT_TOKEN` must never authorize `/v1/*` — enforced structurally (separate apps, separate injected tokens) and proven by the separation tests.
- Browser direct access stays out of scope; user auth stays in trading-office.
- No browser-facing endpoints, no WebSocket / chat streaming, no SP-6 SSE changes, no trading-office implementation, no platform SDK/MCP, no research-workflow changes, no Boss terminology.

## 11. Files

```
src/auth/bearer.ts                 # CREATE: parseBearer + safeEqual (shared primitives)
src/auth/bearer.test.ts            # CREATE
src/chat/auth.ts                   # CREATE: chatAuthMiddleware (fail-closed)
src/chat/auth.test.ts              # CREATE
src/chat/README.md                 # CREATE: connector contract
src/read-api/auth.ts               # TOUCH: consume bearer.ts; re-export safeEqual
src/chat/chat-app.ts               # TOUCH: ChatAppDeps.authToken; register middleware first
src/chat/chat-app.test.ts          # TOUCH: appDeps authToken + post() Bearer header
src/config/env.ts                  # TOUCH: + TRADING_LAB_CHAT_TOKEN
src/config/env.test.ts             # TOUCH: + assertion
src/composition.ts                 # TOUCH: chat.authToken = env.TRADING_LAB_CHAT_TOKEN
src/ingress/server.ts              # TOUCH: warn when unset
test/e2e/chat-to-task.test.ts      # TOUCH: authToken + header
.env.example                       # TOUCH: + TRADING_LAB_CHAT_TOKEN dev placeholder + comments
```
