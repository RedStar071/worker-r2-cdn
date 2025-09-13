// ==== Constants ====

import type { CfImageFit, CfImageFormat, CfImageTransformOptions } from './types';

export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tiff', 'avif']);
export const ALLOWED_FIT_MODES = new Set<CfImageFit>(['scale-down', 'contain', 'cover', 'crop', 'pad']);
export const ALLOWED_FORMATS = new Set<CfImageFormat>(['webp', 'avif', 'jpeg', 'png']);
export const IMMUTABLE_CACHE_TTL = 31536000; // 1 year (in seconds)

// Limits to prevent abuse
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_IMAGE_DIMENSION = 1;
export const MAX_QUALITY = 100;
export const MIN_QUALITY = 1;

export const DEFAULT_TRANSFORM_OPTIONS: Readonly<Partial<CfImageTransformOptions>> = {
	quality: 85,
};
