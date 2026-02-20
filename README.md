# AI Travel Agent Worker

A Cloudflare Worker that powers an AI-driven travel planning service. This backend API generates personalized travel itineraries and provides real-time weather information for destinations worldwide.

This is the backend for the [AI Travel Agent](https://github.com/HawiCaesar/ai-travel-agent) frontend application.

## What It Does

This worker provides intelligent travel planning through AI-powered recommendations:

### 🛫 Travel Itinerary Generation
- **Personalized flight recommendations** - Suggests optimal flights based on origin, destination, dates, and budget
- **Hotel recommendations** - Provides 4-5 star hotel options with pricing and location details
- **Activity suggestions** - Recommends 3 activities with emojis tailored to your trip type (business, leisure, adventure, etc.)
- **Budget analysis** - Validates if your travel plan fits within budget and provides cost breakdowns
- **Smart planning** - Considers number of travelers, layovers, and realistic pricing

### 🌤️ Weather Intelligence
- **Current weather data** - Fetches real-time weather for your destination
- **AI-generated descriptions** - Natural language weather summaries (e.g., "Paris, France is experiencing mild weather at 18°C with partly cloudy skies")
- **Visual weather** - DALL-E 3 generated images representing current weather conditions

## Technical Stack

- **Runtime**: Cloudflare Workers (serverless edge computing)
- **AI/ML**:
  - Vercel AI SDK for structured outputs and tool calling
  - OpenAI GPT-4 for intelligent travel planning
  - DALL-E 3 for weather visualization
- **APIs**: OpenWeather API for meteorological data
- **Type Safety**: TypeScript with Zod schema validation
- **Security**: CORS protection with configurable allowed origins

## Architecture

The worker uses AI tool calling to orchestrate multiple operations:

1. **Request Processing** - Accepts POST requests with travel parameters
2. **Parallel AI Execution** - Simultaneously generates:
   - Flight and hotel plans using structured output
   - Weather forecasts with AI-generated descriptions
   - Weather visualization images
3. **Response Formatting** - Returns structured JSON with complete travel data

### Structured Output Schema

The API uses Zod schemas to ensure type-safe, validated responses:
- Flight plans (airline, times, layovers, pricing)
- Hotel details (name, stars, room type, location, price)
- Travel summaries and recommendations
- Weather descriptions with temperature and conditions

## Features

✅ Real-time weather integration
✅ AI-powered itinerary generation
✅ Budget-conscious recommendations
✅ Multi-traveler support
✅ Trip type customization (business, leisure, adventure, etc.)
✅ CORS-protected API endpoints
✅ Edge-deployed for low latency worldwide

## Note

This project focuses on AI-powered travel planning demonstrations. Real booking API integration is out of scope - all flight and hotel data is AI-generated based on realistic pricing and availability patterns.