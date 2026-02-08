import OpenAI from 'openai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output, stepCountIs } from 'ai';

// ============================================
// Environment Types
// ============================================

interface Env {
	OPENAI_API_KEY: string;
	CLOUDFLARE_GATEWAY_URL: string;
	OPENWEATHER_API_KEY: string;
	ALLOWED_ORIGINS: string;
}

// ============================================
// Zod Schemas for Structured Output
// ============================================

const flightPlanSchema = z.object({
	airline: z.string().describe('The airline name'),
	//flightNumber: z.string().optional().describe('Flight number if available'),
	departure: z.string().describe('Departure time and date'),
	arrival: z.string().describe('Arrival time and date'),
	layover: z.string().describe('Layover city or "Direct flight" if applicable'),
	//seatsAvailable: z.number().optional().describe('Number of economy seats available'),
	price: z.number().describe('Total price for all travelers'),
});

const hotelPlanSchema = z.object({
	name: z.string().describe('Hotel name'),
	stars: z.number().min(4).max(5).describe('Star rating (4 or 5)'),
	roomType: z.string().describe('Type of room'),
	price: z.number().describe('Total price for the stay'),
	location: z.string().describe('Hotel location in the city'),
});

const travelPlanSchema = z.object({
	flightPlan: flightPlanSchema,
	flightRecommendation: z
		.string()
		.describe('Brief phrase about the flight, price, and layover'),
	hotelPlan: hotelPlanSchema,
	hotelRecommendation: z
		.string()
		.describe('Brief phrase about the hotel, star level, room type, and price'),
	totalEstimatedCost: z.number().describe('Total cost of flight + hotel'),
	conclusion: z
		.string()
		.describe('Whether the plan fits within budget or if revision is needed'),
	activitiesToDo: z
		.array(z.string())
		.length(3)
		.describe('3 activities with emojis based on trip type'),
});

const weatherDescriptionSchema = z.object({
	description: z
		.string()
		.max(150)
		.describe('A 30-word paragraph describing the current weather'),
	temperature: z.string().describe('Current temperature with unit'),
	conditions: z.string().describe('Brief weather conditions'),
});

// Type exports for use throughout the app
export type FlightPlan = z.infer<typeof flightPlanSchema>;
export type HotelPlan = z.infer<typeof hotelPlanSchema>;
export type TravelPlan = z.infer<typeof travelPlanSchema>;
export type WeatherDescription = z.infer<typeof weatherDescriptionSchema>;

// ============================================
// CORS Setup
// ============================================

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
	const allowedOrigins = getAllowedOrigins(env);
	const isAllowed = isOriginAllowed(origin, allowedOrigins);

	return {
		'Access-Control-Allow-Origin': isAllowed && origin ? origin : '',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Allow-Credentials': 'true',
		'Content-Type': 'application/json',
	};
}

const getAllowedOrigins = (env: Env): string[] => {
	if (!env.ALLOWED_ORIGINS) {
		// Fallback for local development if not set
		return ['http://localhost:5173'];
	}
	return env.ALLOWED_ORIGINS.split(',').map((origin: string) => origin.trim());
};

const isOriginAllowed = (origin: string | null, allowedOrigins: string[]): boolean => {
	if (!origin) return false;
	return allowedOrigins.includes(origin);
};

const generateLogisticsPlanBasedOnUserInputToolCall = async (
	apiKey: string,
	baseURL: string,
	userInput: string
): Promise<TravelPlan> => {
	// Parse the user input to extract travel details
	const parsedInput = JSON.parse(userInput);

	// Create OpenAI client for Vercel AI SDK
	const openai = createOpenAI({
		apiKey,
		baseURL,
	});

	// Use generateText with Output.object for structured output with type safety
	const { output } = await generateText({
		model: openai('gpt-4o'),
		output: Output.object({
			schema: travelPlanSchema,
		}),
		prompt: `You are a travel agent expert. Generate the best flight and hotel plan for this trip:

Origin: ${parsedInput.flyingFrom}
Destination: ${parsedInput.destination}
Travel dates: ${parsedInput.fromDate} to ${parsedInput.toDate}
Travelers: ${parsedInput.travelers}
Budget: $${parsedInput.budget}
Trip type: ${parsedInput.tripType}

Guidelines:
- Suggest ONE flight (direct or with layover - prefer shortest layover and cheapest option)
- Suggest ONE 4-5 star hotel in the destination city
- All prices should be realistic and fit within the budget for all travelers
- If budget is too low, state "You may need to revise your budget" in conclusion
- Include 3 activities with emojis relevant to the ${parsedInput.tripType} trip type
- Consider economy seats for the flight
- Prices don't need to be real but should be realistic for the budget and number of travelers

For flightRecommendation, use format like: "The best option for you is with Delta Airlines with a layover in Oslo priced at $1200"
For hotelRecommendation, use format like: "We recommend you stay at the 4 star Premiere Inn hotel in central Paris, priced at $800"`,
	});

	return output;
};

const getCurrentWeather = async (destination: string, env: Env, apiKey: string, baseURL: string) => {
	// Get destination coordinates
	const geoResponse = await fetch(
		`http://api.openweathermap.org/geo/1.0/direct?q=${destination}&limit=1&appid=${env.OPENWEATHER_API_KEY}`
	);
	const geoData = (await geoResponse.json()) as { lat: string; lon: string }[];

	const latitude = parseFloat(geoData[0].lat);
	const longitude = parseFloat(geoData[0].lon);

	// Get weather data
	const weatherResponse = await fetch(
		`https://api.openweathermap.org/data/3.0/onecall?lat=${latitude}&lon=${longitude}&units=metric&appid=${env.OPENWEATHER_API_KEY}`
	);
	const weatherData = (await weatherResponse.json()) as {
		hourly: any;
		minutely: any;
		daily: any;
		current: {
			temp: number;
			weather: { description: string; main: string }[];
		};
		timezone: string;
	};

	// Create OpenAI client for Vercel AI SDK
	const openai = createOpenAI({
		apiKey,
		baseURL,
	});

	const finalWeatherDetails = {
		description: '',
		temperature: '',
		conditions: '',
		imageUrl: '',
	};

	// Generate structured weather description using Vercel AI SDK
	try {
		const { output } = await generateText({
			model: openai('gpt-4o'),
			output: Output.object({
				schema: weatherDescriptionSchema,
			}),
			prompt: `Describe the current weather in ${destination} based on this data:
Temperature: ${weatherData.current.temp}°C
Conditions: ${weatherData.current.weather[0].description}
Weather Type: ${weatherData.current.weather[0].main}

Write a natural 30-word paragraph mentioning the city and country (e.g., "Paris, France").
Do NOT use the timezone property for the city name.`,
		});

		finalWeatherDetails.description = output.description;
		finalWeatherDetails.temperature = output.temperature;
		finalWeatherDetails.conditions = output.conditions;
	} catch (error) {
		console.error(error, 'ERROR GETTING WEATHER DESCRIPTION AT DESTINATION');
		return finalWeatherDetails;
	}

	// Generate weather image using OpenAI SDK (DALL-E)
	try {
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
	} catch (error) {
		console.error(error, 'ERROR GENERATING IMAGE FOR WEATHER DESCRIPTION AT DESTINATION');
		return finalWeatherDetails;
	}

	return finalWeatherDetails;
};

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { headers } = request;
		const origin = headers.get('origin');
		const allowedOrigins = getAllowedOrigins(env);
		const allowedHeaders = corsHeaders(origin, env);

		// Handle OPTIONS preflight request
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: { ...allowedHeaders },
			});
		}

		// Validate origin before processing
		if (!isOriginAllowed(origin, allowedOrigins)) {
			return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
				status: 403,
				headers: { ...allowedHeaders },
			});
		}

		if (request.method !== 'POST') {
			return new Response(JSON.stringify({ error: `Method ${request.method} not allowed` }), {
				status: 405,
				headers: { ...allowedHeaders },
			});
		}

		const requestBody = (await request.json()) as {
			destination: string;
			flyingFrom: string;
			fromDate: string;
			toDate: string;
			budget: number;
			travelers: number;
			tripType: string;
		};

		const destination = requestBody.destination;

		// Create OpenAI client for Vercel AI SDK
		const openai = createOpenAI({
			apiKey: env.OPENAI_API_KEY,
			baseURL: env.CLOUDFLARE_GATEWAY_URL,
		});

		const finalResponse = {
			logisticsPlanRecommendation: null as any,
			currentWeather: null as string | null,
			currentWeatherImageUrl: null as string | null,
			failureReason: null as string | null,
		};

		try {
			// Use Vercel AI SDK's built-in tool calling with generateText
			const result = await generateText({
				model: openai('gpt-4o'),
				system: `You are a helpful AI travel agent. 
Give highly specific answers based on the information you're provided.
You MUST use the available tools to answer questions.
DO NOT make up information - always call the tools to get real data.
Prefer to gather information with the tools provided to you rather than giving basic, generic answers.
There are 2 questions that need to be answered. Ensure you answer both questions using the available tools.`,
				prompt: `I am travelling to ${destination} on ${requestBody.fromDate} and returning on ${requestBody.toDate}. 
I am flying from ${requestBody.flyingFrom}. 
I am travelling with ${requestBody.travelers} people. 
My budget is $${requestBody.budget}.
The trip is a ${requestBody.tripType} trip.

Answer these 2 questions:
1. What is the best flight and hotel options for me?
2. What is the current weather in ${destination}?`,
				tools: {
					generateLogisticsPlan: {
						description: 'Generate a complete travel logistics plan with flights and hotels based on user requirements',
						inputSchema: z.object({
							// Let AI extract these from the prompt
							destination: z.string(),
							flyingFrom: z.string(),
							fromDate: z.string(),
							toDate: z.string(),
							budget: z.number(),
							travelers: z.number(),
							tripType: z.string(),
						  }),
						execute: async ({ destination, flyingFrom, fromDate, toDate, budget, travelers, tripType }) => {
							console.log('GENERATING LOGISTICS PLAN');
							return await generateLogisticsPlanBasedOnUserInputToolCall(
								env.OPENAI_API_KEY,
								env.CLOUDFLARE_GATEWAY_URL,
								JSON.stringify({
									destination,
									flyingFrom,
									fromDate,
									toDate,
									budget,
									travelers,
									tripType,
								}
							));
						},
					},
					getCurrentWeather: {
						description: 'Get the current weather conditions for a destination city',
						inputSchema: z.object({
							destination: z.string().describe('The destination city name'),
						}),
						execute: async ({ destination }) => {
							console.log('GETTING CURRENT WEATHER');
							return await getCurrentWeather(destination, env, env.OPENAI_API_KEY, env.CLOUDFLARE_GATEWAY_URL);
						},
					},
				},
				//stopWhen: stepCountIs(3), // going to observe this and see if it's needed for this specific use case
				toolChoice: 'required',
			});

			console.log('AI Response:', result.text);

			// Extract results from tool results
			for (const toolResult of result.toolResults) {
				console.log('Tool executed:', toolResult.toolName);

				if (toolResult.toolName === 'generateLogisticsPlan') {
					finalResponse.logisticsPlanRecommendation = JSON.stringify(toolResult.output);
					console.log('LOGISTICS PLAN:', toolResult.output);
				}

				if (toolResult.toolName === 'getCurrentWeather') {
					const weatherResult = toolResult.output as any;
					finalResponse.currentWeather = weatherResult.description;
					finalResponse.currentWeatherImageUrl = weatherResult.imageUrl;
					console.log('CURRENT WEATHER:', weatherResult);
				}
			}
		} catch (error) {
			console.error('ERROR:', error);
			finalResponse.failureReason = `Error: ${(error as Error).message}`;
		}

		return new Response(JSON.stringify({ done: true, response: finalResponse }), {
			headers: { ...allowedHeaders },
			status: 200,
		});
	},
} satisfies ExportedHandler<Env>;
