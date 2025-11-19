import OpenAI from 'openai';

function corsHeaders(origin: string | null, env): Record<string, string> {
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

const getAllowedOrigins = (env): string[] => {
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

const generateLogisticsPlanBasedOnUserInputToolCall = async (openai: OpenAI, userInput: string) => {
	const messages = [
		{
			role: 'system',
			content: `You are a travel agent expert and your job is give the best flight and hotel information available in a particular city. 
		The user will give you an origin and a destination, date of travel and date of return. 
		Also the user will give a budget and the number of people travelling.
		When searching for flights, suggest only one flight and a layover if it is part of the journey. 
		If no direct flight is possible go for it, otherwise find a layover. 
		You can mention economy seats available on that flight. 
		Mention the price of the flight to and from the origin. 
		This doesnt have to be a real life price but something within the budget of and number of people travelling specified by the user.
		
		When searching for hotels, suggest only one 4 star 5 star hotel in the city. 
		Mention the price of the hotel using the flight date to and from the origin. 
		This doesnt have to be a real life price but something within the budget and number of people travelling specified by the user.
		If the budget is too little based on flight and hotel prices then tell the user "You may need to revise your budget"
		For flights, consider cheapest flights and shortest layovers possible.
		Mention 3 activities that can be done near or at the hotel based on the trip type. 
		Place the value into an array of strings. Generate an emoji for each activity.
		"activitiesToDo": ["...", "...", "..."]
		Format the response like so: 

		{
		"flightPlan": {...},
		"flightRecommendation: "",
		"hotelPlan": {...}, 
		"hotelRecommendation: "",
		"totalEstimatedCost": "",
		"conclusion": "",
		"activitiesToDo": ["...", "...", "..."]
		}

		The "flightRecommendation" is a brief short phrase of the flight, price and any layover if applicable e.g. 
		"The best option for you is with Delta Airlines with a layover in Oslo priced at $1200"
		The "hotelRecommendation" is a brief short phrase of the hotel, star level, room type and price e.g. "We recommend you stay at the 4 star Premiere Inn hotel in central Paris, priced at $800"
		The "conclusion" is whether the price of the hotel and budget fall within the budget of the user
	`,
		},
		{
			role: 'user',
			content: `User input: ${userInput}`,
		},
	];

	const response = await openai.chat.completions.create({
		model: 'gpt-4-turbo',
		messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
	});

	return response.choices[0].message.content;
};

const getCurrentWeather = async (destination: string, env: Env, openai: OpenAI) => {
	// get destination weather starting with coordinates
	const response = await fetch(`http://api.openweathermap.org/geo/1.0/direct?q=${destination}&limit=1&appid=${env.OPENWEATHER_API_KEY}`);
	const data = (await response.json()) as { lat: string; lon: string }[];

	const latitude = parseFloat(data[0].lat);
	const longitude = parseFloat(data[0].lon);

	const weatherResponse = await fetch(
		`https://api.openweathermap.org/data/3.0/onecall?lat=${latitude}&lon=${longitude}&units=metric&appid=${env.OPENWEATHER_API_KEY}`
	);
	const weatherData = (await weatherResponse.json()) as {
		hourly: any;
		minutely: any;
		daily: any;
		current: { weather: { description: string }[] };
	};
	delete weatherData.hourly;
	delete weatherData.minutely;
	delete weatherData.daily;

	const messages = [
		{
			role: 'system',
			content: `You are a weather assistant tool. You will be given a weather data from a json response from the OpenWeather API. 
			The data has current weather data about a location in the timezone property. 
			Respond with a short 30 word paragraph describing the weather based on that information.
			When mentioning a city use the city name and the country name e.g. "Paris, France". 
			Use the ${destination} variable to get the city name and the country name.
			DONT USE THE timezone property to get the city name and the country name.`,
		},
		{
			role: 'user',
			content: `Weather data: ${JSON.stringify(weatherData)}`,
		},
	];

	const finalWeatherDetails = {
		description: '',
		imageUrl: '',
	};
	try {
		const weatherAtDestinationResponse = await openai.chat.completions.create({
			model: 'gpt-4-turbo',
			messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
		});

		finalWeatherDetails.description = weatherAtDestinationResponse.choices[0].message.content || '';
	} catch (error) {
		console.error(error, 'ERROR GETTING WEATHER DESCRIPTION AT DESTINATION');
		return finalWeatherDetails;
	}

	try {
		const image = await openai.images.generate({
			model: 'dall-e-3', // dall-e-3 only supports 1024x1024
			prompt: `Generate an image based on the weather description given: ${weatherData.current.weather[0].description}.`,
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

		const availableFunctionMap = {
			getCurrentWeather: getCurrentWeather,
			generateLogisticsPlanBasedOnUserInputToolCall: generateLogisticsPlanBasedOnUserInputToolCall,
		};

		const openai = new OpenAI({
			apiKey: env.OPENAI_API_KEY,
			baseURL: env.CLOUDFLARE_GATEWAY_URL,
		});

		const piecesOfInformationToCycleThrough = [
			{
				role: 'user',
				content: `I am travelling to ${destination} on ${requestBody.fromDate} and returning on ${requestBody.toDate}. 
				I am flying from ${requestBody.flyingFrom}. 
				I am travelling with ${requestBody.travelers} people. 
				My budget is $${requestBody.budget}.
				The travelling on a ${requestBody.tripType} trip.
				Answer these 2 questions:
				1. What is the best flight and hotel options for me? 
				2. What is the current weather in ${destination}?`,
			},
		];

		let finalResponse = {
			logisticsPlanRecommendation: null as string | null,
			currentWeather: null as string | null,
			currentWeatherImageUrl: null as string | null,
			failureReason: null as string | null,
		};

		for (const pieceOfInformation of piecesOfInformationToCycleThrough) {
			const travelAgentChatMessages = [
				{
					role: 'system',
					content: `You are a helpful AI agent. 
						Give highly specific answers based on the information you're provided. 
						Prefer to gather information with the tools provided to you rather than giving basic, generic answers.
						There are 2 questions need to be answered. Ensure you answer both questions.
						`,
				},
				pieceOfInformation,
			];

			const response = await openai.chat.completions.create({
				model: 'gpt-4-turbo',
				messages: travelAgentChatMessages as OpenAI.Chat.ChatCompletionMessageParam[],
				tools: [
					{
						type: 'function',
						function: {
							name: 'generateLogisticsPlanBasedOnUserInputToolCall',
							description: 'Generate a logistics plan based on user input',
							parameters: {
								type: 'object',
								properties: {
									openai: { type: 'object', description: 'The OpenAI instance' },
									requestBody: { type: 'string', description: "The user's travel details query" },
								},
								required: ['openai', 'requestBody'],
							},
						},
					},
					{
						type: 'function',
						function: {
							name: 'getCurrentWeather',
							description: 'Get the current weather',
							parameters: {
								type: 'object',
								properties: {
									destination: { type: 'string', description: 'The destination' },
									env: { type: 'object', description: 'The environment to get access to the OpenWeather API KEY' },
									openai: { type: 'object', description: 'The OpenAI instance' },
								},
								required: ['destination', 'env', 'openai'],
							},
						},
					},
				],
			});

			const { finish_reason: finishReason, message } = response.choices[0];
			const { tool_calls: toolCalls } = message;

			if (finishReason === 'stop') {
				console.log(message.content);
				console.log('AGENT ENDING');
				finalResponse = {
					...finalResponse,
					failureReason: { content: message.content, reason: finishReason },
				};
				// break out of the loop, if something happens that is not expected
				break;
			} else if (finishReason === 'tool_calls') {
				for (const toolCall of toolCalls) {
					console.log(toolCall, 'TOOL CALL');
					// This is specific. However, a more generic solution would be to use the toolCall.function.name to call the appropriate function from the availableFunctionMap
					if (toolCall.function.name === 'generateLogisticsPlanBasedOnUserInputToolCall') {
						try {
							console.log('GENERATING LOGISTICS PLAN RECOMMENDATION');
							const logisticsPlanRecommendation = await availableFunctionMap.generateLogisticsPlanBasedOnUserInputToolCall(
								openai,
								JSON.stringify(requestBody)
							);
							console.log(logisticsPlanRecommendation, 'LOGISTICS PLAN RECOMMENDATION');
							finalResponse.logisticsPlanRecommendation = logisticsPlanRecommendation;
							travelAgentChatMessages.push({
								role: 'tool',
								content: `The best flight and hotel options for you are: ${logisticsPlanRecommendation}`,
							});
						} catch (error) {
							console.error(error, 'ERROR GENERATING LOGISTICS PLAN RECOMMENDATION');
							finalResponse.failureReason = `Error generating logistics plan recommendation: ${error.message}`;
							break;
						}
					}

					if (toolCall.function.name === 'getCurrentWeather') {
						try {
							console.log('GETTING CURRENT WEATHER');
							const currentWeather = await availableFunctionMap.getCurrentWeather(destination, env, openai);
							console.log(currentWeather, 'CURRENT WEATHER');
							finalResponse.currentWeather = currentWeather.description;
							finalResponse.currentWeatherImageUrl = currentWeather.imageUrl;

							travelAgentChatMessages.push({
								role: 'tool',
								content: `The current weather in ${destination} is: ${currentWeather.description}. The image url is: ${currentWeather.imageUrl}`,
							});
						} catch (error) {
							console.error(error, 'ERROR GETTING CURRENT WEATHER');
							finalResponse.failureReason = `Error getting current weather: ${error.message}`;
							break;
						}
					}
				}
			}
		}

		return new Response(JSON.stringify({ done: true, response: finalResponse }), {
			headers: { ...allowedHeaders },
			status: 200,
		});
	},
} satisfies ExportedHandler<Env>;
