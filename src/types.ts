import { z } from 'zod'

export const PlatformSchema = z.enum(['instagram', 'facebook', 'x', 'youtube'])
export type Platform = z.infer<typeof PlatformSchema>

export const CreateJobSchema = z.object({
  source: z.union([
    z.object({ id: z.string().uuid() }),
    z.object({ name: z.string().trim().min(1).max(250), description: z.string().trim().max(2000).optional() })
  ]),
  feeds: z.array(z.object({ url: z.string().min(1), platform: PlatformSchema.optional() })).min(1).max(4),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  postLimit: z.number().int().min(1).max(200).default(100),
  includeComments: z.boolean().default(false),
  commentLimit: z.number().int().min(1).max(100).default(100),
  skipPinnedPosts: z.boolean().default(true),
  maxVideoDurationSeconds: z.number().int().positive().max(86400).default(180),
  ocr: z.boolean().default(false),
  transcription: z.boolean().default(false),
  callbackUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'callbackUrl must use HTTPS').optional()
}).superRefine((value, ctx) => {
  if (value.startDate && value.endDate && Date.parse(value.startDate) >= Date.parse(value.endDate)) {
    ctx.addIssue({ code: 'custom', message: 'startDate must be before endDate', path: ['startDate'] })
  }
  const platforms = value.feeds.map((feed) => feed.platform ?? detectPlatform(feed.url))
  if (new Set(platforms).size !== platforms.length) ctx.addIssue({ code: 'custom', message: 'A source can have only one feed per platform', path: ['feeds'] })
}).transform((value) => {
  if (value.startDate || value.endDate) return value
  const end = new Date()
  return {
    ...value,
    startDate: new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    endDate: end.toISOString()
  }
})
export type CreateJobInput = z.infer<typeof CreateJobSchema>

export type NormalizedProfile = {
  externalId: string
  username: string | null
  name: string | null
  description: string | null
  profileImageUrl: string | null
  followersCount: number
  followingCount: number
  postsCount: number
  verified: boolean | null
  raw?: unknown
}

export type NormalizedMedia = {
  type: 'image' | 'video' | 'audio'
  url: string
  mimeType?: string | null
}

export type NormalizedPost = {
  externalId: string
  url: string
  contentType: 'text' | 'image' | 'video'
  title: string | null
  description: string | null
  publishedAt: string | null
  durationSeconds: number | null
  likesCount: number
  commentsCount: number
  sharesCount: number
  viewsCount: number
  conversationId: string | null
  hashtags: string[]
  media: NormalizedMedia[]
  raw?: unknown
}

export type NormalizedComment = {
  externalId: string
  text: string
  authorId: string | null
  authorName: string | null
  authorUsername: string | null
  likesCount: number
  repliesCount: number
  publishedAt: string | null
  raw?: unknown
}

export type Provider = {
  id: string
  profile(url: string): Promise<NormalizedProfile>
  posts(url: string, profile: NormalizedProfile, input: CreateJobInput): Promise<NormalizedPost[]>
  comments(post: NormalizedPost, limit: number): Promise<NormalizedComment[]>
  captions?(post: NormalizedPost): Promise<string | null>
}

export function detectPlatform(value: string): Platform {
  let host = ''
  try { host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase() } catch { /* handled below */ }
  if (host.includes('instagram.com')) return 'instagram'
  if (host.includes('facebook.com') || host === 'fb.com') return 'facebook'
  if (host === 'x.com' || host.endsWith('.x.com') || host.includes('twitter.com')) return 'x'
  if (host.includes('youtube.com') || host === 'youtu.be' || /^UC[\w-]{20,}$/.test(value)) return 'youtube'
  throw new Error(`Unable to determine platform for ${value}`)
}
