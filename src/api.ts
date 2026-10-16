import express from 'express'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { ZodError, z } from 'zod'
import { config } from './config.js'
import { db, query, safeError } from './db.js'
import { logError, logInfo, logWarn } from './logger.js'
import { getQueue, queueNames, redis } from './queues.js'
import { createJob, getJob, getTargets, resultPage, taskDone } from './repository.js'
import { apiKey, verifySignature } from './security.js'
import { CreateJobSchema, detectPlatform } from './types.js'

declare global { namespace Express { interface Request { rawBody?: string } } }
const app = express()
app.use(express.json({ limit: '2mb', verify: (req, _res, buffer) => { (req as express.Request).rawBody = buffer.toString('utf8') } }))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/ready', async (_req, res) => {
  try { await Promise.all([db.query('SELECT 1'), redis.ping()]); res.json({ status: 'ready', postgres: 'ok', redis: 'ok' }) }
  catch (error) { logWarn('API readiness check failed', { error: safeError(error) }); res.status(503).json({ status: 'not_ready' }) }
})

const bullBoardAdapter = new ExpressAdapter()
bullBoardAdapter.setBasePath('/admin/queues')
createBullBoard({
  queues: Object.values(queueNames).map((name) => new BullMQAdapter(getQueue(name))),
  serverAdapter: bullBoardAdapter
})
app.use('/admin/queues', bullBoardAdapter.getRouter())

app.use('/v1', apiKey)

app.post('/v1/scrape-jobs', async (req, res) => {
  const input = CreateJobSchema.parse(req.body)
  if (input.ocr && !config.OCR_ENABLED) return res.status(422).json({ error: 'OCR is globally disabled' })
  if (input.transcription && !config.TRANSCRIPTION_ENABLED) return res.status(422).json({ error: 'Transcription is globally disabled' })
  if ((input.ocr || input.transcription) && (!config.S3_BUCKET || !config.S3_PUBLIC_BASE_URL)) return res.status(422).json({ error: 'S3_BUCKET and S3_PUBLIC_BASE_URL are required for enrichment' })
  const targets = input.feeds.map((feed) => ({ url: feed.url, platform: feed.platform ?? detectPlatform(feed.url) }))
  if (!config.X_SCRAPING_ENABLED && targets.some((target) => target.platform === 'x')) {
    return res.status(422).json({ error: 'X scraping is disabled; set X_SCRAPING_ENABLED=true in .env and restart the API and worker to enable it' })
  }
  const jobId = await createJob(input, targets)
  await getQueue(queueNames.orchestrate).add('start', { jobId }, { jobId })
  logInfo('Scrape job accepted', { jobId, targetCount: targets.length, platforms: [...new Set(targets.map((target) => target.platform))] })
  res.status(202).json({ id: jobId, status: 'queued', statusUrl: `${config.PUBLIC_BASE_URL}/v1/scrape-jobs/${jobId}`, resultsUrl: `${config.PUBLIC_BASE_URL}/v1/scrape-jobs/${jobId}/results` })
})

app.get('/v1/scrape-jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ ...job, targets: await getTargets(req.params.id) })
})

app.get('/v1/scrape-jobs/:id/results', async (req, res) => {
  if (!await getJob(req.params.id)) return res.status(404).json({ error: 'job not found' })
  const paging = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query)
  res.json(await resultPage(req.params.id, paging.page, paging.pageSize))
})

app.post('/v1/scrape-jobs/:id/cancel', async (req, res) => {
  const result = await query("UPDATE scrape_jobs SET cancel_requested=true,status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN ('queued','running') THEN now() ELSE completed_at END WHERE id=$1 RETURNING status", [req.params.id])
  if (!result.rowCount) return res.status(404).json({ error: 'job not found' })
  await query("UPDATE job_targets SET status='cancelled',pending_tasks=0 WHERE job_id=$1 AND status IN ('queued','running','enriching')", [req.params.id])
  res.status(202).json({ id: req.params.id, status: result.rows[0]!.status, cancelRequested: true })
})

app.delete('/v1/scrape-jobs/:id', async (req, res) => {
  const media = await query<{ storage_key: string }>('SELECT storage_key FROM media WHERE job_id=$1 AND storage_key IS NOT NULL', [req.params.id])
  const result = await query('DELETE FROM scrape_jobs WHERE id=$1 RETURNING id', [req.params.id])
  if (!result.rowCount) return res.status(404).json({ error: 'job not found' })
  if (media.rows.length) await getQueue(queueNames.cleanup).add('delete-media', { keys: media.rows.map((row) => row.storage_key) })
  res.status(204).end()
})

const webhookSchema = z.object({ requestId: z.string().min(1), postId: z.string().uuid(), status: z.enum(['completed','failed']), text: z.string().optional(), result: z.record(z.string(), z.unknown()).optional(), error: z.string().optional() })
for (const service of ['video-precheck','transcription','ocr'] as const) {
  app.post(`/v1/webhooks/${service}`, async (req, res) => {
    if (!verifySignature(req.header('x-webhook-timestamp'), req.header('x-webhook-signature'), req.rawBody ?? '')) return res.status(401).json({ error: 'invalid webhook signature' })
    const body = webhookSchema.parse(req.body)
    const receipt = await query('INSERT INTO webhook_receipts(request_id,service) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING request_id', [body.requestId, service])
    if (!receipt.rowCount) return res.status(202).json({ accepted: true, duplicate: true })
    const linked = await query<{ job_id: string; target_id: string }>('SELECT c.job_id,c.target_id FROM contents c WHERE c.id=$1', [body.postId])
    if (!linked.rowCount) return res.status(404).json({ error: 'post not found' })
    const { job_id: jobId, target_id: targetId } = linked.rows[0]!
    const kind = service === 'transcription' ? 'transcription' : service === 'ocr' ? 'ocr' : 'video_precheck'
    await query(`INSERT INTO enrichment_results(job_id,content_id,kind,status,text,data,external_request_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(content_id,kind) DO UPDATE SET status=EXCLUDED.status,text=EXCLUDED.text,data=EXCLUDED.data,updated_at=now()`, [jobId,body.postId,kind,body.status,body.text ?? null,body.result ?? { error: body.error },body.requestId])
    if (service === 'video-precheck' && body.status === 'completed' && body.result?.should_transcribe === true) {
      const mediaUrl = String(body.result.transcriptMediaUrl ?? '')
      if (mediaUrl) {
        await query('UPDATE job_targets SET pending_tasks=pending_tasks+1 WHERE id=$1', [targetId])
        await getQueue(queueNames.transcription).add('dispatch', { jobId, targetId, postId: body.postId, mediaUrl, language: body.result.language })
      }
    }
    const finished = await taskDone(jobId, targetId, body.status === 'failed' ? body.error ?? `${service} failed` : undefined)
    if (finished) {
      const completed = await getJob(jobId)
      if (completed?.callback_url) await getQueue(queueNames.callback).add('deliver', { jobId }, { jobId: `callback-${jobId}` })
    }
    res.status(202).json({ accepted: true })
  })
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    logWarn('API request validation failed', { issues: error.issues })
    return res.status(400).json({ error: 'validation_error', issues: error.issues })
  }
  logError('API request failed', { error: safeError(error) })
  res.status(500).json({ error: safeError(error) })
})

const server = app.listen(config.PORT, '0.0.0.0', () => logInfo('Scraper API listening', { port: config.PORT }))
async function shutdown() { logInfo('Scraper API shutting down'); server.close(); redis.disconnect(); await db.end(); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
