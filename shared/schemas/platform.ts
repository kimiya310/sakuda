import { z } from 'zod'

const lines = z.string().trim().max(16000)
const ports = z.array(z.number().int().min(1).max(65535)).min(1).max(32)
export const PlatformInputSchema = z
  .object({
    profile: z.literal('sales-tcp-v1').default('sales-tcp-v1'),
    customer: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    targets: lines.min(1),
    exclusions: lines.default(''),
    ports,
    redisPorts: z.array(z.number().int().min(1).max(65535)).max(32).default([]),
    tlsPorts: z.array(z.number().int().min(1).max(65535)).max(32).default([443]),
    location: z.enum(['external', 'lan', 'vpn']),
    concurrency: z.number().int().min(1).max(4).default(2),
    connectionsPerSecond: z.number().int().min(1).max(5).default(2),
    timeoutSeconds: z.number().int().min(1).max(10).default(3),
    maxMinutes: z.number().int().min(1).max(30).default(5),
  })
  .refine((v) => v.tlsPorts.every((p) => v.ports.includes(p)), {
    path: ['tlsPorts'],
    message: 'TLS ports must be in the selected TCP ports',
  })
  .refine((v) => v.redisPorts.every((p) => v.ports.includes(p)), {
    path: ['redisPorts'],
    message: 'Approved Redis ports must be selected TCP ports',
  })
export type PlatformInput = z.infer<typeof PlatformInputSchema>
export const PlatformStartSchema = z
  .object({
    expectedHostCount: z.number().int().min(1).max(256),
    scopeToken: z.string().length(64),
    administrator: z.string().trim().min(1).max(120),
    authorizationReference: z.string().trim().min(1).max(500),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    permissionConfirmed: z.literal(true),
    segmentsConfirmed: z.literal(true),
  })
  .refine((v) => Date.parse(v.windowEnd) > Date.parse(v.windowStart), {
    path: ['windowEnd'],
    message: 'Window end must be after start',
  })
export type PlatformStart = z.infer<typeof PlatformStartSchema>
export const PlatformReviewSchema = z.object({
  reviewer: z.string().trim().min(1).max(120),
  notes: z.string().trim().min(1).max(4000),
  nextSupport: z.string().trim().min(1).max(4000),
})
export type PlatformReviewInput = z.infer<typeof PlatformReviewSchema>
