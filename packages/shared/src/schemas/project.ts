import { z } from 'zod'
import { Id } from './agent.ts'

export const CreateProjectInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(1024),
})
export type CreateProjectInput = z.infer<typeof CreateProjectInput>

export const Project = z.object({
  id: Id,
  workspaceId: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.number().int(),
})
export type Project = z.infer<typeof Project>
