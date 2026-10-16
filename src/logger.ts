import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type LogLevel = 'INFO' | 'WARN' | 'ERROR'
type LogContext = Record<string, unknown>

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logPath = resolve(projectRoot, 'logs.txt')
const sensitiveKey = /authorization|api.?key|token|secret|password|credential/i

function sanitize(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[redacted]'
  if (value instanceof Error) {
    const details: Record<string, unknown> = {
      name: value.name,
      message: sanitize(value.message),
      stack: sanitize(value.stack ?? ''),
    }
    const error = value as Error & { code?: unknown; cause?: unknown; response?: { status?: unknown; data?: unknown; headers?: unknown }; config?: { method?: unknown; url?: unknown } }
    if (error.code) details.code = sanitize(error.code)
    if (error.cause) details.cause = sanitize(error.cause)
    if (error.response) details.response = sanitize({ status: error.response.status, data: error.response.data })
    if (error.config) details.request = sanitize({ method: error.config.method, url: error.config.url })
    return details
  }
  if (typeof value === 'string') {
    return value
      .replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/((?:token|api[_-]?key|secret|password)\s*[=:]\s*)[^\s&,;]+/gi, '$1[redacted]')
      .replace(/([?&](?:token|key|api[_-]?key|secret|password)=)[^&#\s]+/gi, '$1[redacted]')
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]))
  }
  return value
}

function write(level: LogLevel, message: string, context: LogContext = {}, color?: 'red') {
  const timestamp = new Date().toISOString()
  const details = Object.keys(context).length ? ` ${JSON.stringify(sanitize(context))}` : ''
  const line = `${timestamp} ${level} ${message}${details}`
  const output = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log
  output(color === 'red' ? `\u001b[31m${line}\u001b[0m` : line)
  try {
    appendFileSync(logPath, `${line}\n`, 'utf8')
  } catch (error) {
    console.error(`${timestamp} ERROR Unable to write logs.txt: ${String(sanitize(error))}`)
  }
}

export const logInfo = (message: string, context?: LogContext) => write('INFO', message, context)
export const logWarn = (message: string, context?: LogContext) => write('WARN', message, context)
export const logError = (message: string, context?: LogContext) => write('ERROR', message, context)
export const logApifyFallback = (message: string, context?: LogContext) => write('WARN', message, context, 'red')
