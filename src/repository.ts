import { config } from './config.js'
import { query, safeError } from './db.js'
import type { CreateJobInput, NormalizedComment, NormalizedPost, NormalizedProfile, Platform } from './types.js'

export async function createJob(input: CreateJobInput, targets: { url: string; platform: Platform }[]) {
  const expires = new Date(Date.now() + config.RETENTION_DAYS * 86400000)
  let sourceId: string
  if ('id' in input.source) {
    const existing = await query<{id:string}>('SELECT id FROM sources WHERE id=$1',[input.source.id])
    if (!existing.rowCount) throw new Error('Source not found')
    sourceId=input.source.id
  } else {
    sourceId=(await query<{id:string}>('INSERT INTO sources(name,description) VALUES($1,$2) RETURNING id',[input.source.name,input.source.description??null])).rows[0]!.id
  }
  const result = await query<{ id: string }>('INSERT INTO scrape_jobs(source_id,status,request,callback_url,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id', [sourceId,'queued', input, input.callbackUrl ?? null, expires])
  const id = result.rows[0]!.id
  for (const target of targets) {
    const feed=(await query<{id:string}>(`INSERT INTO feeds(source_id,platform,url) VALUES($1,$2,$3) ON CONFLICT(source_id,platform) DO UPDATE SET url=EXCLUDED.url,is_active=true,updated_at=now() RETURNING id`,[sourceId,target.platform,target.url])).rows[0]!
    await query('INSERT INTO job_targets(job_id,source_id,feed_id,input_url,platform) VALUES($1,$2,$3,$4,$5)', [id,sourceId,feed.id,target.url,target.platform])
  }
  return id
}

export async function getJob(id: string) {
  const result = await query('SELECT * FROM scrape_jobs WHERE id=$1', [id])
  return result.rows[0] ?? null
}

export async function getTargets(jobId: string) {
  return (await query('SELECT * FROM job_targets WHERE job_id=$1 ORDER BY created_at', [jobId])).rows
}

export async function updateFeedProfile(feedId: string, profile: NormalizedProfile): Promise<void> {
  await query(`UPDATE feeds SET external_id=$2,username=$3,name=$4,about=$5,profile_picture=$6,followers_count=$7,follows_count=$8,content_count=$9,is_verified_account=$10,profile_raw=$11,url_verification_status='completed',failed_reason=NULL,last_updated_at=now(),updated_at=now() WHERE id=$1`,
    [feedId,profile.externalId,profile.username,profile.name,profile.description,profile.profileImageUrl,profile.followersCount,profile.followingCount,profile.postsCount,profile.verified,profile.raw ?? null])
}

export async function insertContent(jobId: string, targetId: string, sourceId: string, feedId: string, platform: Platform, post: NormalizedPost): Promise<string> {
  const type=post.contentType==='text'?'textual':post.contentType
  const thumbnail=post.media.find((item)=>item.type==='image')?.url??null
  const followers=Number((await query<{followers_count:string|null}>('SELECT followers_count FROM feeds WHERE id=$1',[feedId])).rows[0]?.followers_count??0)
  const engagement=followers>0?(post.likesCount+post.commentsCount+post.viewsCount)/followers:0
  const result = await query<{ id: string }>(`INSERT INTO contents(job_id,target_id,source_id,feed_id,status,platform,type,external_id,published_at,url,thumbnail_url,hashtags,raw_title,raw_description,duration_seconds,likes_count,comments_count,shares_count,views_count,engagement_rate,conversation_id,provider_raw)
    VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT(source_id,feed_id,external_id,platform) DO UPDATE SET likes_count=EXCLUDED.likes_count,comments_count=EXCLUDED.comments_count,shares_count=EXCLUDED.shares_count,views_count=EXCLUDED.views_count,engagement_rate=EXCLUDED.engagement_rate,job_id=EXCLUDED.job_id,target_id=EXCLUDED.target_id RETURNING id`,
    [jobId,targetId,sourceId,feedId,platform,type,post.externalId,post.publishedAt??new Date().toISOString(),post.url,thumbnail,post.hashtags,post.title,post.description,post.durationSeconds,post.likesCount,post.commentsCount,post.sharesCount,post.viewsCount,engagement,post.conversationId,post.raw??null])
  return result.rows[0]!.id
}

export async function insertComment(jobId: string, contentId: string, platform: Platform, item: NormalizedComment) {
  await query(`INSERT INTO content_comments(job_id,content_id,platform,external_id,text,likes_count,replies_count,owner_external_id,owner_name,owner_username,timestamp,provider_raw)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(job_id,platform,external_id) DO NOTHING`,
    [jobId,contentId,platform,item.externalId,item.text,item.likesCount,item.repliesCount,item.authorId,item.authorName,item.authorUsername,item.publishedAt??new Date().toISOString(),item.raw??null])
}

export async function recordAttempt(jobId: string, targetId: string, provider: string, capability: string, status: string, duration: number, error?: string) {
  await query('INSERT INTO provider_attempts(job_id,target_id,provider,capability,status,duration_ms,error) VALUES($1,$2,$3,$4,$5,$6,$7)', [jobId,targetId,provider,capability,status,duration,error ? safeError(error) : null])
}

export async function addTasks(targetId: string, count: number) {
  await query("UPDATE job_targets SET pending_tasks=pending_tasks+$2,status='enriching' WHERE id=$1", [targetId, count])
}

export async function taskDone(jobId: string, targetId: string, error?: unknown) {
  await query(`UPDATE job_targets SET pending_tasks=GREATEST(0,pending_tasks-1), error=COALESCE(error,$2) WHERE id=$1`, [targetId, error ? safeError(error) : null])
  const target = (await query<{ pending_tasks: number }>('SELECT pending_tasks FROM job_targets WHERE id=$1', [targetId])).rows[0]
  if (target?.pending_tasks === 0) await query("UPDATE job_targets SET status=CASE WHEN error IS NULL THEN 'completed' ELSE 'partially_completed' END WHERE id=$1", [targetId])
  return finalizeJob(jobId)
}

export async function failTarget(jobId: string, targetId: string, error: unknown) {
  await query("UPDATE job_targets SET status='failed',error=$2,pending_tasks=0 WHERE id=$1", [targetId, safeError(error)])
  await finalizeJob(jobId)
}

export async function finalizeJob(jobId: string) {
  const counts = (await query<{ total: string; terminal: string; good: string; failed: string; partial: string }>(`SELECT count(*) total, count(*) FILTER(WHERE status IN ('completed','partially_completed','failed','cancelled')) terminal, count(*) FILTER(WHERE status IN ('completed','partially_completed')) good, count(*) FILTER(WHERE status='failed') failed, count(*) FILTER(WHERE status='partially_completed') partial FROM job_targets WHERE job_id=$1`, [jobId])).rows[0]!
  const total = Number(counts.total), terminal = Number(counts.terminal), good = Number(counts.good), failed = Number(counts.failed), partial = Number(counts.partial)
  await query('UPDATE scrape_jobs SET progress=$2 WHERE id=$1', [jobId, { totalTargets: total, completedTargets: terminal, successfulTargets: good, failedTargets: failed }])
  if (total === 0 || terminal < total) return false
  const status = good === 0 ? 'failed' : failed > 0 || partial > 0 || good < total ? 'partially_completed' : 'completed'
  await query('UPDATE scrape_jobs SET status=$2,completed_at=now() WHERE id=$1 AND status NOT IN (\'cancelled\',\'completed\',\'partially_completed\',\'failed\')', [jobId, status])
  return true
}

export async function resultPage(jobId: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize
  const [profiles, posts, comments, enrichment, warnings, media] = await Promise.all([
    query('SELECT s.* FROM sources s JOIN scrape_jobs j ON j.source_id=s.id WHERE j.id=$1',[jobId]),
    query('SELECT c.* FROM contents c WHERE c.job_id=$1 ORDER BY published_at DESC NULLS LAST LIMIT $2 OFFSET $3',[jobId,pageSize,offset]),
    query('SELECT cc.* FROM content_comments cc WHERE cc.job_id=$1 ORDER BY created_at LIMIT $2 OFFSET $3',[jobId,pageSize,offset]),
    query('SELECT content_id,media_id,kind,status,text,data FROM enrichment_results WHERE job_id=$1 ORDER BY created_at LIMIT $2 OFFSET $3',[jobId,pageSize,offset]),
    query("SELECT provider,capability,error,created_at FROM provider_attempts WHERE job_id=$1 AND status='failed' ORDER BY created_at",[jobId]),
    query('SELECT content_id,media_type,original_url,durable_url,mime_type,status FROM media WHERE job_id=$1 ORDER BY created_at LIMIT $2 OFFSET $3',[jobId,pageSize,offset])
  ])
  const feeds=await query('SELECT f.* FROM feeds f JOIN scrape_jobs j ON j.source_id=f.source_id WHERE j.id=$1 ORDER BY f.platform',[jobId])
  return { page, pageSize, source: profiles.rows[0]??null, feeds:feeds.rows, contents:posts.rows, comments: comments.rows, media: media.rows, enrichment: enrichment.rows, warnings: warnings.rows }
}
