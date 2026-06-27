# Phoenix span REST shape (confirmed 2026-06-27)

Phoenix version: **17.11.0** (`arizephoenix/phoenix:17.11.0`)  
Spike method: real OTLP/proto-HTTP spans sent via `opentelemetry-sdk` Python; REST read confirmed live.

---

## Envelope shape

```
GET /v1/projects/{project}/spans?limit=50&cursor=<cursor>
```

Returns:

```json
{ "data": [...], "next_cursor": null }
```

**CORRECTION vs brief:** the envelope key is `data`, NOT `spans`. The brief's documented shape had `{ spans: [...], next_cursor }` — the real key is `data`. The `PhoenixTraceReader` must destructure `response.data`, not `response.spans`.

---

## Span object shape (OBSERVED — live capture)

Every span in `data[]` has exactly these top-level keys:

```
id             string   Phoenix-internal opaque span ID (base64 Relay node ID)
name           string   span name — for AGENT spans this IS the agent identity
context        object   { trace_id: string (hex, 32 chars), span_id: string (hex, 16 chars) }
span_kind      string   "AGENT" | "LLM" | "CHAIN" | "TOOL" | "RETRIEVER" | "RERANKER" | "EMBEDDING" | "UNKNOWN"
parent_id      string|null   hex span_id of parent span; null for root
start_time     string   ISO-8601 with UTC offset (e.g. "2026-06-27T12:11:16.349252+00:00")
end_time       string   ISO-8601 with UTC offset
status_code    string   "OK" | "ERROR" | "UNSET"
status_message string   additional detail (empty string on OK)
attributes     object   flat key→value map (see below)
events         array    span events (empty for synthetic spans; may carry LLM message contents on real spans)
```

**Important:** `openinference.span.kind` is NOT present in `attributes` — Phoenix consumes it to populate the `span_kind` top-level field. Do not look for it in attributes.

---

## Attributes observed

### AGENT span (`span_kind = "AGENT"`)

```json
{
  "input.value": "<string input to agent>",
  "metadata.agentId": "strategy-analyst",
  "mastra.span.type": "agent_run",
  "session.id": "<session-id>"
}
```

### LLM span (`span_kind = "LLM"`)

```json
{
  "output.value": "<stringified JSON or plain text output>",
  "llm.model_name": "grok-3-mini",
  "llm.token_count.total": 640,
  "llm.token_count.prompt": 512,
  "llm.token_count.completion": 128,
  "metadata.agentId": "strategy-analyst",
  "mastra.span.type": "llm",
  "session.id": "<session-id>"
}
```

---

## Agent identity finding (OBSERVED)

**span `name` = `"strategy-analyst"`** — the bare agent ID string (no prefix like `agent.` or `mastra.`).

**`attributes["metadata.agentId"]` = `"strategy-analyst"`** — also present, same value as `name`.

The `PhoenixTraceReader` should match on EITHER `name` OR `attributes["metadata.agentId"]` for tolerance. Both are present in the observed output. The brief's reader design is consistent with reality.

---

## Project routing finding (OBSERVED — important for reader config)

Sending OTLP spans with `x-phoenix-project-name: trading-lab` header did NOT route spans to the `trading-lab` project — all spans landed in `default` regardless. The `trading-lab` project was created via `POST /v1/projects` but received zero spans via the OTLP header approach.

**Implication for PhoenixTraceReader (Task A4):** The reader's `project` config should default to `"default"` or be explicitly configurable. When trading-lab deploys for real, it should verify whether the header routing works with its specific OTEL SDK configuration.

---

## Projects endpoint

```
GET /v1/projects
```

Returns:

```json
{
  "data": [
    { "name": "default", "description": "Default project", "id": "UHJvamVjdDox" }
  ],
  "next_cursor": null
}
```

Same `{ data: [...], next_cursor }` envelope.

```
POST /v1/projects
Content-Type: application/json
{ "name": "trading-lab", "description": "..." }
```

Returns `{ "data": { "name": "...", "description": "...", "id": "..." } }`.

---

## Fixture

`src/read-api/phoenix/__fixtures__/phoenix-spans.fixture.json` — one AGENT root span + one LLM child span, same trace, OBSERVED output from live Phoenix 17.11.0.
