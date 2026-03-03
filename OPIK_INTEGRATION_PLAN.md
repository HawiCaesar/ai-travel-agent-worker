# LLM Observability Integration: Opik for AI Travel Agent Worker

## Context

This Cloudflare Worker serves as an AI-powered travel planning API using Vercel AI SDK with GPT-4o. Currently, there's no visibility into LLM performance, costs, or behavior beyond basic console logging. We're integrating Comet/Opik to provide comprehensive LLM observability including:

- Tracing all LLM calls (GPT-4o for planning/weather, DALL-E for images)
- Monitoring token usage and costs
- Tracking latency and performance
- Debugging failed requests with full context
- Analyzing user patterns and model behavior

The project uses Vercel AI SDK's `generateText()` with tool calling, making it well-suited for OpenTelemetry-based automatic instrumentation.

## Implementation Approach

**Strategy**: Use Vercel AI SDK's native OpenTelemetry support with edge-compatible libraries

**Key packages**:
- `@microlabs/otel-cf-workers` - Edge-compatible OpenTelemetry SDK for Cloudflare Workers
- `opik-vercel` - OpikExporter to send traces to Comet/Opik cloud
- `@opentelemetry/api` - For manual DALL-E span creation

**Why this approach**:
- ✅ Leverages Vercel AI SDK's built-in `experimental_telemetry` feature
- ✅ Minimal code changes (mostly configuration)
- ✅ Works in Cloudflare Workers edge runtime (unlike standard Node.js OpenTelemetry)
- ✅ Automatic instrumentation for most LLM calls
- ✅ Full visibility in Opik dashboard including DALL-E

---

## Implementation Steps

### Step 1: Install Dependencies

```bash
npm install @microlabs/otel-cf-workers opik-vercel @opentelemetry/api
```

### Step 2: Update wrangler.jsonc

**File**: `wrangler.jsonc`

Add `nodejs_compat` flag (required for OpenTelemetry in Workers):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ai-travel-agent-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-11-17",
  "compatibility_flags": ["nodejs_compat"],  // ADD THIS
  "observability": {
    "enabled": true
  },
  "vars": {
    "ALLOWED_ORIGINS": "http://localhost:5173,https://hawiz-ai-travel-agent.netlify.app"
  }
}
```

### Step 3: Configure Environment Variables

Add Opik credentials as Cloudflare secrets:

```bash
# For production
wrangler secret put OPIK_API_KEY
wrangler secret put OPIK_WORKSPACE
wrangler secret put OPIK_PROJECT_NAME
```

For local development, create `.dev.vars` (don't commit):

```bash
# .dev.vars
OPIK_API_KEY=your-api-key-from-comet
OPIK_WORKSPACE=your-workspace-name
OPIK_PROJECT_NAME=ai-travel-agent-worker
```

**Opik URL**: Using Comet Cloud at `https://www.comet.com/opik/api` (OpikExporter default)

### Step 4: Update Env Interface

**File**: `src/index.ts`

Add to the `Env` interface (around line 68):

```typescript
interface Env {
  OPENAI_API_KEY: string;
  CLOUDFLARE_GATEWAY_URL: string;
  OPENWEATHER_API_KEY: string;
  ALLOWED_ORIGINS: string;
  // Add these:
  OPIK_API_KEY: string;
  OPIK_WORKSPACE?: string;
  OPIK_PROJECT_NAME?: string;
}
```

### Step 5: Add OpenTelemetry Imports

**File**: `src/index.ts` (top of file)

Add these imports:

```typescript
import { instrument, ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { OpikExporter } from 'opik-vercel';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
```

### Step 6: Create OpenTelemetry Configuration

**File**: `src/index.ts` (after imports, before first function ~line 102)

```typescript
// ============================================
// OpenTelemetry Configuration for Opik
// ============================================

const getOtelConfig: ResolveConfigFn = (env: Env, _trigger) => {
  return {
    exporter: new OpikExporter({
      // OpikExporter reads OPIK_API_KEY, OPIK_WORKSPACE, OPIK_PROJECT_NAME from env
    }),
    service: {
      name: env.OPIK_PROJECT_NAME || 'ai-travel-agent-worker',
      version: '1.0.0'
    },
  };
};
```

### Step 7: Enable Telemetry on LLM Calls

**File**: `src/index.ts`

#### 7a. Main Orchestrator Call (line ~289)

Add `experimental_telemetry` to the main `generateText()` call:

```typescript
const result = await generateText({
  model: openai('gpt-4o'),
  system: `You are a helpful AI travel agent...`,
  prompt: `I am travelling to ${destination}...`,
  tools: { /* existing tools */ },
  toolChoice: 'required',
  // ADD THIS:
  experimental_telemetry: OpikExporter.getSettings({
    functionId: 'travel-agent-orchestrator',
    metadata: {
      destination: requestBody.destination,
      flyingFrom: requestBody.flyingFrom,
      travelers: requestBody.travelers,
      budget: requestBody.budget,
      tripType: requestBody.tripType,
    },
  }),
});
```

#### 7b. Logistics Plan Generation (line ~118)

In `generateLogisticsPlanBasedOnUserInputToolCall` function:

```typescript
const { output } = await generateText({
  model: openai('gpt-4o'),
  output: Output.object({
    schema: travelPlanSchema,
  }),
  prompt: `You are a travel agent expert...`,
  // ADD THIS:
  experimental_telemetry: OpikExporter.getSettings({
    functionId: 'generate-logistics-plan',
    metadata: {
      destination: parsedInput.destination,
      origin: parsedInput.flyingFrom,
      travelers: parsedInput.travelers,
      budget: parsedInput.budget,
    },
  }),
});
```

#### 7c. Weather Description Generation (line ~188)

In `getCurrentWeather` function:

```typescript
const { output } = await generateText({
  model: openai('gpt-4o'),
  output: Output.object({
    schema: weatherDescriptionSchema,
  }),
  prompt: `Based on this weather data...`,
  // ADD THIS:
  experimental_telemetry: OpikExporter.getSettings({
    functionId: 'generate-weather-description',
    metadata: {
      destination,
      temperature: weatherData.current.temp,
      conditions: weatherData.current.weather[0].description,
    },
  }),
});
```

### Step 8: Add DALL-E Tracing

**File**: `src/index.ts` (line ~217, in `getCurrentWeather` function)

Wrap the DALL-E call with manual span:

```typescript
// Generate weather image
try {
  const tracer = trace.getTracer('ai-travel-agent');
  const span = tracer.startSpan('generate-weather-image', {
    attributes: {
      'llm.model': 'dall-e-3',
      'llm.provider': 'openai',
      'destination': destination,
      'weather.conditions': weatherData.current.weather[0].description,
    },
  });

  const openaiClient = new OpenAI({
    apiKey,
    baseURL,
  });

  const image = await openaiClient.images.generate({
    model: 'dall-e-3',
    prompt: `Generate a beautiful image representing this weather: ${weatherData.current.weather[0].description} in ${destination}`,
    size: '1024x1024',
    n: 1,
  });

  finalWeatherDetails.imageUrl = image?.data?.[0]?.url || '';

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
} catch (error) {
  if (span) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message
    });
    span.end();
  }
  console.error('Error generating DALL-E image:', error);
  return finalWeatherDetails;
}
```

### Step 9: Wrap Export Handler

**File**: `src/index.ts` (line ~232, at bottom)

Wrap the default export with OpenTelemetry instrumentation:

```typescript
// Before:
export default {
  async fetch(request, env, ctx): Promise<Response> {
    // ... handler code
  },
} satisfies ExportedHandler<Env>;

// After:
export default instrument(getOtelConfig, {
  async fetch(request, env, ctx): Promise<Response> {
    // ... handler code stays exactly the same
  },
} satisfies ExportedHandler<Env>);
```

---

## Trace Structure

This implementation creates the following trace hierarchy in Opik:

```
📊 Root Trace: Worker Request
├─ 🤖 Span: travel-agent-orchestrator (main GPT-4o call)
│  ├─ 🔧 Tool: generateLogisticsPlan
│  │  └─ 🤖 Span: generate-logistics-plan (nested GPT-4o call)
│  └─ 🔧 Tool: getCurrentWeather
│     ├─ 🤖 Span: generate-weather-description (nested GPT-4o call)
│     └─ 🎨 Span: generate-weather-image (DALL-E call)
```

**Captured data per span**:
- Input prompts (full text)
- Output responses (structured + text)
- Model name and provider
- Token counts and costs
- Duration/latency
- Custom metadata (destination, budget, etc.)
- Errors and failures

---

## Verification Steps

### Local Testing

1. **Start dev server**:
   ```bash
   npm run dev
   ```

2. **Send test request**:
   ```bash
   curl -X POST http://localhost:8787 \
     -H "Content-Type: application/json" \
     -H "Origin: http://localhost:5173" \
     -d '{
       "destination": "Tokyo",
       "flyingFrom": "San Francisco",
       "fromDate": "2026-07-01",
       "toDate": "2026-07-10",
       "budget": 4000,
       "travelers": 2,
       "tripType": "leisure"
     }'
   ```

3. **Check console for**:
   - No OpenTelemetry errors
   - Normal response from worker
   - Request completes successfully

4. **Verify in Opik dashboard** (https://www.comet.com/opik):
   - Navigate to your project
   - Check that traces appear within 30 seconds
   - Verify trace hierarchy matches expected structure
   - Confirm metadata is captured
   - Inspect LLM inputs/outputs

### Production Deployment

1. **Set production secrets**:
   ```bash
   wrangler secret put OPIK_API_KEY
   wrangler secret put OPIK_WORKSPACE
   wrangler secret put OPIK_PROJECT_NAME
   ```

2. **Deploy**:
   ```bash
   npm run deploy
   ```

3. **Test production endpoint** with real request

4. **Monitor Opik dashboard** for production traces

### Verification Checklist

- [ ] Traces appear in Opik within 30 seconds
- [ ] Root span named "travel-agent-orchestrator" exists
- [ ] All child spans visible (logistics plan, weather description, DALL-E)
- [ ] Custom metadata present (destination, budget, travelers)
- [ ] LLM prompts captured in span inputs
- [ ] LLM responses captured in span outputs
- [ ] Token usage metrics visible
- [ ] DALL-E spans show model and provider attributes
- [ ] Error traces appear when requests fail
- [ ] Worker latency impact < 10ms

---

## Error Handling

**Graceful degradation**: If Opik fails (network issues, invalid API key), the worker continues to function normally because:
- Span exports happen asynchronously after response via `ctx.waitUntil()`
- OpenTelemetry errors are caught and don't propagate to business logic
- Existing error handling (lines 369-372) remains unchanged

**Debugging**: If traces don't appear:
1. Check Cloudflare dashboard logs for OpenTelemetry errors
2. Verify OPIK_API_KEY is set correctly
3. Ensure `nodejs_compat` flag is enabled in wrangler.jsonc
4. Check network connectivity from Workers to Opik API

---

## Critical Files

- **src/index.ts** - Main implementation file (all code changes happen here)
  - Add imports (lines 1-7)
  - Add Env interface properties (~line 68)
  - Add OTel config function (~line 102)
  - Update 3 `generateText()` calls with telemetry
  - Add DALL-E span tracing (~line 217)
  - Wrap export with `instrument()` (~line 232)

- **wrangler.jsonc** - Configuration (add nodejs_compat flag)

- **package.json** - Dependencies (3 new packages)

- **.dev.vars** - Local env vars (create new, don't commit)

---

## Implementation Impact

- **Code changes**: ~80 lines in single file (src/index.ts)
- **New dependencies**: 3 packages
- **Configuration**: 1 flag + 3 env variables
- **Runtime overhead**: < 10ms per request
- **Architecture**: No changes to business logic
- **Reversibility**: Can be disabled by removing `instrument()` wrapper

---

## Next Steps After Implementation

1. **Monitor costs**: Track token usage in Opik to optimize prompts
2. **Set up alerts**: Configure Opik alerts for high latency or error rates
3. **Analyze patterns**: Review common user requests to improve recommendations
4. **Optimize prompts**: Use Opik data to refine prompts for better results
5. **A/B testing**: Compare different prompt versions using Opik experiments

---

## References

- [Opik Vercel AI SDK Integration](https://www.comet.com/docs/opik/integrations/vercel-ai-sdk)
- [Opik Cloudflare Workers AI](https://www.comet.com/docs/opik/integrations/cloudflare-workers-ai)
- [Cloudflare Workers OpenTelemetry](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [otel-cf-workers GitHub](https://github.com/evanderkoogh/otel-cf-workers)
- [Vercel AI SDK Telemetry](https://sdk.vercel.ai/docs/ai-sdk-core/telemetry)
