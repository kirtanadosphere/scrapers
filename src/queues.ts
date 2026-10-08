import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { config } from './config.js'

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
redis.on('error', (error) => console.error('Redis connection error:', error.message))
export const queueNames = {
  orchestrate: 'orchestrate', profile: 'profile', posts: 'posts', comments: 'comments', media: 'media', captions: 'captions',
  precheck: 'video-precheck', transcription: 'transcription', ocr: 'ocr', callback: 'callback', cleanup: 'cleanup'
} as const
export type QueueName = typeof queueNames[keyof typeof queueNames]
const queues = new Map<string, Queue>()
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name)
  if (!queue) {
    queue = new Queue(name, { connection: redis, prefix: config.QUEUE_PREFIX, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } })
    queues.set(name, queue)
  }
  return queue
}
