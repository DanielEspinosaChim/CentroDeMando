import type { EngineEvent } from '@cdm/shared'

export type EventListener = (event: EngineEvent) => void

/** Pub/sub en memoria, separado por workspace. */
export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>()

  subscribe(workspaceId: string, listener: EventListener): () => void {
    let set = this.listeners.get(workspaceId)
    if (!set) {
      set = new Set()
      this.listeners.set(workspaceId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(workspaceId)
    }
  }

  publish(workspaceId: string, event: EngineEvent): void {
    const set = this.listeners.get(workspaceId)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch {
        // Un suscriptor roto no debe tumbar a los demás.
      }
    }
  }

  listenerCount(workspaceId: string): number {
    return this.listeners.get(workspaceId)?.size ?? 0
  }
}
