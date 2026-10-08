import 'dotenv/config'
import { z } from 'zod'

const bool = z.string().default('false').transform((value) => value.toLowerCase() === 'true')
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  API_KEY: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default('scraper'),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  APIFY_FALLBACK_ENABLED: z.string().default('true').transform((value) => value.toLowerCase() === 'true'),
  APIFY_API_KEY: z.string().default(''),
  YOUTUBE_API_KEY: z.string().default(''),
  X_API_TOKEN: z.string().default(''),
  INSTAGRAM_SCRAPER_BASE_URL: z.string().default(''),
  FACEBOOK_SCRAPER_BASE_URL: z.string().default(''),
  YOUTUBE_SCRAPER_BASE_URL: z.string().default(''),
  OCR_ENABLED: bool,
  TRANSCRIPTION_ENABLED: bool,
  VIDEO_PRECHECK_SERVICE_URL: z.string().default(''),
  TRANSCRIPTION_SERVICE_URL: z.string().default(''),
  OCR_SERVICE_URL: z.string().default(''),
  ENRICHMENT_WEBHOOK_SECRET: z.string().min(16),
  CALLBACK_SIGNING_SECRET: z.string().min(16),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool,
  S3_PUBLIC_BASE_URL: z.string().default('')
})

export const config = envSchema.parse(process.env)
