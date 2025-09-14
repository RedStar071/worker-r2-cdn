import type { Context } from 'hono';
import {
	ALLOWED_FIT_MODES,
	ALLOWED_FORMATS,
	DEFAULT_TRANSFORM_OPTIONS,
	IMAGE_EXTENSIONS,
	IMMUTABLE_CACHE_TTL,
	MAX_IMAGE_DIMENSION,
	MAX_QUALITY,
	MIN_IMAGE_DIMENSION,
	MIN_QUALITY,
} from './constants';
import type { CfImageFit, CfImageFormat, CfImageTransformOptions, CloudflareEnv, ErrorResponse } from './types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An improved type guard to check if an object is an R2ObjectBody.
 * @param obj - The object to check.
 * @returns True if the object is a valid R2ObjectBody.
 */
export function isR2ObjectBody(obj: unknown): obj is R2ObjectBody {
	return (
		obj !== null &&
		typeof obj === 'object' &&
		'body' in obj &&
		'size' in obj &&
		'httpEtag' in obj &&
		typeof (obj as Record<string, unknown>).size === 'number'
	);
}

/**
 * Creates a standardized JSON error response.
 * @param error - A short error code (e.g., 'NOT_FOUND').
 * @param message - A descriptive error message.
 * @param status - The HTTP status code for the response.
 * @returns A Response object containing the JSON error payload.
 */
export function createErrorResponse(
	c: Context<CloudflareEnv>,
	error: string,
	message: string,
	status: ContentfulStatusCode = 500,
): Response {
	const errorResponse: ErrorResponse = {
		error,
		message,
		timestamp: new Date().toISOString(),
	};

	return c.json(errorResponse, status, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store', // Ensure error responses are not cached
	});
}

/**
 * Extracts the file extension from a given path.
 * @param pathname - The path to the file.
 * @returns The file extension in lowercase, or an empty string if not found.
 */
export function getFileExtension(pathname: string): string {
	return pathname.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Normalizes a path to be used as an R2 object key.
 * Removes the leading slash if present.
 * @param pathname - The path to normalize.
 * @returns The normalized R2 object key.
 */
function normalizeObjectKey(pathname: string): string {
	return pathname.startsWith('/') ? pathname.slice(1) : pathname;
}

/**
 * Validates that an image dimension (width or height) is within the allowed range.
 * @param value - The dimension value to validate.
 * @returns True if the dimension is valid.
 */
function validateImageDimension(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_IMAGE_DIMENSION && value <= MAX_IMAGE_DIMENSION;
}

/**
 * Validates that an image quality value is within the allowed range.
 * @param value - The quality value to validate.
 * @returns True if the quality is valid.
 */
function validateImageQuality(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_QUALITY && value <= MAX_QUALITY;
}

/**
 * Parses and validates image transformation options from URL search parameters.
 * @param searchParams - The URLSearchParams object from the request.
 * @returns A validated CfImageTransformOptions object, or null if no transformation params are present.
 */
export function parseTransformations(pathname: string, searchParams: URLSearchParams): CfImageTransformOptions | null {
	// Check if any transformation parameters are present to avoid unnecessary processing
	const hasTransformationParams = ['w', 'h', 'q', 'fit', 'f'].some((p) => searchParams.has(p));

	// Determine if the requested file is an image based on its extension
	const fileExtension = getFileExtension(pathname);
	const isImage = IMAGE_EXTENSIONS.has(fileExtension);

	if (!hasTransformationParams || !isImage) return null;

	const options: CfImageTransformOptions = { ...DEFAULT_TRANSFORM_OPTIONS };

	// Validate and parse width
	const widthParam = searchParams.get('w');
	if (widthParam) {
		const width = parseInt(widthParam, 10);
		if (validateImageDimension(width)) {
			options.width = width;
		}
	}

	// Validate and parse height
	const heightParam = searchParams.get('h');
	if (heightParam) {
		const height = parseInt(heightParam, 10);
		if (validateImageDimension(height)) {
			options.height = height;
		}
	}

	// Validate and parse quality
	const qualityParam = searchParams.get('q');
	if (qualityParam) {
		const quality = parseInt(qualityParam, 10);
		if (validateImageQuality(quality)) {
			options.quality = quality;
		}
	}

	// Validate and parse fit mode
	const fitParam = searchParams.get('fit') as CfImageFit;
	if (fitParam && ALLOWED_FIT_MODES.has(fitParam)) {
		options.fit = fitParam;
	}

	// Validate and parse output format
	const formatParam = searchParams.get('f')?.toLowerCase() as CfImageFormat;
	if (formatParam && ALLOWED_FORMATS.has(formatParam)) {
		options.format = formatParam;
	} else if (formatParam) {
		// If an unsupported format is specifically requested, we return null to avoid transformation
		// This prevents unsupported formats like 'json' from being passed to Cloudflare's image service
		const hasOtherValidParams = ['w', 'h', 'q', 'fit'].some((p) => searchParams.has(p));
		if (!hasOtherValidParams) {
			// Only unsupported format requested, skip transformation entirely
			return null;
		}
		// Otherwise, proceed with transformation but ignore the invalid format
	}

	return options;
}

/**
 * Parses the HTTP Range header to extract byte range information.
 * @param rangeHeader - The value of the Range header (e.g., 'bytes=0-1023').
 * @returns An R2Range object or undefined if the header is invalid.
 */
export function parseRangeHeader(rangeHeader: string): R2Range | undefined {
	const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return undefined;

	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : undefined;

	if (Number.isNaN(start) || (end !== undefined && Number.isNaN(end))) return undefined;
	if (end !== undefined && start > end) return undefined; // Invalid range

	return {
		offset: start,
		length: end !== undefined ? end - start + 1 : undefined,
	};
}

// ==== R2 & CDN Functions ====

/**
 * Fetches an object from R2, with support for HEAD requests, Range requests,
 * and Cloudflare Image Transformations.
 * @param pathname - The path of the object to fetch.
 * @param cfOptions - Cloudflare Image Transformation options.
 * @param env - The Cloudflare environment bindings.
 * @param isHeadRequest - True if the request is a HEAD request.
 * @param rangeHeader - The value of the Range header, if present.
 * @returns A Response object containing the R2 object or its metadata.
 */
export async function fetchFromR2(
	pathname: string,
	cfOptions: CfImageTransformOptions | null = null,
	c: Context<CloudflareEnv>,
	isHeadRequest = false,
	rangeHeader?: string,
): Promise<Response> {
	const objectKey = normalizeObjectKey(pathname);
	const hasTransformations = cfOptions ? Object.keys(cfOptions).length > 0 : false;

	try {
		// Optimization for HEAD requests: use R2's head() method to get metadata without the body.
		if (isHeadRequest) {
			const headObj = await c.env.wolfstar_cdn.head(objectKey);
			if (!headObj) {
				return createErrorResponse(c, 'NOT_FOUND', 'Object not found in R2', 404);
			}

			const headers = new Headers();
			headObj.writeHttpMetadata(headers);
			headers.set('etag', headObj.httpEtag);
			headers.set('accept-ranges', 'bytes');
			headers.set('cache-control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);

			return new Response(null, { headers });
		}

		// Handle Range requests, but only for non-transformed files.
		let range: R2Range | undefined;
		if (rangeHeader && !hasTransformations) {
			range = parseRangeHeader(rangeHeader);
		}

		const options: R2GetOptions = {};
		if (range) options.range = range;

		// Fetch the object from R2
		const object = await c.env.wolfstar_cdn.get(objectKey, options);
		if (!isR2ObjectBody(object)) {
			return createErrorResponse(c, 'INCOMPLETE_OBJECT', 'Object not correct or incomplete', 404);
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('accept-ranges', 'bytes');
		headers.set('cache-control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);

		// Handle partial content responses for Range requests
		if (range && object.range) {
			let start: number;
			let end: number;

			// Determine the start and end of the range from the R2 response
			if ('offset' in object.range && 'length' in object.range) {
				start = object.range.offset ?? 0;
				const length = object.range.length ?? object.size - start;
				end = start + length - 1;
			} else if ('offset' in object.range) {
				start = object.range.offset ?? 0;
				end = object.size - 1;
			} else if ('suffix' in object.range) {
				start = object.size - (object.range.suffix ?? 0);
				end = object.size - 1;
			} else {
				// Unexpected case, fallback to a full response
				return new Response(object.body, { headers });
			}

			headers.set('content-range', `bytes ${start}-${end}/${object.size}`);

			return c.json(object.body, {
				status: 206, // Partial Content
				statusText: 'Partial Content',
				headers,
			});
		}

		// Return a normal response or a response with image transformations
		return c.json(
			object.body,
			cfOptions !== null
				? {
						headers,
						cf: { image: cfOptions },
					}
				: {
						headers,
					},
		);
	} catch (error) {
		console.error(`R2 error for object '${objectKey}':`, error);
		return createErrorResponse(c, 'STORAGE_ERROR', 'Unable to retrieve file from storage', 500);
	}
}

/**
 * Determines the allowed origins for CORS based on environment variables.
 * @param c - The Hono context.
 * @returns An array of allowed origin strings.
 */
export function getAllowedOrigins(_origin: string, c: Context<CloudflareEnv>): string | null {
	if (c.env.ALLOWED_ORIGINS) {
		// Split the comma-separated string and trim whitespace
		return c.env.ALLOWED_ORIGINS;
	}
	return null;
}
