import axios from 'axios'
import { config } from './config.js'
import { logApifyFallback, logError, logInfo, logWarn } from './logger.js'
import { formatLocalScraperDate } from './provider-utils.js'
import type { CreateJobInput, NormalizedComment, NormalizedPost, NormalizedProfile, Platform, Provider } from './types.js'

const http = axios.create({ timeout: config.PROVIDER_TIMEOUT_MS })
const num = (value: unknown) => Math.max(0, Number(value) || 0)
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const payload = (value: any) => value?.data?.data ?? value?.data ?? value
const bestVideo = (media: any[]): string | null => {
  const variants = media.flatMap((item) => item?.variants ?? []).filter((item) => item?.content_type === 'video/mp4' && item?.url)
  variants.sort((a, b) => num(b.bit_rate) - num(a.bit_rate))
  return variants[0]?.url ?? media.find((item) => item?.type === 'video')?.url ?? null
}
const parseDuration = (duration: string | undefined): number => {
  const match = duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/)
  return match ? num(match[1]) * 3600 + num(match[2]) * 60 + num(match[3]) : 0
}
const usernameFromUrl = (value: string) => {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  return url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') ?? ''
}
async function apifyItems(actorId: string, input: Record<string, unknown>): Promise<any[]> {
  if (!config.APIFY_API_KEY) throw new Error('APIFY_API_KEY is not configured')
  const actor = encodeURIComponent(actorId.replace('/', '~'))
  const run = await http.post(`https://api.apify.com/v2/acts/${actor}/runs`, input, { params: { token: config.APIFY_API_KEY, waitForFinish: 300 } })
  const datasetId = run.data?.data?.defaultDatasetId
  if (!datasetId) throw new Error(`Apify actor ${actorId} did not return a dataset`)
  const dataset = await http.get(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`, { params: { token: config.APIFY_API_KEY, clean: true, format: 'json' } })
  return Array.isArray(dataset.data) ? dataset.data : []
}

const instagramPrimary: Provider = {
  id: 'instagram-internal',
  async profile(url) {
    if (!config.INSTAGRAM_SCRAPER_BASE_URL) throw new Error('INSTAGRAM_SCRAPER_BASE_URL is not configured')
    const item: any = payload(await http.post(`${config.INSTAGRAM_SCRAPER_BASE_URL}/instagram/profile`, { url }))
    return { externalId: String(item.fbid ?? item.id ?? item.username), username: str(item.username), name: str(item.fullName), description: str(item.biography), profileImageUrl: str(item.profilePicUrlHD ?? item.profilePicUrl), followersCount: num(item.followersCount), followingCount: num(item.followsCount), postsCount: num(item.postsCount), verified: item.verified ?? null, raw: item }
  },
  async posts(url, _profile, input) {
    const items: any[] = payload(await http.post(`${config.INSTAGRAM_SCRAPER_BASE_URL}/instagram/posts`, { url, onlyPostsNewerThan: formatLocalScraperDate(input.startDate!), skipPinnedPosts: input.skipPinnedPosts, resultsLimit: input.postLimit })) ?? []
    return items.map((item) => {
      const duration = num(item.videoDuration) || null
      const isVideo = String(item.type).toLowerCase() === 'video'
      const media = isVideo ? [{ type: 'video' as const, url: item.videoUrl ?? item.audioUrl }].filter((m) => m.url) : [{ type: 'image' as const, url: item.displayUrl }].filter((m) => m.url)
      return { externalId: String(item.id), url: item.url, contentType: isVideo ? 'video' : 'image', title: null, description: str(item.caption), publishedAt: str(item.timestamp), durationSeconds: duration, likesCount: num(item.likesCount), commentsCount: num(item.commentsCount), sharesCount: 0, viewsCount: num(item.viewsCount ?? item.videoViewCount ?? item.videoPlayCount), conversationId: null, hashtags: item.hashtags ?? [], media, raw: item } satisfies NormalizedPost
    }).filter((post) => !post.durationSeconds || post.durationSeconds <= input.maxVideoDurationSeconds)
  },
  async comments(post, limit) {
    const items: any[] = payload(await http.post(`${config.INSTAGRAM_SCRAPER_BASE_URL}/instagram/comments`, { urls: [post.url], resultsLimit: limit })) ?? []
    return items.map((item) => ({ externalId: String(item.id), text: String(item.text ?? '').trim(), authorId: str(item.owner?.id), authorName: str(item.owner?.full_name), authorUsername: str(item.ownerUsername ?? item.owner?.username), likesCount: num(item.likesCount), repliesCount: num(item.repliesCount), publishedAt: str(item.timestamp), raw: item })).filter((item) => item.text)
  }
}

const instagramFallback: Provider = {
  id: 'apify-instagram',
  async profile(url) {
    const item = (await apifyItems('apify/instagram-scraper', { directUrls: [url], resultsType: 'details', resultsLimit: 1 }))[0]
    if (!item) throw new Error('Instagram profile not found')
    return { externalId: String(item.id ?? item.fbid ?? item.username), username: str(item.username), name: str(item.fullName), description: str(item.biography), profileImageUrl: str(item.profilePicUrlHD ?? item.profilePicUrl), followersCount: num(item.followersCount), followingCount: num(item.followsCount), postsCount: num(item.postsCount), verified: item.verified ?? null, raw: item }
  },
  async posts(url, _profile, input) {
    const items = await apifyItems('apify/instagram-scraper', { directUrls: [url], resultsType: 'posts', resultsLimit: input.postLimit, onlyPostsNewerThan: input.startDate })
    return items.map((item: any) => ({ externalId: String(item.id), url: item.url, contentType: item.type === 'Video' ? 'video' as const : 'image' as const, title: null, description: str(item.caption), publishedAt: str(item.timestamp), durationSeconds: num(item.videoDuration) || null, likesCount: num(item.likesCount), commentsCount: num(item.commentsCount), sharesCount: 0, viewsCount: num(item.videoViewCount ?? item.videoPlayCount), conversationId: null, hashtags: item.hashtags ?? [], media: [{ type: item.type === 'Video' ? 'video' as const : 'image' as const, url: item.videoUrl ?? item.displayUrl }].filter((m) => m.url), raw: item } satisfies NormalizedPost)).filter((post) => !post.durationSeconds || post.durationSeconds <= input.maxVideoDurationSeconds)
  },
  async comments(post, limit) {
    const items = await apifyItems('apify/instagram-comment-scraper', { directUrls: [post.url], resultsLimit: limit })
    return items.map((item: any) => ({ externalId: String(item.id), text: String(item.text ?? '').trim(), authorId: str(item.owner?.id), authorName: str(item.owner?.full_name), authorUsername: str(item.ownerUsername ?? item.owner?.username), likesCount: num(item.likesCount), repliesCount: num(item.repliesCount), publishedAt: str(item.timestamp), raw: item })).filter((item) => item.text)
  }
}

const facebookPrimary: Provider = {
  id: 'facebook-internal',
  async profile(url) {
    if (!config.FACEBOOK_SCRAPER_BASE_URL) throw new Error('FACEBOOK_SCRAPER_BASE_URL is not configured')
    const raw: any = payload(await http.get(`${config.FACEBOOK_SCRAPER_BASE_URL}/facebook/profile`, { params: { urls: url, resultsLimit: 1 } }))
    const item = Array.isArray(raw) ? raw[0] : raw
    if (!item) throw new Error('Facebook profile not found')
    return { externalId: String(item.facebookId ?? item.pageId), username: str(item.pageName), name: str(item.title), description: str(item.intro), profileImageUrl: str(item.profilePictureUrl), followersCount: num(item.followers), followingCount: num(item.followings), postsCount: 0, verified: null, raw: item }
  },
  async posts(url, _profile, input) {
    const items: any[] = payload(await http.get(`${config.FACEBOOK_SCRAPER_BASE_URL}/facebook/posts`, { params: { url, onlyPostsNewerThan: formatLocalScraperDate(input.startDate!), resultsLimit: input.postLimit } })) ?? []
    return items.map((item) => {
      const mediaItem = item.media?.[0]
      const duration = num(mediaItem?.playable_duration_in_ms) / 1000 || null
      const videoUrl = mediaItem?.asset_url ?? mediaItem?.videoDeliveryLegacyFields?.browser_native_hd_url ?? mediaItem?.videoDeliveryLegacyFields?.browser_native_sd_url
      const imageUrl = mediaItem?.thumbnail ?? mediaItem?.thumbnailImage?.uri
      const externalId = String(item.postId)
      const postUrl = str(item.url ?? item.topLevelUrl) ?? `${url.replace(/\/+$/, '')}/posts/${encodeURIComponent(externalId)}`
      return { externalId, url: postUrl, contentType: videoUrl ? 'video' : imageUrl ? 'image' : 'text', title: null, description: str(item.text), publishedAt: str(item.time), durationSeconds: duration, likesCount: num(item.likes), commentsCount: num(item.comments), sharesCount: num(item.shares), viewsCount: num(item.viewsCount), conversationId: null, hashtags: [], media: [{ type: videoUrl ? 'video' as const : 'image' as const, url: videoUrl ?? imageUrl }].filter((m) => m.url), raw: item } satisfies NormalizedPost
    }).filter((post) => Boolean(post.publishedAt) && (!post.durationSeconds || post.durationSeconds <= input.maxVideoDurationSeconds))
  },
  async comments(post, limit) {
    const items: any[] = payload(await http.post(`${config.FACEBOOK_SCRAPER_BASE_URL}/facebook/comments`, { urls: [post.url], resultsLimit: limit, includeNestedComments: false, viewOption: 'RANKED_UNFILTERED' })) ?? []
    return items.map((item) => ({ externalId: String(item.id ?? `${post.externalId}-${item.profileId}-${item.date}`), text: String(item.text ?? '').trim(), authorId: str(item.profileId), authorName: str(item.profileName), authorUsername: null, likesCount: num(item.likesCount), repliesCount: 0, publishedAt: str(item.date), raw: item })).filter((item) => item.text)
  }
}

const facebookFallback: Provider = {
  id: 'apify-facebook',
  async profile(url) {
    const item = (await apifyItems('apify/facebook-pages-scraper', { startUrls: [{ url }], maxItems: 1 }))[0]
    if (!item) throw new Error('Facebook profile not found')
    return { externalId: String(item.facebookId ?? item.pageId), username: str(item.pageName), name: str(item.title), description: str(item.intro), profileImageUrl: str(item.profilePictureUrl), followersCount: num(item.followers), followingCount: num(item.followings), postsCount: 0, verified: null, raw: item }
  },
  async posts(url, _profile, input) {
    const items = await apifyItems('apify/facebook-posts-scraper', { startUrls: [{ url }], resultsLimit: input.postLimit, onlyPostsNewerThan: input.startDate })
    return items.map((item: any) => {
      const externalId = String(item.postId)
      const postUrl = str(item.url ?? item.topLevelUrl) ?? `${url.replace(/\/+$/, '')}/posts/${encodeURIComponent(externalId)}`
      return { externalId, url: postUrl, contentType: item.media?.some((m: any) => m.__typename?.includes('Video')) ? 'video' as const : item.media?.length ? 'image' as const : 'text' as const, title: null, description: str(item.text), publishedAt: str(item.time), durationSeconds: num(item.media?.[0]?.playable_duration_in_ms) / 1000 || null, likesCount: num(item.likes), commentsCount: num(item.comments), sharesCount: num(item.shares), viewsCount: num(item.viewsCount), conversationId: null, hashtags: [], media: (item.media ?? []).map((m: any) => ({ type: m.__typename?.includes('Video') ? 'video' as const : 'image' as const, url: m.videoDeliveryLegacyFields?.browser_native_hd_url ?? m.thumbnail })).filter((m: any) => m.url), raw: item } satisfies NormalizedPost
    }).filter((post) => Boolean(post.publishedAt) && (!post.durationSeconds || post.durationSeconds <= input.maxVideoDurationSeconds))
  },
  async comments(post, limit) {
    const items = await apifyItems('apify/facebook-comments-scraper', { startUrls: [{ url: post.url }], resultsLimit: limit })
    return items.map((item: any) => ({ externalId: String(item.id ?? `${post.externalId}-${item.profileId}-${item.date}`), text: String(item.text ?? '').trim(), authorId: str(item.profileId), authorName: str(item.profileName), authorUsername: null, likesCount: num(item.likesCount), repliesCount: 0, publishedAt: str(item.date), raw: item })).filter((item) => item.text)
  }
}

const xProvider: Provider = {
  id: 'x-api-v2',
  async profile(url) {
    if (!config.X_SCRAPING_ENABLED) throw new Error('X scraping is disabled; set X_SCRAPING_ENABLED=true in .env and restart the worker to enable it')
    if (!config.X_API_TOKEN) throw new Error('X_API_TOKEN is not configured')
    const username = usernameFromUrl(url)
    const response = await http.get(`https://api.x.com/2/users/by/username/${username}`, { headers: { Authorization: `Bearer ${config.X_API_TOKEN}` }, params: { 'user.fields': 'description,name,profile_image_url,public_metrics,username,verified' } })
    const item = response.data.data
    if (!item) throw new Error('X profile not found')
    return { externalId: item.id, username: item.username, name: item.name, description: str(item.description), profileImageUrl: str(item.profile_image_url), followersCount: num(item.public_metrics?.followers_count), followingCount: num(item.public_metrics?.following_count), postsCount: num(item.public_metrics?.tweet_count), verified: item.verified ?? null, raw: item }
  },
  async posts(_url, profile, input) {
    if (!config.X_SCRAPING_ENABLED) throw new Error('X scraping is disabled; set X_SCRAPING_ENABLED=true in .env and restart the worker to enable it')
    const response = await http.get(`https://api.x.com/2/users/${profile.externalId}/tweets`, { headers: { Authorization: `Bearer ${config.X_API_TOKEN}` }, params: { max_results: Math.max(5, Math.min(input.postLimit, 100)), start_time: input.startDate, end_time: input.endDate, exclude: 'replies,retweets', expansions: 'attachments.media_keys', 'tweet.fields': 'attachments,author_id,conversation_id,created_at,entities,public_metrics,text', 'media.fields': 'duration_ms,media_key,preview_image_url,type,url,variants' } })
    const mediaMap = new Map((response.data.includes?.media ?? []).map((m: any) => [m.media_key, m]))
    return (response.data.data ?? []).map((item: any) => {
      const media: any[] = (item.attachments?.media_keys ?? []).map((key: string) => mediaMap.get(key)).filter(Boolean)
      const videoUrl = bestVideo(media)
      const image = media.find((m) => m.type === 'photo')?.url
      const duration = num(media.find((m) => m.type === 'video')?.duration_ms) / 1000 || null
      return { externalId: item.id, url: `https://x.com/${profile.username}/status/${item.id}`, contentType: videoUrl ? 'video' : image ? 'image' : 'text', title: null, description: str(item.text), publishedAt: item.created_at, durationSeconds: duration, likesCount: num(item.public_metrics?.like_count), commentsCount: num(item.public_metrics?.reply_count), sharesCount: num(item.public_metrics?.retweet_count), viewsCount: num(item.public_metrics?.impression_count), conversationId: str(item.conversation_id), hashtags: (item.entities?.hashtags ?? []).map((h: any) => h.tag), media: [{ type: videoUrl ? 'video' as const : 'image' as const, url: videoUrl ?? image }].filter((m) => m.url), raw: item } satisfies NormalizedPost
    }).filter((post: NormalizedPost) => !post.durationSeconds || post.durationSeconds <= input.maxVideoDurationSeconds)
  },
  async comments(post, limit) {
    if (!config.X_SCRAPING_ENABLED) throw new Error('X scraping is disabled; set X_SCRAPING_ENABLED=true in .env and restart the worker to enable it')
    if (!post.conversationId) return []
    const response = await http.get('https://api.x.com/2/tweets/search/recent', { headers: { Authorization: `Bearer ${config.X_API_TOKEN}` }, params: { query: `conversation_id:${post.conversationId}`, max_results: Math.max(10, Math.min(limit, 100)), expansions: 'author_id', 'tweet.fields': 'author_id,conversation_id,created_at,public_metrics,text', 'user.fields': 'name,username' } })
    const users = new Map((response.data.includes?.users ?? []).map((u: any) => [u.id, u]))
    return (response.data.data ?? []).filter((item: any) => item.id !== post.externalId).map((item: any) => ({ externalId: item.id, text: item.text.trim(), authorId: item.author_id, authorName: str((users.get(item.author_id) as any)?.name), authorUsername: str((users.get(item.author_id) as any)?.username), likesCount: num(item.public_metrics?.like_count), repliesCount: num(item.public_metrics?.reply_count), publishedAt: item.created_at, raw: item }))
  }
}

async function youtubeChannel(url: string): Promise<any> {
  if (!config.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured')
  let params: Record<string, string> = { part: 'id,snippet,statistics,contentDetails', key: config.YOUTUBE_API_KEY }
  if (/^UC[\w-]{20,}$/.test(url)) params.id = url
  else {
    const first = usernameFromUrl(url)
    if (first === 'channel') params.id = new URL(url).pathname.split('/').filter(Boolean)[1]!
    else if (first === 'user') params.forUsername = new URL(url).pathname.split('/').filter(Boolean)[1]!
    else params.forHandle = first
  }
  const response = await http.get('https://www.googleapis.com/youtube/v3/channels', { params })
  return response.data.items?.[0]
}

const youtubeProvider: Provider = {
  id: 'youtube-data-api',
  async profile(url) {
    const item = await youtubeChannel(url)
    if (!item) throw new Error('YouTube channel not found')
    return { externalId: item.id, username: str(item.snippet?.customUrl ?? item.snippet?.title), name: str(item.snippet?.title), description: str(item.snippet?.description), profileImageUrl: str(item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url), followersCount: num(item.statistics?.subscriberCount), followingCount: 0, postsCount: num(item.statistics?.videoCount), verified: null, raw: item }
  },
  async posts(_url, profile, input) {
    const channel = await youtubeChannel(profile.externalId)
    const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads
    if (!playlistId) return []
    const ids: string[] = []
    let pageToken: string | undefined
    let exhausted = false
    while (ids.length < input.postLimit && !exhausted) {
      const list = await http.get('https://www.googleapis.com/youtube/v3/playlistItems', { params: { part: 'snippet', playlistId, maxResults: Math.min(input.postLimit - ids.length, 50), pageToken, key: config.YOUTUBE_API_KEY } })
      const items = list.data.items ?? []
      for (const item of items) {
        const published = Date.parse(item.snippet.publishedAt)
        if (input.startDate && published < Date.parse(input.startDate)) { exhausted = true; break }
        if (!input.endDate || published < Date.parse(input.endDate)) ids.push(item.snippet.resourceId.videoId)
        if (ids.length >= input.postLimit) break
      }
      pageToken = list.data.nextPageToken
      if (!pageToken || !items.length) break
    }
    if (!ids.length) return []
    const videoItems: any[] = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      const videos = await http.get('https://www.googleapis.com/youtube/v3/videos', { params: { part: 'snippet,statistics,contentDetails', id: ids.slice(offset, offset + 50).join(','), key: config.YOUTUBE_API_KEY } })
      videoItems.push(...(videos.data.items ?? []))
    }
    return videoItems.map((item: any) => { const duration = parseDuration(item.contentDetails?.duration); return { externalId: item.id, url: `https://www.youtube.com/watch?v=${item.id}`, contentType: 'video', title: str(item.snippet?.title), description: str(item.snippet?.description), publishedAt: str(item.snippet?.publishedAt), durationSeconds: duration, likesCount: num(item.statistics?.likeCount), commentsCount: num(item.statistics?.commentCount), sharesCount: 0, viewsCount: num(item.statistics?.viewCount), conversationId: null, hashtags: [], media: [{ type: 'video' as const, url: `https://www.youtube.com/watch?v=${item.id}` }, { type: 'image' as const, url: item.snippet?.thumbnails?.maxres?.url ?? item.snippet?.thumbnails?.high?.url }].filter((m) => m.url), raw: item } satisfies NormalizedPost }).filter((post: NormalizedPost) => (!(post.raw as any)?.snippet?.liveBroadcastContent || (post.raw as any).snippet.liveBroadcastContent === 'none') && num(post.durationSeconds) > 0 && num(post.durationSeconds) <= input.maxVideoDurationSeconds)
  },
  async comments(post, limit) {
    const response = await http.get('https://www.googleapis.com/youtube/v3/commentThreads', { params: { part: 'snippet', videoId: post.externalId, textFormat: 'plainText', maxResults: Math.min(limit, 100), key: config.YOUTUBE_API_KEY } })
    return (response.data.items ?? []).map((item: any) => { const c = item.snippet?.topLevelComment; return { externalId: String(c?.id), text: String(c?.snippet?.textOriginal ?? '').trim(), authorId: str(c?.snippet?.authorChannelId?.value), authorName: str(c?.snippet?.authorDisplayName), authorUsername: null, likesCount: num(c?.snippet?.likeCount), repliesCount: num(item.snippet?.totalReplyCount), publishedAt: str(c?.snippet?.publishedAt), raw: item } }).filter((item: NormalizedComment) => item.text)
  },
  async captions(post) {
    if (config.YOUTUBE_SCRAPER_BASE_URL) {
      try {
        const response = await http.get(`${config.YOUTUBE_SCRAPER_BASE_URL}/youtube/media`, { params: { url: post.externalId } })
        const tracks = payload(response)!.captions ?? []
        const text = tracks.find((track: any) => str(track.text))?.text
        if (text) return text.trim()
        logWarn('Local YouTube captions API returned no captions', { postId: post.externalId })
      } catch (error: any) {
        const status = error?.response?.status
        logError('Local YouTube captions API failed', { postId: post.externalId, status: status ?? null, error: error instanceof Error ? error.message : String(error) })
        if (status && [400, 404, 422].includes(status)) return null
      }
    }
    if (!config.APIFY_FALLBACK_ENABLED || !config.APIFY_API_KEY) {
      logWarn('Apify captions fallback unavailable', { postId: post.externalId, enabled: config.APIFY_FALLBACK_ENABLED, hasApiKey: Boolean(config.APIFY_API_KEY) })
      return null
    }
    logApifyFallback('Local YouTube captions unavailable; transferring request to Apify', { postId: post.externalId, reason: config.YOUTUBE_SCRAPER_BASE_URL ? 'local API failed or returned no captions' : 'local API is not configured', fallbackProvider: 'streamers/youtube-scraper' })
    const items = await apifyItems('streamers/youtube-scraper', { startUrls: [{ url: post.url }], maxResults: 1, subtitlesLanguage: 'any' })
    const subtitles = items[0]?.subtitles ?? items[0]?.captions ?? []
    return str(subtitles.find((caption: any) => caption.type === 'auto_generated' && caption.plaintext)?.plaintext)
  }
}

const chains: Record<Platform, Provider[]> = {
  instagram: config.APIFY_FALLBACK_ENABLED ? [instagramPrimary, instagramFallback] : [instagramPrimary],
  facebook: config.APIFY_FALLBACK_ENABLED ? [facebookPrimary, facebookFallback] : [facebookPrimary],
  x: [xProvider],
  youtube: [youtubeProvider]
}
export const providersFor = (platform: Platform) => chains[platform]

export async function withFallback<T>(jobId: string, targetId: string, platform: Platform, capability: keyof Provider, execute: (provider: Provider) => Promise<T>, record: (provider: string, status: string, duration: number, error?: string) => Promise<void>): Promise<T> {
  let last: unknown
  const chain = providersFor(platform)
  for (const [index, provider] of chain.entries()) {
    if (typeof provider[capability] !== 'function') continue
    const started = Date.now()
    try {
      const result = await execute(provider)
      const duration = Date.now() - started
      await record(provider.id, 'success', duration)
      logInfo('Scrape provider succeeded', { jobId, targetId, platform, capability, provider: provider.id, durationMs: duration })
      return result
    }
    catch (error: any) {
      last = error
      const errorMessage = error instanceof Error ? error.message : String(error)
      const status = error?.response?.status
      const nextProvider = chain.slice(index + 1).find((candidate) => typeof candidate[capability] === 'function')
      const responseData = error?.response?.data
      const responseDetails = typeof responseData === 'string' ? responseData.slice(0, 4000) : responseData ?? null
      logError('Scrape provider attempt failed', {
        jobId,
        targetId,
        platform,
        capability,
        provider: provider.id,
        status: status ?? null,
        durationMs: Date.now() - started,
        error: errorMessage,
        request: error?.config ? { method: error.config.method, url: error.config.url, params: error.config.params } : null,
        responseData: responseDetails
      })
      await record(provider.id, 'failed', Date.now() - started, errorMessage)
      if (status && [400, 401, 403, 422].includes(status)) {
        if (nextProvider) logWarn('Provider fallback skipped for non-retryable response', { jobId, targetId, platform, capability, failedProvider: provider.id, fallbackProvider: nextProvider.id, status })
        throw error
      }
      if (nextProvider) {
        const isApifyFallback = provider.id.endsWith('-internal') && nextProvider.id.startsWith('apify-')
        const message = isApifyFallback ? 'Local scraper API failed; transferring request to Apify' : 'Provider failed; trying fallback provider'
        const context = { jobId, targetId, platform, capability, failedProvider: provider.id, fallbackProvider: nextProvider.id, status: status ?? null, error: errorMessage }
        if (isApifyFallback) logApifyFallback(message, context)
        else logWarn(message, context)
      }
    }
  }
  throw last ?? new Error(`No provider supports ${String(capability)}`)
}
