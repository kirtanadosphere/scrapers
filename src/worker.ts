import { Readable } from 'node:stream'
import axios from 'axios'
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Job, Worker } from 'bullmq'
import { YtDlp } from 'ytdlp-nodejs'
import { config } from './config.js'
import { db, query, safeError } from './db.js'
import { logError, logInfo } from './logger.js'
import { getQueue, queueNames, redis, type QueueName } from './queues.js'
import { addTasks, failTarget, getJob, getTargets, insertComment, insertContent, recordAttempt, taskDone, updateFeedProfile } from './repository.js'
import { providersFor, withFallback } from './providers.js'
import { hmac } from './security.js'
import type { CreateJobInput, NormalizedPost, NormalizedProfile, Platform } from './types.js'

const connection = redis
const workers: Worker[] = []
const s3 = new S3Client({ region: config.S3_REGION, endpoint: config.S3_ENDPOINT || undefined, forcePathStyle: config.S3_FORCE_PATH_STYLE, credentials: config.S3_ACCESS_KEY_ID ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined })
let ytDlp: YtDlp | undefined
const getYtDlp = () => (ytDlp ??= new YtDlp())
const worker = (name: QueueName, processor: (job: Job) => Promise<unknown>, concurrency = 5) => {
  const instance = new Worker(name, processor, { connection, prefix: config.QUEUE_PREFIX, concurrency, limiter: { max: 100, duration: 60000 } })
  instance.on('failed', (job, error) => logError('Queue job failed', {
    queue: name, jobId: job?.id ?? null, jobName: job?.name ?? null,
    attemptsMade: job?.attemptsMade ?? null, maxAttempts: job?.opts.attempts ?? 1,
    willRetry: Boolean(job && job.attemptsMade < (job.opts.attempts ?? 1)),
    failedReason: job?.failedReason ?? null,
    jobContext: job ? Object.fromEntries(['jobId','targetId','postId','mediaId','requestId'].filter((key) => job.data?.[key] !== undefined).map((key) => [key, job.data[key]])) : null,
    error,
  }))
  instance.on('error', (error) => logError('Queue worker infrastructure error', { queue: name, error }))
  instance.on('stalled', (jobId) => logError('Queue job stalled and will be retried', { queue: name, jobId }))
  workers.push(instance); return instance
}
const cancelled = async (jobId: string) => Boolean((await getJob(jobId))?.cancel_requested)
const attemptRecorder = (jobId: string, targetId: string, capability: string) => (provider: string, status: string, duration: number, error?: string) => recordAttempt(jobId,targetId,provider,capability,status,duration,error)
const publicObjectUrl = (key: string) => config.S3_PUBLIC_BASE_URL ? `${config.S3_PUBLIC_BASE_URL.replace(/\/$/,'')}/${key}` : `s3://${config.S3_BUCKET}/${key}`

async function maybeCallback(jobId: string) {
  const job = await getJob(jobId)
  if (!job || !['completed','partially_completed','failed','cancelled'].includes(job.status) || !job.callback_url) return
  await getQueue(queueNames.callback).add('deliver', { jobId }, { jobId: `callback-${jobId}` })
}

worker(queueNames.orchestrate, async (bullJob) => {
  const { jobId } = bullJob.data
  if (await cancelled(jobId)) return
  await query("UPDATE scrape_jobs SET status='running',started_at=COALESCE(started_at,now()) WHERE id=$1", [jobId])
  const targets = await getTargets(jobId)
  logInfo('Scrape job started', { jobId, targetCount: targets.length })
  for (const target of targets) {
    await query("UPDATE job_targets SET pending_tasks=1,status='running' WHERE id=$1", [target.id])
    await getQueue(queueNames.profile).add('scrape', { jobId, targetId: target.id }, { jobId: `${jobId}:${target.id}:profile` })
  }
})

worker(queueNames.profile, async (bullJob) => {
  const { jobId, targetId } = bullJob.data
  if (await cancelled(jobId)) return taskDone(jobId,targetId)
  const target = (await query<any>('SELECT * FROM job_targets WHERE id=$1', [targetId])).rows[0]
  try {
    const profile = await withFallback(jobId,targetId,target.platform,'profile',(p) => p.profile(target.input_url),attemptRecorder(jobId,targetId,'profile'))
    await updateFeedProfile(target.feed_id,profile)
    await addTasks(targetId, 1)
    await getQueue(queueNames.posts).add('scrape', { jobId,targetId,profile }, { jobId: `${jobId}:${targetId}:posts` })
    await taskDone(jobId,targetId)
  } catch (error) { logError('Profile scrape failed', { jobId, targetId, platform: target?.platform, inputUrl: target?.input_url, error }); await failTarget(jobId,targetId,error); await maybeCallback(jobId) }
})

worker(queueNames.posts, async (bullJob) => {
  const { jobId,targetId,profile } = bullJob.data as { jobId:string; targetId:string; profile:NormalizedProfile }
  if (await cancelled(jobId)) return taskDone(jobId,targetId)
  const job = await getJob(jobId); const input = job.request as CreateJobInput
  const target = (await query<any>('SELECT * FROM job_targets WHERE id=$1', [targetId])).rows[0]
  try {
    const posts = await withFallback(jobId,targetId,target.platform,'posts',(p) => p.posts(target.input_url,profile,input),attemptRecorder(jobId,targetId,'posts'))
    const tasks: { queue: QueueName; name: string; data: any; id: string }[] = []
    for (const post of posts) {
      const postId = await insertContent(jobId,targetId,target.source_id,target.feed_id,target.platform,post)
      for (const media of post.media) {
        await query(`INSERT INTO media(job_id,content_id,media_type,original_url,status)
          VALUES($1,$2,$3,$4,'original') ON CONFLICT(content_id,original_url) DO NOTHING`,
        [jobId,postId,media.type,media.url])
      }
      if (input.includeComments && post.commentsCount > 0) tasks.push({ queue: queueNames.comments,name:'scrape',data:{jobId,targetId,postId,post,platform:target.platform,limit:input.commentLimit},id:`${jobId}:${postId}:comments` })
      if (target.platform === 'youtube' && post.contentType === 'video') tasks.push({ queue:queueNames.captions,name:'fetch',data:{jobId,targetId,postId,post},id:`${jobId}:${postId}:captions` })
      else for (const media of post.media) {
        const needsOcr = post.contentType === 'image' && media.type === 'image' && input.ocr && config.OCR_ENABLED
        const needsTranscription = post.contentType === 'video' && media.type !== 'image' && input.transcription && config.TRANSCRIPTION_ENABLED
        if (needsOcr || needsTranscription) tasks.push({ queue:queueNames.media,name:'copy',data:{jobId,targetId,postId,postType:post.contentType,media,input},id:`${jobId}:${postId}:media:${tasks.length}` })
      }
    }
    if (tasks.length) await addTasks(targetId,tasks.length)
    for (const task of tasks) await getQueue(task.queue).add(task.name,task.data,{jobId:task.id})
    await taskDone(jobId,targetId)
    await maybeCallback(jobId)
  } catch (error) { logError('Posts scrape failed', { jobId, targetId, platform: target?.platform, inputUrl: target?.input_url, error }); await taskDone(jobId,targetId,error); await maybeCallback(jobId) }
})

worker(queueNames.comments, async (bullJob) => {
  const { jobId,targetId,postId,post,platform,limit } = bullJob.data as {jobId:string;targetId:string;postId:string;post:NormalizedPost;platform:Platform;limit:number}
  try {
    if (!await cancelled(jobId)) {
      const items = await withFallback(jobId,targetId,platform,'comments',(p) => p.comments(post,limit),attemptRecorder(jobId,targetId,'comments'))
      for (const item of items) await insertComment(jobId,postId,platform,item)
    }
    await taskDone(jobId,targetId)
  } catch (error) { logError('Comments scrape failed', { jobId, targetId, platform, postId, error }); await taskDone(jobId,targetId,error) }
  await maybeCallback(jobId)
})

worker(queueNames.captions, async (bullJob) => {
  const { jobId,targetId,postId,post } = bullJob.data as {jobId:string;targetId:string;postId:string;post:NormalizedPost}
  try {
    let text: string | null = null
    if (!await cancelled(jobId)) text = await withFallback(jobId,targetId,'youtube','captions',(p) => p.captions!(post),attemptRecorder(jobId,targetId,'captions'))
    await query(`INSERT INTO enrichment_results(job_id,content_id,kind,status,text) VALUES($1,$2,'caption',$3,$4) ON CONFLICT(content_id,kind) DO UPDATE SET status=EXCLUDED.status,text=EXCLUDED.text,updated_at=now()`,[jobId,postId,text?'completed':'unavailable',text])
    const input = (await getJob(jobId)).request as CreateJobInput
    if (!text && input.transcription && config.TRANSCRIPTION_ENABLED) {
      await addTasks(targetId,1)
      await getQueue(queueNames.media).add('copy',{jobId,targetId,postId,postType:'video',media:{type:'video',url:post.url},input},{jobId:`${jobId}:${postId}:youtube-media`})
    }
    await taskDone(jobId,targetId)
  } catch (error) { logError('YouTube captions processing failed', { jobId, targetId, postId, error }); await taskDone(jobId,targetId,error) }
  await maybeCallback(jobId)
}, 10)

async function uploadRemote(url: string, key: string): Promise<{ durableUrl:string; mimeType:string }> {
  let body: NodeJS.ReadableStream; let mimeType = 'application/octet-stream'
  if (url.includes('youtube.com/watch')) {
    body = getYtDlp().stream(url).filter('audioonly').type('m4a').quality(0).getStream() as unknown as Readable; mimeType = 'audio/mp4'
  } else {
    const response = await axios.get(url,{responseType:'stream',timeout:config.PROVIDER_TIMEOUT_MS,maxContentLength:250*1024*1024})
    body = response.data as Readable; mimeType = String(response.headers['content-type'] ?? mimeType)
  }
  await new Upload({client:s3,params:{Bucket:config.S3_BUCKET,Key:key,Body:body as Readable,ContentType:mimeType}}).done()
  return {durableUrl:publicObjectUrl(key),mimeType}
}

worker(queueNames.media, async (bullJob) => {
  const {jobId,targetId,postId,postType,media,input}=bullJob.data
  try {
    if (await cancelled(jobId)) { await taskDone(jobId,targetId); return }
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required for durable media')
    const extension = media.type === 'image' ? 'img' : media.type === 'audio' ? 'm4a' : 'mp4'
    const key = `scraper/${jobId}/${postId}/${bullJob.id}.${extension}`
    const stored = await uploadRemote(media.url,key)
    const row = await query<{id:string}>(`INSERT INTO media(job_id,content_id,media_type,original_url,durable_url,storage_key,mime_type,status) VALUES($1,$2,$3,$4,$5,$6,$7,'completed') ON CONFLICT(content_id,original_url) DO UPDATE SET durable_url=EXCLUDED.durable_url,storage_key=EXCLUDED.storage_key,mime_type=EXCLUDED.mime_type,status='completed' RETURNING id`,[jobId,postId,media.type,media.url,stored.durableUrl,key,stored.mimeType])
    const mediaId=row.rows[0]!.id
    if (postType === 'image' && input.ocr && config.OCR_ENABLED) {
      await addTasks(targetId,1); await getQueue(queueNames.ocr).add('dispatch',{jobId,targetId,postId,mediaId,mediaUrl:stored.durableUrl})
    }
    if (postType === 'video' && input.transcription && config.TRANSCRIPTION_ENABLED && media.type !== 'image') {
      await addTasks(targetId,1); await getQueue(queueNames.precheck).add('dispatch',{jobId,targetId,postId,mediaId,mediaUrl:stored.durableUrl})
    }
    await taskDone(jobId,targetId)
  } catch(error){ logError('Media processing failed', { jobId, targetId, postId, postType, mediaType: media?.type, mediaUrl: media?.url, s3Bucket: config.S3_BUCKET, error }); await taskDone(jobId,targetId,error) }
  await maybeCallback(jobId)
},3)

async function dispatch(serviceUrl:string,path:string,data:any) {
  if (!serviceUrl) throw new Error(`${path} service URL is not configured`)
  const timestamp=Math.floor(Date.now()/1000).toString(); const body=JSON.stringify(data)
  logInfo('Dispatching enrichment request', { path, requestId: data.requestId, postId: data.postId })
  await axios.post(`${serviceUrl.replace(/\/$/,'')}${path}`,data,{timeout:config.PROVIDER_TIMEOUT_MS,headers:{'x-webhook-timestamp':timestamp,'x-webhook-signature':hmac(config.ENRICHMENT_WEBHOOK_SECRET,timestamp,body)}})
}
worker(queueNames.precheck, async (job)=>{ const d=job.data; await dispatch(config.VIDEO_PRECHECK_SERVICE_URL,'/precheck-requests',{requestId:`precheck-${d.postId}`,postId:d.postId,contentId:d.postId,transcriptMediaUrl:d.mediaUrl,webhookUrl:`${config.PUBLIC_BASE_URL}/v1/webhooks/video-precheck`}) })
worker(queueNames.transcription, async (job)=>{ const d=job.data; await dispatch(config.TRANSCRIPTION_SERVICE_URL,'/transcribe',{requestId:`transcription-${d.postId}`,postId:d.postId,contentId:d.postId,transcriptMediaUrl:d.mediaUrl,languageCode:d.language,webhookUrl:`${config.PUBLIC_BASE_URL}/v1/webhooks/transcription`}) })
worker(queueNames.ocr, async (job)=>{ const d=job.data; await dispatch(config.OCR_SERVICE_URL,'/ocr',{requestId:`ocr-${d.postId}`,postId:d.postId,contentId:d.postId,sourceUrl:d.mediaUrl,webhookUrl:`${config.PUBLIC_BASE_URL}/v1/webhooks/ocr`}) })

for (const name of [queueNames.precheck,queueNames.transcription,queueNames.ocr]) {
  const current=workers.find((item)=>item.name===name)!
  current.on('failed',async(job,error)=>{ if(job && job.attemptsMade >= (job.opts.attempts ?? 3)){ await taskDone(job.data.jobId,job.data.targetId,error); await maybeCallback(job.data.jobId) } })
}

worker(queueNames.callback, async (bullJob)=>{
  const job=await getJob(bullJob.data.jobId); if(!job?.callback_url)return
  const body=JSON.stringify({id:job.id,status:job.status,progress:job.progress,resultsUrl:`${config.PUBLIC_BASE_URL}/v1/scrape-jobs/${job.id}/results`})
  const timestamp=Math.floor(Date.now()/1000).toString()
  const delivery=await query<{id:string}>('INSERT INTO webhook_deliveries(job_id,url,status,attempts) VALUES($1,$2,\'pending\',$3) RETURNING id',[job.id,job.callback_url,bullJob.attemptsMade+1])
  try { const response=await axios.post(job.callback_url,JSON.parse(body),{timeout:15000,headers:{'x-scraper-timestamp':timestamp,'x-scraper-signature':hmac(config.CALLBACK_SIGNING_SECRET,timestamp,body)}}); await query("UPDATE webhook_deliveries SET status='delivered',response_status=$2,delivered_at=now() WHERE id=$1",[delivery.rows[0]!.id,response.status]) }
  catch(error:any){ await query("UPDATE webhook_deliveries SET status='failed',response_status=$2,error=$3 WHERE id=$1",[delivery.rows[0]!.id,error?.response?.status??null,safeError(error)]); throw error }
},2)

worker(queueNames.cleanup, async (bullJob)=>{
  if(bullJob.name==='delete-media' && bullJob.data.keys?.length && config.S3_BUCKET) await s3.send(new DeleteObjectsCommand({Bucket:config.S3_BUCKET,Delete:{Objects:bullJob.data.keys.map((Key:string)=>({Key}))}}))
  if(bullJob.name==='retention'){
    const expired=await query<{id:string}>('SELECT id FROM scrape_jobs WHERE expires_at<now() LIMIT 100')
    for(const row of expired.rows){ const media=await query<{storage_key:string}>('SELECT storage_key FROM media WHERE job_id=$1 AND storage_key IS NOT NULL',[row.id]); if(media.rows.length && config.S3_BUCKET) await s3.send(new DeleteObjectsCommand({Bucket:config.S3_BUCKET,Delete:{Objects:media.rows.map(({storage_key:Key})=>({Key}))}})); await query('DELETE FROM scrape_jobs WHERE id=$1',[row.id]) }
  }
},1)

await getQueue(queueNames.cleanup).upsertJobScheduler('retention-daily',{every:86400000},{name:'retention',data:{}})
logInfo('Scraper workers started', { queues: workers.map((item) => item.name) })
async function shutdown(){logInfo('Scraper workers shutting down');await Promise.all(workers.map((item)=>item.close()));redis.disconnect();await db.end();process.exit(0)}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
