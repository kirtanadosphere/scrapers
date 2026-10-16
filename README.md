# Standalone multi-platform scraper

Independent profile scraper for Instagram, Facebook, X, and YouTube. It stores normalized results in its own PostgreSQL database and processes work asynchronously through BullMQ workers running on the host machine.

## Services

`docker-compose.yml` starts only the infrastructure services:

- PostgreSQL: `localhost:15433`, database/user/password `scraper`
- Redis: `localhost:6380`

The API, migration command, and worker run directly on the host, matching the Social Tool development model. The existing Social Tool is not imported or modified. It must use another host port if its API runs at the same time.

## Start

Prerequisites: Node.js 22+, Docker Desktop, FFmpeg, and `yt-dlp` available on `PATH`. FFmpeg and `yt-dlp` are needed when missing YouTube captions must be converted to durable audio for transcription.

1. Copy `.env.example` to `.env` and replace all secrets and provider credentials.
2. Configure the S3 bucket and public/CDN base URL. Media is copied before OCR or transcription.
3. Ensure the Facebook upstream scraper does not use this service's port. The example uses host port `4100`.
4. Start PostgreSQL and Redis:

```bash
docker compose up -d
```

5. Install dependencies and migrate the database:

```bash
npm install
npm run migrate
```

6. Start the API in one terminal:

```bash
npm run dev:api
```

7. Start the worker in a second terminal:

```bash
npm run dev:worker
```

The API and worker append timestamped operational events to `logs.txt` in the project root as well as printing them to the terminal. Logs include provider failures and an explicit message when a failed local scraper request is transferred to Apify. The log file is ignored by Git because it is a local runtime artifact.

To inspect the database in Drizzle Studio, run this in another terminal after PostgreSQL is running:

```bash
npm run db:studio
```

Then open the configured `DRIZZLE_STUDIO_URL` (default: `http://localhost:4983`). Drizzle uses the same `DATABASE_URL` as the application.

The resulting layout is:

```text
Host machine
├── API process       http://localhost:4000
└── BullMQ worker

Docker
├── PostgreSQL        localhost:15433
└── Redis             localhost:6380
```

## API

All `/v1` endpoints require `X-API-Key`. `/health` and `/ready` are public.

The Bull Board dashboard is available at `http://localhost:4000/admin/queues` (use the configured API port). It requires HTTP Basic Authentication: the username defaults to `admin`; the password is `BULL_BOARD_PASSWORD` when configured, otherwise the existing `API_KEY` value. Keep this dashboard private, and use a dedicated strong `BULL_BOARD_PASSWORD` if exposing the API beyond your local machine.

Create a scrape job:

```bash
curl -X POST http://localhost:4000/v1/scrape-jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: replace-with-a-long-random-value" \
  -d '{
    "source": { "name": "Google Developers" },
    "feeds": [
      { "platform": "youtube", "url": "https://www.youtube.com/@GoogleDevelopers" }
    ],
    "postLimit": 25,
    "includeComments": true,
    "commentLimit": 25,
    "ocr": false,
    "transcription": false
  }'
```

To add or refresh feeds under an existing source, replace the inline source object with its UUID:

```json
{
  "source": { "id": "existing-source-uuid" },
  "feeds": [
    { "platform": "instagram", "url": "https://instagram.com/example" },
    { "platform": "youtube", "url": "https://youtube.com/@example" },
    { "platform": "x", "url": "https://x.com/example" },
    { "platform": "facebook", "url": "https://facebook.com/example" }
  ]
}
```

Each source can contain zero or one feed for each supported platform; submitting the same platform again updates that source's existing feed URL.

> If you ran the earlier prototype schema locally, remove its development database volume before the first run of this source/feed/content schema with `docker compose down -v`, then start PostgreSQL/Redis and run `npm run migrate`. This deletes only the standalone scraper's local Docker data.

Poll `GET /v1/scrape-jobs/:id` and retrieve paginated data from `GET /v1/scrape-jobs/:id/results?page=1&pageSize=50`. Jobs may be cancelled with `POST /v1/scrape-jobs/:id/cancel` or deleted with `DELETE /v1/scrape-jobs/:id`.

The normalized result follows `source → feeds → contents → content_comments`. A source can have at most one Instagram, Facebook, X, and YouTube feed. Results also contain media, caption/OCR/transcription enrichment, and provider warnings. Provider-specific raw payloads remain internal.

## Providers

| Platform | Primary | Fallback |
|---|---|---|
| Instagram | `INSTAGRAM_SCRAPER_BASE_URL` | Apify Instagram actors |
| Facebook | `FACEBOOK_SCRAPER_BASE_URL` | Apify Facebook actors |
| X | X API v2 | None |
| YouTube | YouTube Data API v3 | Captions use Media API, then Apify |

Apify rollover is controlled globally:

```env
APIFY_FALLBACK_ENABLED=true
APIFY_API_KEY=your-apify-token
```

Set `APIFY_FALLBACK_ENABLED=false` to prevent all automatic Apify fallback calls. Instagram and Facebook then use only their configured local scraper APIs, and YouTube captions use only `YOUTUBE_SCRAPER_BASE_URL`. X is unaffected because it has no Apify fallback.

X scraping is disabled by default. Set `X_SCRAPING_ENABLED=true` in `.env` and restart both the API and worker to enable it. While disabled, requests containing an X feed are rejected with HTTP 422, and queued X jobs are prevented from calling the X API.

Profile and posts are always scraped. Comments require `includeComments: true`. Pinned Instagram posts are skipped by default, X replies/retweets and YouTube live videos are excluded, and videos longer than 180 seconds are excluded unless the request supplies another allowed cap.

When both `startDate` and `endDate` are omitted, the API resolves a fixed UTC window from the request time back exactly 24 hours and stores those resolved timestamps with the job. Supplying either date disables this default and passes the supplied boundary to providers.

## OCR and transcription

Global gates are independent:

```env
OCR_ENABLED=false
TRANSCRIPTION_ENABLED=false
```

A job must also request the relevant capability. A request cannot override a disabled global flag. YouTube captions are attempted first; missing captions can flow through durable media copy, video precheck, and transcription.

External enrichment callbacks post to:

- `/v1/webhooks/video-precheck`
- `/v1/webhooks/transcription`
- `/v1/webhooks/ocr`

Callbacks require both `X-API-Key` and these headers:

```text
X-Webhook-Timestamp: Unix timestamp in seconds
X-Webhook-Signature: hex(HMAC-SHA256(ENRICHMENT_WEBHOOK_SECRET, "timestamp.rawJsonBody"))
```

Callback bodies use `requestId`, `postId`, `status`, and optional `text`, `result`, or `error`. Request IDs are replay-protected. Client completion callbacks use `X-Scraper-Timestamp` and `X-Scraper-Signature` with `CALLBACK_SIGNING_SECRET`.

## Retention and operations

- A daily cleanup job deletes records and scraper-owned S3 objects after `RETENTION_DAYS` (30 by default).
- Queue names are isolated by `QUEUE_PREFIX`.
- Retries use exponential backoff; exhausted optional stages produce a partially completed job when usable scrape data exists.
- `provider_attempts` records provider, capability, latency, status, and sanitized error details.

Run validation with:

```bash
npm run typecheck
npm test
npm run build
```
