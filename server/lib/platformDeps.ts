import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client'
export function platformDeps() {
  return { db: getDb(), now: () => new Date(), id: randomUUID }
}
