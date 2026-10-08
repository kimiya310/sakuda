import { defineEventHandler, getRequestURL, setHeader } from 'h3'
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (path.startsWith('/api/platform/') || path === '/platform' || path.startsWith('/platform/')) {
    setHeader(event, 'cache-control', 'private, no-store')
  }
})
