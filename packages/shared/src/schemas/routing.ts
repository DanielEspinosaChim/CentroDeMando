import { z } from 'zod'

// Enums del enrutador sin dependencias, para que `agent.ts` (Run) y `router.ts` los compartan
// sin importación circular.

export const TaskSize = z.enum(['small', 'medium', 'large', 'unknown'])
export type TaskSize = z.infer<typeof TaskSize>

export const RiskLevel = z.enum(['normal', 'high'])
export type RiskLevel = z.infer<typeof RiskLevel>

export const RoutingSource = z.enum(['rule', 'role_default', 'override', 'escalation'])
export type RoutingSource = z.infer<typeof RoutingSource>
