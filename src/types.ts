// ==== Type Definitions ====

// Types for image transformation
type CfImageFit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
type CfImageFormat = 'webp' | 'avif' | 'jpeg' | 'png';

interface CfImageTransformOptions {
	width?: number;
	height?: number;
	quality?: number;
	fit?: CfImageFit;
	format?: CfImageFormat;
}

// Custom response types
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

type CloudflareEnv = { Bindings: Env };

export type { CfImageTransformOptions, HealthResponse, ErrorResponse, CfImageFit, CfImageFormat, CloudflareEnv };
