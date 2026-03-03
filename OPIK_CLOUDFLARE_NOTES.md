# Opik + Cloudflare Workers + Vercel AI SDK — Integration Notes

## Why `opik-vercel` doesn't work with Cloudflare Workers

`opik-vercel` relies on OpenTelemetry instrumentation. In Cloudflare Workers, the standard OTel library is `@microlabs/otel-cf-workers`, but these two are fundamentally incompatible:

- `opik-vercel`'s `OpikExporter` filters incoming spans by `instrumentationScope.name === "ai"` (the scope Vercel AI SDK sets)
- `@microlabs/otel-cf-workers` overrides `instrumentationScope.name` to `"@microlabs/otel-cf-workers"` on **every** span, including the ones Vercel AI SDK emits
- Result: all spans are silently dropped — no errors, no traces in Opik

The OTLP alternative (pointing `@microlabs/otel-cf-workers` directly at Opik's OTLP endpoint) also fails because Opik's OTLP server returns 404 for spans with an unrecognised instrumentation scope.

**Use the Opik SDK directly instead** (see below).

---

## Cloudflare Workers: secrets and environment variables

Secrets set via the Cloudflare dashboard are **not** available through `process.env`. They are only accessible via the `env` parameter passed to the fetch handler:

```ts
// ✅ correct
const opikClient = new Opik({ apiKey: env.OPIK_API_KEY });

// ❌ wrong — always undefined in Workers
const opikClient = new Opik({ apiKey: process.env.OPIK_API_KEY });
```

This affects any library that reads credentials from `process.env` by default (e.g. `new OpikExporter()` with no arguments, `new Opik()` with no arguments).

---

## Opik SDK: workspace name

Pass `workspaceName` as `undefined` when it is not set — do **not** fall back to an empty string:

```ts
// ✅ correct — undefined lets the SDK use the default workspace
workspaceName: env.OPIK_WORKSPACE,

// ❌ wrong — empty string is sent literally and Opik returns 400 "No such workspace!"
workspaceName: env.OPIK_WORKSPACE || '',
```

---

## Manual Opik SDK tracing pattern for Cloudflare Workers

Create one `Opik` client and one root trace per request. Pass the trace down to functions that make LLM calls so spans are nested correctly.

```ts
// In the fetch handler
const opikClient = new Opik({
  apiKey: env.OPIK_API_KEY,
  workspaceName: env.OPIK_WORKSPACE,       // undefined is fine
  projectName: env.OPIK_PROJECT_NAME || 'my-project',
});

const rootTrace = opikClient.trace({
  name: 'request-trace',
  input: requestBody,
  metadata: { ... },
});

try {
  // ... call your functions, passing rootTrace ...
} finally {
  rootTrace.update({ output: finalResponse });
  rootTrace.end();
  await opikClient.flush(); // must await before the Worker returns
}
```

Inside each function that calls an LLM:

```ts
const span = parentTrace.span({
  name: 'my-llm-call',
  type: 'llm',
  input: { ... },
  metadata: { model: 'gpt-4o' },
});

const { output, usage } = await generateText({ ... });

span.update({
  output,
  usage: {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  },
});
span.end();
```

---

## Vercel AI SDK v6 token usage fields

The `usage` object returned by `generateText` uses `inputTokens` / `outputTokens` (both `number | undefined`), not `promptTokens` / `completionTokens`:

```ts
usage.inputTokens   // prompt tokens
usage.outputTokens  // completion tokens
```

Use `?? 0` when mapping to Opik's `usage` field since both can be `undefined`.
