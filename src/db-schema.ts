import { bigint, boolean, jsonb, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey(), name: text('name').notNull(), description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const feeds = pgTable('feeds', {
  id: uuid('id').primaryKey(), sourceId: uuid('source_id').notNull().references(() => sources.id), platform: text('platform').notNull(),
  url: text('url').notNull(), urlVerificationStatus: text('url_verification_status').notNull(), isActive: boolean('is_active').notNull(),
  name: text('name'), username: text('username'), about: text('about'), externalId: text('external_id'), profilePicture: text('profile_picture'),
  followersCount: bigint('followers_count', { mode: 'number' }), contentCount: bigint('content_count', { mode: 'number' }),
  followsCount: bigint('follows_count', { mode: 'number' }), isVerifiedAccount: boolean('is_verified_account'), profileRaw: jsonb('profile_raw')
}, (table) => [unique('feeds_source_platform_unique').on(table.sourceId, table.platform)])

export const contents = pgTable('contents', {
  id: uuid('id').primaryKey(), sourceId: uuid('source_id').notNull().references(() => sources.id), feedId: uuid('feed_id').notNull().references(() => feeds.id),
  status: text('status').notNull(), platform: text('platform').notNull(), type: text('type').notNull(), externalId: text('external_id').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(), url: text('url').notNull(), thumbnailUrl: text('thumbnail_url'),
  hashtags: text('hashtags').array().notNull(), rawTitle: text('raw_title'), rawDescription: text('raw_description'), title: text('title'),
  description: text('description'), transcript: text('transcript'), imageOcrText: text('image_ocr_text'), durationSeconds: real('duration_seconds'),
  likesCount: bigint('likes_count', { mode: 'number' }), commentsCount: bigint('comments_count', { mode: 'number' }),
  sharesCount: bigint('shares_count', { mode: 'number' }), viewsCount: bigint('views_count', { mode: 'number' }), engagementRate: real('engagement_rate'),
  providerRaw: jsonb('provider_raw')
})

export const contentComments = pgTable('content_comments', {
  id: uuid('id').primaryKey(), contentId: uuid('content_id').notNull().references(() => contents.id), text: text('text').notNull(),
  likesCount: bigint('likes_count', { mode: 'number' }).notNull(), repliesCount: bigint('replies_count', { mode: 'number' }).notNull(),
  ownerExternalId: text('owner_external_id'), ownerName: text('owner_name'), ownerUsername: text('owner_username'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull()
})
