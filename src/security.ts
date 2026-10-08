import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'

export function apiKey(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header('x-api-key') ?? ''
  const valid = supplied.length === config.API_KEY.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(config.API_KEY))
  if (!valid) return res.status(401).json({ error: 'unauthorized' })
  next()
}

export const hmac = (secret: string, timestamp: string, body: string) => crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
export function verifySignature(timestamp: string | undefined, signature: string | undefined, body: string): boolean {
  if (!timestamp || !signature || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return false
  const expected = hmac(config.ENRICHMENT_WEBHOOK_SECRET, timestamp, body)
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
