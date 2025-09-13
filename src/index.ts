import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { compress } from 'hono/compress';

/**
 * Wolfstar CDN - Image Delivery & Transformation Service
 * Ottimizzato per Cloudflare Workers e R2
 */

// ==== Definizioni di Tipo ====

interface Env {
	wolfstar_cdn: R2Bucket;
	RATE_LIMITER?: RateLimit;
	ALLOWED_ORIGINS?: string;
}

// Tipi per trasformazione immagini
type CfImageFit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
type CfImageFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'json';

interface CfImageTransformOptions {
	width?: number;
	height?: number;
	quality?: number;
	fit?: CfImageFit;
	format?: CfImageFormat;
}

// Tipi di risposta personalizzati
interface HealthResponse {
	status: string;
	timestamp: string;
	worker: string;
	region?: string;
}

interface ErrorResponse {
	error: string;
	message: string;
	timestamp: string;
}

// ==== Costanti ====

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tiff', 'avif']);
const ALLOWED_FIT_MODES = new Set<CfImageFit>(['scale-down', 'contain', 'cover', 'crop', 'pad']);
const ALLOWED_FORMATS = new Set<CfImageFormat>(['webp', 'avif', 'jpeg', 'png', 'json']);
const IMMUTABLE_CACHE_TTL = 31536000; // 1 anno (in secondi)

// Limiti per prevenire abusi
const MAX_IMAGE_DIMENSION = 4096;
const MIN_IMAGE_DIMENSION = 1;
const MAX_QUALITY = 100;
const MIN_QUALITY = 1;

const DEFAULT_TRANSFORM_OPTIONS: Readonly<Partial<CfImageTransformOptions>> = {
	quality: 85,
};

const DEFAULT_ALLOWED_ORIGINS = ['https://*.wolfstar.it', 'https://wolfstar.it'];

// ==== Helper Functions ====

/**
 * Type guard migliorato per R2ObjectBody
 */
function isR2ObjectBody(obj: unknown): obj is R2ObjectBody {
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
 * Crea una risposta di errore standardizzata
 */
function createErrorResponse(error: string, message: string, status = 500): Response {
	const errorResponse: ErrorResponse = {
		error,
		message,
		timestamp: new Date().toISOString(),
	};

	return new Response(JSON.stringify(errorResponse), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		},
	});
}

/**
 * Estrae l'estensione del file dal percorso
 */
function getFileExtension(pathname: string): string {
	return pathname.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Normalizza il percorso per R2
 */
function normalizeObjectKey(pathname: string): string {
	return pathname.startsWith('/') ? pathname.slice(1) : pathname;
}

/**
 * Valida le dimensioni delle immagini
 */
function validateImageDimension(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_IMAGE_DIMENSION && value <= MAX_IMAGE_DIMENSION;
}

/**
 * Valida la qualità dell'immagine
 */
function validateImageQuality(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_QUALITY && value <= MAX_QUALITY;
}

/**
 * Analizza le trasformazioni dalle query params con validazione rigorosa
 */
function parseTransformations(searchParams: URLSearchParams): CfImageTransformOptions {
	const hasTransformationParams = ['w', 'h', 'q', 'fit', 'f'].some((p) => searchParams.has(p));
	if (!hasTransformationParams) return {};

	const options: CfImageTransformOptions = { ...DEFAULT_TRANSFORM_OPTIONS };

	// Larghezza con validazione
	const widthParam = searchParams.get('w');
	if (widthParam) {
		const width = parseInt(widthParam, 10);
		if (validateImageDimension(width)) {
			options.width = width;
		}
	}

	// Altezza con validazione
	const heightParam = searchParams.get('h');
	if (heightParam) {
		const height = parseInt(heightParam, 10);
		if (validateImageDimension(height)) {
			options.height = height;
		}
	}

	// Qualità con validazione
	const qualityParam = searchParams.get('q');
	if (qualityParam) {
		const quality = parseInt(qualityParam, 10);
		if (validateImageQuality(quality)) {
			options.quality = quality;
		}
	}

	// Modalità di adattamento
	const fitParam = searchParams.get('fit') as CfImageFit;
	if (fitParam && ALLOWED_FIT_MODES.has(fitParam)) {
		options.fit = fitParam;
	}

	// Formato output
	const formatParam = searchParams.get('f')?.toLowerCase() as CfImageFormat;
	if (formatParam && ALLOWED_FORMATS.has(formatParam)) {
		options.format = formatParam;
	}

	return options;
}

/**
 * Analizza l'header Range
 */
function parseRangeHeader(rangeHeader: string): R2Range | undefined {
	const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return undefined;

	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : undefined;

	if (isNaN(start) || (end !== undefined && isNaN(end))) return undefined;
	if (end !== undefined && start > end) return undefined;

	return {
		offset: start,
		length: end !== undefined ? end - start + 1 : undefined,
	};
}

// ==== Funzioni R2 e CDN ====

/**
 * Recupera un oggetto da R2, con supporto per HEAD e Range requests
 */
async function fetchFromR2(
	pathname: string,
	cfOptions: CfImageTransformOptions,
	env: Env,
	isHeadRequest = false,
	rangeHeader?: string,
): Promise<Response> {
	const objectKey = normalizeObjectKey(pathname);
	const hasTransformations = Object.keys(cfOptions).length > 0;

	try {
		// Ottimizzazione per HEAD requests
		if (isHeadRequest) {
			const headObj = await env.wolfstar_cdn.head(objectKey);
			if (!headObj) {
				return new Response('Not Found', { status: 404 });
			}

			const headers = new Headers();
			headObj.writeHttpMetadata(headers);
			headers.set('etag', headObj.httpEtag);
			headers.set('accept-ranges', 'bytes');
			headers.set('cache-control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);

			return new Response(null, { headers });
		}

		// Gestione Range requests (solo per file non trasformati)
		let range: R2Range | undefined;
		if (rangeHeader && !hasTransformations) {
			range = parseRangeHeader(rangeHeader);
		}

		const options: R2GetOptions = {};
		if (range) options.range = range;

		const object = await env.wolfstar_cdn.get(objectKey, options);
		if (!isR2ObjectBody(object)) {
			return new Response('Not Found', { status: 404 });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('accept-ranges', 'bytes');
		headers.set('cache-control', `public, max-age=${IMMUTABLE_CACHE_TTL}, immutable`);

		// Gestione risposte parziali (range)
		if (range && object.range) {
			let start: number;
			let end: number;

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
				// Caso imprevisto, fallback a una risposta completa
				return new Response(object.body, { headers });
			}

			headers.set('content-range', `bytes ${start}-${end}/${object.size}`);

			return new Response(object.body, {
				status: 206,
				statusText: 'Partial Content',
				headers,
			});
		}

		// Risposta normale o con trasformazioni
		return new Response(object.body, {
			headers,
			cf: hasTransformations ? { image: cfOptions } : undefined,
		});
	} catch (error) {
		console.error(`R2 error (${objectKey}):`, error);
		return createErrorResponse('STORAGE_ERROR', 'Unable to retrieve file from storage', 500);
	}
}

/**
 * Serve un'immagine trasformata con fallback
 */
async function serveTransformedImage(
	pathname: string,
	options: CfImageTransformOptions,
	env: Env,
	isHeadRequest = false,
): Promise<Response> {
	try {
		const transformedResponse = await fetchFromR2(pathname, options, env, isHeadRequest);

		if (transformedResponse.ok) {
			transformedResponse.headers.set('X-Transform-Status', 'success');
			return transformedResponse;
		}

		// Fallback all'originale in caso di errore
		console.warn(`Transformation failed (${pathname}). Falling back to original.`);
		const fallbackResponse = await fetchFromR2(pathname, {}, env, isHeadRequest);
		if (fallbackResponse.ok) {
			fallbackResponse.headers.set('X-Transform-Status', 'fallback-original');
			return fallbackResponse;
		}

		return fallbackResponse;
	} catch (error) {
		console.error(`Transform error (${pathname}):`, error);
		return createErrorResponse('TRANSFORM_ERROR', 'Unable to process image transformation', 500);
	}
}

/**
 * Determina le origini consentite per CORS
 */
function getAllowedOrigins(env: Env): string[] {
	if (env.ALLOWED_ORIGINS) {
		return env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
	}
	return DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Gestisce il rate limiting in modo sicuro
 */
async function handleRateLimit(clientIP: string, rateLimiter: RateLimit): Promise<boolean> {
	try {
		const { success } = await rateLimiter.limit({ key: clientIP });
		return success;
	} catch (error) {
		console.error('Rate limit error:', error);
		// In caso di errore del rate limiter, permettiamo la richiesta
		// ma logghiamo l'errore per il monitoraggio
		return true;
	}
}

// ==== Hono App Setup ====

const app = new Hono<{ Bindings: Env }>();

// ==== Middleware ====

// Gestione centralizzata degli errori
app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return createErrorResponse('INTERNAL_ERROR', 'An unexpected error occurred', 500);
});

// Compressione automatica per risparmiare banda
app.use('*', compress());

// Security headers
app.use(
	'*',
	secureHeaders({
		xContentTypeOptions: 'nosniff',
		xFrameOptions: 'DENY',
		xXssProtection: '1; mode=block',
	}),
);

// CORS configurato per CDN con gestione migliorata
app.use(
	'*',
	cors({
		origin: (origin, c) => {
			const allowedOrigins = getAllowedOrigins(c.env);

			if (!origin) {
				// Consenti richieste senza origine (es. richieste dirette, Postman)
				// In questo caso, non c'è un'intestazione Origin da restituire.
				// Restituire null o undefined è un modo per gestire questo caso,
				// ma per essere espliciti, possiamo restituire l'origine stessa (che è falsy).
				return origin;
			}

			const isAllowed = allowedOrigins.some((allowed) => {
				if (allowed.includes('*')) {
					const pattern = allowed.replace(/\*/g, '.*');
					const regex = new RegExp(`^${pattern}$`);
					return regex.test(origin);
				}
				return allowed === origin;
			});

			return isAllowed ? origin : null;
		},
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Range', 'If-Range', 'If-None-Match'],
		exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
		maxAge: 86400,
		credentials: false,
	}),
);

// Logging minimale
app.use('*', logger());

// Rate limiting con gestione migliorata degli errori
app.use('*', async (c, next) => {
	if (!c.env.RATE_LIMITER) return next();

	const clientIP = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || c.req.header('x-real-ip');

	if (!clientIP) {
		console.warn('Unable to determine client IP for rate limiting');
		return next();
	}

	const isAllowed = await handleRateLimit(clientIP, c.env.RATE_LIMITER);
	if (!isAllowed) {
		return createErrorResponse('RATE_LIMITED', 'Too many requests', 429);
	}

	return next();
});

// Caching ottimizzato con gestione degli errori
app.use('/*', async (c, next) => {
	// Skip cache per health check
	if (c.req.path === '/health') return next();

	try {
		const cache = caches.default;
		const url = new URL(c.req.url);

		// Crea una chiave di cache che include Range e Accept-Encoding
		const cacheKeyHeaders = new Headers();
		const range = c.req.header('range');
		const encoding = c.req.header('accept-encoding');

		if (range) cacheKeyHeaders.set('range', range);
		if (encoding) cacheKeyHeaders.set('accept-encoding', encoding);

		const cacheKey = new Request(url.toString(), { headers: cacheKeyHeaders });
		const cachedResponse = await cache.match(cacheKey);

		if (cachedResponse) {
			const response = new Response(cachedResponse.body, cachedResponse);
			response.headers.set('X-Cache-Status', 'HIT');
			return response;
		}

		await next();

		// Cache solo risposte riuscite
		if (c.res && c.res.ok) {
			const response = c.res.clone();
			response.headers.set('X-Cache-Status', 'MISS');

			// Memorizzazione sicura nella cache
			if (c.executionCtx) {
				c.executionCtx.waitUntil(
					cache.put(cacheKey, response.clone()).catch((error) => {
						console.error('Cache storage error:', error);
					}),
				);
			} else {
				// Fallback per memorizzazione sincrona se il contesto non è disponibile
				cache.put(cacheKey, response.clone()).catch((error) => {
					console.error('Cache storage error:', error);
				});
			}
		}
	} catch (error) {
		console.error('Cache middleware error:', error);
		await next();
	}
});

// ==== Routes ====

// Diagnostica e Monitoraggio
app.get('/health', (c) => {
	const data: HealthResponse = {
		status: 'ok',
		timestamp: new Date().toISOString(),
		worker: 'wolfstar-cdn',
		region: c.req.header('cf-ray')?.split('-')[1],
	};

	return c.json(data, 200, {
		'Cache-Control': 'no-store',
		'X-Robots-Tag': 'noindex',
	});
});

// Route principale per asset
app.get('/*', async (c) => {
	try {
		const { pathname, searchParams } = new URL(c.req.url);
		const isHeadRequest = c.req.method === 'HEAD';
		const rangeHeader = c.req.header('range');

		// Determina se è un'immagine
		const fileExtension = getFileExtension(pathname);
		const isImage = IMAGE_EXTENSIONS.has(fileExtension);

		if (!isImage) {
			// File statici (non immagini)
			return await fetchFromR2(pathname, {}, c.env, isHeadRequest, rangeHeader);
		}

		// Analizza parametri di trasformazione
		const transformOptions = parseTransformations(searchParams);
		const hasTransformations = Object.keys(transformOptions).length > 0;

		if (!hasTransformations) {
			// Immagini originali
			return await fetchFromR2(pathname, {}, c.env, isHeadRequest, rangeHeader);
		}

		// Le trasformazioni immagini non supportano Range requests
		if (rangeHeader) {
			return createErrorResponse('RANGE_NOT_SUPPORTED', 'Range requests are not supported for image transformations', 400);
		}

		// Immagini trasformate
		return await serveTransformedImage(pathname, transformOptions, c.env, isHeadRequest);
	} catch (error) {
		console.error('Request handler error:', error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		return createErrorResponse('REQUEST_ERROR', errorMessage, 500);
	}
});

// Gestione 404 per percorsi non trovati
app.notFound((c) => {
	return createErrorResponse('NOT_FOUND', 'The requested resource was not found', 404);
});

export default app;
