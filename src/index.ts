import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { createErrorResponse, fetchFromR2, getAllowedOrigins as origin, parseTransformations } from './utils';
import type { CloudflareEnv, HealthResponse } from './types';
import { cloudflareRateLimiter } from '@hono-rate-limiter/cloudflare';

/**
 * Worker R2 CDN - Image Delivery & Transformation Service
 * Optimized for Cloudflare Workers and R2 Storage.
 * This worker handles fetching images from R2, applying transformations,
 * and serving them with appropriate caching and security headers.
 */

// ==== Hono App Setup ====

/**
 * Initializes a new Hono application instance.
 * The `CloudflareEnv` type provides access to Cloudflare-specific bindings.
 */
const app = new Hono<CloudflareEnv>();

// ==== Middleware ====

/**
 * Centralized error handling for the application.
 * Catches any unhandled errors, logs them, and returns a standardized JSON error response.
 */
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return createErrorResponse(c, 'INTERNAL_ERROR', 'An unexpected error occurred', 500);
});

/**
 * Applies a set of important security headers to all responses.
 * These headers help mitigate common web vulnerabilities like XSS and clickjacking.
 */
app.use(
	'*',
	secureHeaders({
		xContentTypeOptions: 'nosniff',
		xFrameOptions: 'DENY',
		xXssProtection: '1; mode=block',
	}),
);

/**
 * Configures Cross-Origin Resource Sharing (CORS) for the CDN.
 * It dynamically allows origins based on environment variables for improved security.
 */
app.use(
	'*',
	cors({
		origin,
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Range', 'If-Range', 'If-None-Match'],
		exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
		maxAge: 86400, // Cache preflight response for 24 hours
		credentials: false,
	}),
);

/**
 * Minimalist request logger.
 * Outputs basic information about each incoming request to the console.
 */
app.use('*', logger());

/**
 * Implements rate limiting to protect the service from abuse.
 * It uses the client's IP address and a Cloudflare Rate Limiter binding.
 */
app.use(
	'*',
	cloudflareRateLimiter<CloudflareEnv>({
		rateLimitBinding: (c) => c.env.RATE_LIMITER,
		keyGenerator: (c) => (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || c.req.header('x-real-ip')) ?? '', // Method to generate custom identifiers for clients.
	}),
);

/**
 * Implements a cache-aside strategy using the Cloudflare Cache API.
 * It caches successful responses to reduce R2 reads and improve performance.
 */
app.use('/*', async (c, next) => {
	// Skip caching for the health check endpoint
	if (c.req.path === '/health') return next();

	try {
		const cache = caches.default;
		const url = new URL(c.req.url);

		// Create a cache key that respects Range and Accept-Encoding headers
		// to prevent serving incorrect cached content.
		const cacheKeyHeaders = new Headers();
		const range = c.req.header('range');
		const encoding = c.req.header('accept-encoding');

		if (range) cacheKeyHeaders.set('range', range);
		if (encoding) cacheKeyHeaders.set('accept-encoding', encoding);

		const cacheKey = new Request(url.toString(), { headers: cacheKeyHeaders });
		const cachedResponse = await cache.match(cacheKey);

		// If a cached response is found, return it immediately
		if (cachedResponse) {
			const response = new Response(cachedResponse.body, cachedResponse);
			response.headers.set('X-Cache-Status', 'HIT');
			return response;
		}

		// If not in cache, proceed to the next middleware/handler
		await next();

		// Cache the response only if it was successful (status 2xx)
		if (c.res?.ok) {
			const response = c.res.clone();
			response.headers.set('X-Cache-Status', 'MISS');

			// Asynchronously store the response in the cache without blocking the response to the client
			if (c.executionCtx) {
				c.executionCtx.waitUntil(
					cache.put(cacheKey, response.clone()).catch((error) => {
						console.error('Cache storage error:', error);
					}),
				);
			} else {
				// Fallback for synchronous storage if execution context is not available
				cache.put(cacheKey, response.clone()).catch((error) => {
					console.error('Cache storage error:', error);
				});
			}
		}
	} catch (error) {
		console.error('Cache middleware error:', error);
		// If an error occurs in the cache middleware, proceed without caching
		await next();
	}
});

// ==== Main Route ====

/**
 * Main route for handling all incoming asset requests.
 * It determines if the request is for an image or a static file and handles it accordingly.
 */
app.get('/*', async (c) => {
	try {
		const { pathname, searchParams } = new URL(c.req.url);
		const isHeadRequest = c.req.method === 'HEAD';
		const rangeHeader = c.req.header('range');

		// For images, parse transformation options from the URL query parameters
		const transformOptions = parseTransformations(pathname, searchParams);

		// Image transformations do not support Range requests.
		if (rangeHeader) {
			return createErrorResponse(c, 'RANGE_NOT_SUPPORTED', 'Range requests are not supported for image transformations', 400);
		}

		// Serve the transformed image
		return await fetchFromR2(pathname, transformOptions, c, isHeadRequest, rangeHeader);
	} catch (error) {
		console.error('Request handler error:', error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		return createErrorResponse(c, 'REQUEST_ERROR', errorMessage, 500);
	}
});

// ==== Health & Monitoring ====

/**
 * Health check endpoint for monitoring the worker's status.
 * Returns a JSON response with status, timestamp, and region information.
 * This endpoint is excluded from caching.
 */
app.get('/health', (c) => {
	const data: HealthResponse = {
		status: 'ok',
		timestamp: new Date().toISOString(),
		worker: 'wolfstar-cdn',
		region: c.req.header('cf-ray')?.split('-')[1], // Extract region from CF-Ray header
	};

	return c.json(data, 200, {
		'Cache-Control': 'no-store', // Ensure this response is never cached
		'X-Robots-Tag': 'noindex', // Prevent search engines from indexing this page
	});
});

// ==== 404 Handler ====

/**
 * Handles all requests that do not match any other route.
 * Returns a standardized 404 Not Found error response.
 */
app.notFound((c) => {
	return createErrorResponse(c, 'NOT_FOUND', 'The requested resource was not found', 404);
});

/**
 * Default export of the Hono app.
 * This is the entry point for the Cloudflare Worker.
 */
export default app;
