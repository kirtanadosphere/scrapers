export function formatLocalScraperDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid scraper date: ${value}`)
  return date.toISOString().slice(0, 19)
}
