import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'

export function apiKey(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header('x-api-key') ?? ''
  const valid = supplied.length === config.API_KEY.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(config.API_KEY))
  if (!valid) return res.status(401).json({ error: 'unauthorized' })
  next()
}

export function bullBoardAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header('authorization') ?? ''
  const [scheme, encoded] = authorization.split(/\s+/, 2)
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    const [username, ...passwordParts] = Buffer.from(encoded, 'base64').toString('utf8').split(':')
    const password = passwordParts.join(':')
    const expectedPassword = config.BULL_BOARD_PASSWORD || config.API_KEY
    const usernameMatches = username?.length === config.BULL_BOARD_USERNAME.length && crypto.timingSafeEqual(Buffer.from(username), Buffer.from(config.BULL_BOARD_USERNAME))
    const passwordMatches = password.length === expectedPassword.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expectedPassword))
    if (usernameMatches && passwordMatches) return next()
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"')
  return res.status(401).send('Authentication required')
}

export const hmac = (secret: string, timestamp: string, body: string) => crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
export function verifySignature(timestamp: string | undefined, signature: string | undefined, body: string): boolean {
  if (!timestamp || !signature || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return false
  const expected = hmac(config.ENRICHMENT_WEBHOOK_SECRET, timestamp, body)
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
