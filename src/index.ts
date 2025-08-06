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

type CfImageFit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
type CfImageFormat = 'webp' | 'avif' | 'jpeg' | 'png';

interface CfImageTransformOptions {
	width?: number;
	height?: number;
	quality?: number;
	fit?: CfImageFit;
	format?: CfImageFormat;
}

// worker.js
export default {
		/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

		// Implementa la logica di caching con KV
		const cacheKey = url.toString();
		const cachedData = await env.IMAGE_CACHE.get(cacheKey, { type: 'json' });

		if (cachedData) {
			console.log(`Cache HIT for: ${cacheKey}`);
			// @ts-ignore
			const body = Uint8Array.from(atob(cachedData.body), c => c.charCodeAt(0));
			// @ts-ignore
			const headers = new Headers(cachedData.headers);
			headers.set('X-Cache-Status', 'HIT');
			// @ts-ignore
			return new Response(body, { status: cachedData.status, statusText: cachedData.statusText, headers });
		}
		console.log(`Cache MISS for: ${cacheKey}`);

    const { searchParams, pathname } = url

    // Headers CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }

    // Gestisci richieste OPTIONS per CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders
      })
    }

    try {
      // Estrai parametri di trasformazione
      const width = searchParams.get('w')
      const height = searchParams.get('h')
      const quality = searchParams.get('q') || '85'
      const fit = searchParams.get('fit') || 'cover'
      const format = searchParams.get('f')

      // Costruisci URL completo per R2
      const r2BaseUrl = env.R2_PUBLIC_URL
      if (!r2BaseUrl) {
        throw new Error('R2_PUBLIC_URL environment variable is required')
      }

      // Rimuovi il leading slash se presente
      const cleanPathname = pathname.startsWith('/') ? pathname.slice(1) : pathname
      const r2Url = `${r2BaseUrl}/${cleanPathname}`

      console.log(`Fetching image from R2: ${r2Url}`)

      // Fetch dall'R2 bucket
      let r2Response = await fetch(r2Url, {
        headers: {
          'User-Agent': 'Cloudflare-Worker-Image-Resizer/1.0'
        }
      })

      if (!r2Response.ok) {
        console.error(`R2 fetch failed: ${r2Response.status} ${r2Response.statusText}`)
        return new Response(`Image not found: ${cleanPathname}`, {
          status: 404,
          headers: corsHeaders
        })
      }

      // Se non ci sono parametri di trasformazione, restituisci l'immagine originale
      if (!width && !height && !format) {
        const imageResponse = new Response(r2Response.body, {
          headers: {
            ...corsHeaders,
            'Content-Type': r2Response.headers.get('Content-Type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Vary': 'Accept',
						'X-Cache-Status': 'MISS'
          }
        });
				const kvObject = await responseToKvObject(imageResponse.clone());
				ctx.waitUntil(env.IMAGE_CACHE.put(cacheKey, JSON.stringify(kvObject), { expirationTtl: 31536000 }));
        return imageResponse;
      }

      // Applica trasformazioni usando Cloudflare Image Resizing
      const imageTransformOptions: CfImageTransformOptions = {}

      if (width) {
        imageTransformOptions.width = parseInt(width, 10)
      }

      if (height) {
        imageTransformOptions.height = parseInt(height, 10)
      }

      if (quality) {
        const qualityNum = parseInt(quality, 10)
        if (qualityNum >= 1 && qualityNum <= 100) {
          imageTransformOptions.quality = qualityNum
        }
      }

      if (fit) {
        // Cloudflare supporta: scale-down, contain, cover, crop, pad
        const validFits: CfImageFit[] = ['scale-down', 'contain', 'cover', 'crop', 'pad']
        if (validFits.includes(fit as CfImageFit)) {
          imageTransformOptions.fit = fit as CfImageFit
        }
      }

      if (format) {
        // Cloudflare supporta: webp, avif, jpeg, png
        const validFormats: CfImageFormat[] = ['webp', 'avif', 'jpeg', 'png']
        const lowerCaseFormat = format.toLowerCase() as CfImageFormat
        if (validFormats.includes(lowerCaseFormat)) {
          imageTransformOptions.format = lowerCaseFormat
        }
      }

      console.log('Transform options:', JSON.stringify(imageTransformOptions))

      // Applica le trasformazioni
      const transformedResponse = await fetch(r2Url, { cf: { image: imageTransformOptions } })

      if (!transformedResponse.ok) {
        console.error(`Image transformation failed: ${transformedResponse.status}`)
        // Fallback all'immagine originale
        r2Response = await fetch(r2Url)
        const fallbackResponse = new Response(r2Response.body, {
          headers: {
            ...corsHeaders,
            'Content-Type': r2Response.headers.get('Content-Type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000',
            'X-Transform-Status': 'fallback-original',
						'X-Cache-Status': 'MISS'
          }
        });
				const kvObject = await responseToKvObject(fallbackResponse.clone());
				ctx.waitUntil(env.IMAGE_CACHE.put(cacheKey, JSON.stringify(kvObject), { expirationTtl: 31536000 }));
				return fallbackResponse;
      }

      // Determina il Content-Type corretto
      let contentType = transformedResponse.headers.get('Content-Type')
      if (imageTransformOptions.format && contentType && !contentType.includes(imageTransformOptions.format)) {
        contentType = `image/${imageTransformOptions.format}`
      }

      const finalResponse = new Response(transformedResponse.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': contentType!,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Vary': 'Accept',
          'X-Transform-Status': 'success',
					'X-Cache-Status': 'MISS'
        }
      });
			const kvObject = await responseToKvObject(finalResponse.clone());
			ctx.waitUntil(env.IMAGE_CACHE.put(cacheKey, JSON.stringify(kvObject), { expirationTtl: 31536000 }));
			return finalResponse;

    } catch (error) {
      console.error('Worker error:', error);
      if (error instanceof Error) {
        return new Response(`Internal server error: ${error.message}`, {
          status: 500,
          headers: corsHeaders,
        });
      }
      return new Response('Internal server error', {
        status: 500,
        headers: corsHeaders,
      });
    }
	}
};

async function responseToKvObject(response: Response) {
	const body = await response.arrayBuffer();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return {
		body: btoa(String.fromCharCode(...new Uint8Array(body))),
		headers,
		status: response.status,
		statusText: response.statusText,
	};
}

