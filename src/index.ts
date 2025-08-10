import { waitUntil } from "cloudflare:workers";
/**
 * Welcome to Cloudflare Workers!
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
/**
 * Welcome to Cloudflare Workers!
 *
 * This worker acts as an intelligent image resizing proxy.
 * It fetches original images from an R2 bucket, applies transformations
 * using Cloudflare Image Resizing based on URL query parameters,
 * and caches the results efficiently using the Cache API.
 */

// --- Type Definitions for Clarity and Type Safety ---

/**
 * Cloudflare Image Resizing options for the 'fit' parameter.
 */
type CfImageFit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';

/**
 * Supported output image formats.
 */
type CfImageFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'json';

/**
 * Interface for the object passed to the `cf.image` property for transformations.
 */
interface CfImageTransformOptions {
	width?: number;
	height?: number;
	quality?: number;
	fit?: CfImageFit;
	format?: CfImageFormat;
}

/**
 * Defines the environment variables expected by the worker.
 * Regenerate with `npm run cf-typegen` after updating wrangler.jsonc.
 */

// --- Constants for Configuration and Maintainability ---

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tiff', 'avif']);
const ALLOWED_FIT_MODES = new Set<CfImageFit>(['scale-down', 'contain', 'cover', 'crop', 'pad']);
const ALLOWED_FORMATS = new Set<CfImageFormat>(['webp', 'avif', 'jpeg', 'png', 'json']);
const CORS_MAX_AGE = '86400'; // 24 hours
const IMMUTABLE_CACHE_TTL = 31536000; // 1 year
const DEFAULT_CACHE_TTL = 86400; // 1 day

const DEFAULT_TRANSFORM_OPTIONS: Readonly<Partial<CfImageTransformOptions>> = {
	quality: 85
};

// --- Main Worker Handler ---

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		// Handle CORS preflight requests first
		if (request.method === 'OPTIONS') {
			return handleCorsPreflight(env);
		}

		const cache = caches.default;
		const cachedResponse = await cache.match(request);

		if (cachedResponse) {
			console.log(`Cache HIT for: ${request.url}`);
			// Return a new response with our custom cache header
			return createResponseWithHeaders(cachedResponse, { 'X-Cache-Status': 'HIT' });
		}

		console.log(`Cache MISS for: ${request.url}`);

		try {
			const originalResponse = await handleRequest(request, env);
			const response = createResponseWithHeaders(originalResponse, { 'X-Cache-Status': 'MISS' });

			// Asynchronously cache the successful response
			waitUntil(cache.put(request, response.clone()));

			return response;
		} catch (error) {
			console.error('Worker error:', error);
			const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
			return new Response(`Internal Server Error: ${errorMessage}`, {
				status: 500,
				headers: getCorsHeaders(env),
			});
		}
	},
} satisfies ExportedHandler<Env>;

// --- Helper Functions for Modularity and Readability ---

/**
 * Handles the main request logic after a cache miss.
 */
async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const { pathname, searchParams } = url;

	if (!env.R2_PUBLIC_URL) {
		throw new Error('R2_PUBLIC_URL environment variable is not configured.');
	}

	const fileExtension = pathname.split('.').pop()?.toLowerCase() ?? '';
	const isImage = IMAGE_EXTENSIONS.has(fileExtension);

	if (!isImage) {
		return serveStaticFile(pathname, env);
	}

	const transformOptions = parseTransformations(searchParams);
	const hasTransformations = Object.keys(transformOptions).length > 0;

	if (!hasTransformations) {
		return serveOriginalImage(pathname, env);
	}

	return serveTransformedImage(pathname, transformOptions, env);
}

/**
 * Parses and validates image transformation parameters from the URL.
 */
function parseTransformations(searchParams: URLSearchParams): CfImageTransformOptions {
	const hasTransformationParams = ['w', 'h', 'q', 'fit', 'f'].some((p) => searchParams.has(p));
	if (!hasTransformationParams) {
		return {};
	}

	const options: CfImageTransformOptions = { ...DEFAULT_TRANSFORM_OPTIONS };

	const widthParam = searchParams.get('w');
	if (widthParam) {
		const width = parseInt(widthParam, 10);
		if (!isNaN(width) && width > 0) {
			options.width = width;
		}
	}

	const heightParam = searchParams.get('h');
	if (heightParam) {
		const height = parseInt(heightParam, 10);
		if (!isNaN(height) && height > 0) {
			options.height = height;
		}
	}

	const qualityParam = searchParams.get('q');
	if (qualityParam) {
		const quality = parseInt(qualityParam, 10);
		if (!isNaN(quality) && quality > 0 && quality <= 100) {
			options.quality = quality;
		}
	}

	const fitParam = searchParams.get('fit') as CfImageFit;
	if (fitParam && ALLOWED_FIT_MODES.has(fitParam)) {
		options.fit = fitParam;
	}

	const formatParam = searchParams.get('f')?.toLowerCase() as CfImageFormat;
	if (formatParam && ALLOWED_FORMATS.has(formatParam)) {
		options.format = formatParam;
	}

	return options;
}

/**
 * Fetches and serves a non-image file directly from R2.
 */
async function serveStaticFile(pathname: string, env: Env): Promise<Response> {
	const objectKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;
	const object = await env.wolfstar_cdn.get(objectKey);

	if (object === null) {
		console.error(`Object not found in R2 bucket. Key: ${objectKey}`);
		return new Response(`Object Not Found: ${objectKey}`, { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Cache-Control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);
	headers.set('Vary', 'Accept'); // Important for content negotiation
	appendCorsHeaders(headers, env);

	return new Response(object.body, {
		headers,
	});
}

/**
 * Serves the original image without any transformations.
 */
async function serveOriginalImage(pathname: string, env: Env): Promise<Response> {
	return fetchFromR2(pathname, {}, env);
}

/**
 * Serves a transformed image using Cloudflare Image Resizing.
 * Includes fallback to the original image if transformation fails.
 */
async function serveTransformedImage(pathname: string, options: CfImageTransformOptions, env: Env): Promise<Response> {
	console.log('Applying transform options:', JSON.stringify(options));

	const transformedResponse = await fetchFromR2(pathname, options, env);

	if (transformedResponse.ok) {
		return createResponseWithHeaders(transformedResponse, { 'X-Transform-Status': 'success' });
	}

	// Fallback: If transformation fails, serve the original image.
	console.warn(`Image transformation failed with status ${transformedResponse.status}. Falling back to original.`);
	const fallbackResponse = await fetchFromR2(pathname, {}, env);
	return createResponseWithHeaders(fallbackResponse, { 'X-Transform-Status': 'fallback-original' });
}

/**
 * Generic function to fetch an image from R2, optionally applying transformations.
 */
async function fetchFromR2(pathname: string, cfOptions: CfImageTransformOptions, env: Env): Promise<Response> {
	const objectKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;

	// First, check if the object exists using the R2 binding for efficiency.
	const head = await env.wolfstar_cdn.head(objectKey);
	if (head === null) {
		console.error(`Object head not found in R2 bucket. Key: ${objectKey}`);
		return new Response(`Object Not Found: ${objectKey}`, { status: 404 });
	}

	// If the object exists, use the public URL with fetch to apply transformations.
	const r2Url = getR2Url(pathname, env);
	const r2Response = await fetch(r2Url, { cf: { image: cfOptions } });

	if (!r2Response.ok) {
		// This might still happen for other reasons (e.g., permissions), but we've already handled 404s.
		return r2Response;
	}

	const headers = new Headers(r2Response.headers);
	headers.set('Cache-Control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);
	headers.set('Vary', 'Accept'); // Important for content negotiation
	head.writeHttpMetadata(headers);
	headers.set("etag", head.httpEtag);
	appendCorsHeaders(headers, env);

	return new Response(r2Response.body, {
		status: r2Response.status,
		statusText: r2Response.statusText,
		headers,
	});
}

/**
 * Constructs the full public URL for an R2 object.
 */
function getR2Url(pathname: string, env: Env): string {
	// R2 public URL doesn't need a leading slash on the object key
	const objectKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;
	return `${env.R2_PUBLIC_URL}/${objectKey}`;
}

/**
 * Returns a response for CORS preflight (OPTIONS) requests.
 */
function handleCorsPreflight(env: Env): Response {
	return new Response(null, {
		status: 204, // No Content
		headers: getCorsHeaders(env),
	});
}

/**
 * Returns an object with the appropriate CORS headers.
 */
function getCorsHeaders(env: Env): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': CORS_MAX_AGE,
	};
}

/**
 * Appends CORS headers to an existing Headers object.
 */
function appendCorsHeaders(headers: Headers, env: Env): void {
	const cors = getCorsHeaders(env);
	for (const key in cors) {
		headers.set(key, cors[key]);
	}
}

/**
 * Creates a new Response with additional or overwritten headers.
 * @param response The original response.
 * @param newHeaders An object of headers to add or overwrite.
 * @returns A new Response object with the modified headers.
 */
function createResponseWithHeaders(response: Response, newHeaders: Record<string, string>): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(newHeaders)) {
		headers.set(key, value);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}


