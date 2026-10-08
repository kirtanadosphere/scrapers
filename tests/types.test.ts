import { describe, expect, it } from 'vitest'
import { formatLocalScraperDate } from '../src/provider-utils.js'
import { CreateJobSchema, detectPlatform } from '../src/types.js'

describe('local scraper date formatting', () => {
  it('uses the timestamp format required by the Instagram and Facebook scrapers', () => {
    expect(formatLocalScraperDate('2026-10-03T09:33:07.2275024Z')).toBe('2026-10-03T09:33:07')
  })

  it('normalizes offsets to UTC before removing the timezone suffix', () => {
    expect(formatLocalScraperDate('2026-10-03T15:03:07+05:30')).toBe('2026-10-03T09:33:07')
  })
})

describe('platform detection', () => {
  it.each([
    ['https://instagram.com/example', 'instagram'],
    ['https://facebook.com/example', 'facebook'],
    ['https://x.com/example', 'x'],
    ['https://twitter.com/example', 'x'],
    ['https://youtube.com/@example', 'youtube'],
    ['UCabcdefghijklmnopqrstuv', 'youtube']
  ])('detects %s', (url, expected) => expect(detectPlatform(url)).toBe(expected))

  it('rejects unsupported hosts', () => expect(() => detectPlatform('https://example.com/me')).toThrow())
})

describe('job request validation', () => {
  it('applies safe defaults', () => {
    const before = Date.now()
    const value = CreateJobSchema.parse({ source: { name: 'OpenAI' }, feeds: [{ url: 'https://x.com/openai' }] })
    expect(value).toMatchObject({ postLimit: 100, includeComments: false, commentLimit: 100, maxVideoDurationSeconds: 180, ocr: false, transcription: false })
    expect(Date.parse(value.endDate!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(value.endDate!) - Date.parse(value.startDate!)).toBe(24 * 60 * 60 * 1000)
  })

  it('rejects inverted date ranges', () => {
    expect(() => CreateJobSchema.parse({ source: { name: 'OpenAI' }, feeds: [{ url: 'https://x.com/openai' }], startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-01-01T00:00:00.000Z' })).toThrow()
  })

  it('requires HTTPS callbacks', () => {
    expect(() => CreateJobSchema.parse({ source: { name: 'OpenAI' }, feeds: [{ url: 'https://x.com/openai' }], callbackUrl: 'http://example.com/callback' })).toThrow()
  })

  it('allows at most one feed of each platform per source', () => {
    expect(() => CreateJobSchema.parse({ source: { name: 'OpenAI' }, feeds: [{ url: 'https://x.com/openai' }, { url: 'https://x.com/example' }] })).toThrow()
  })
})
