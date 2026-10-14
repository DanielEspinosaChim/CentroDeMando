import type { FastifyInstance } from 'fastify'
import type { EventHub } from '../events/hub.ts'
import { isWsTokenValid, WS_PATH, WS_UNAUTHORIZED_CLOSE_CODE } from '../security/guards.ts'

/**
 * WebSocket de eventos. El token va en el subprotocolo `cdm.<token>`; sin token
 * válido se acepta el upgrade y se cierra de inmediato con 4401 para que el
 * cliente reciba un código claro. Los mensajes entrantes se ignoran.
 */
export function wsRoutes(app: FastifyInstance, hub: EventHub, token: string): void {
  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    if (!isWsTokenValid(request, token)) {
      socket.close(WS_UNAUTHORIZED_CLOSE_CODE, 'unauthorized')
      return
    }
    const unsubscribe = hub.subscribe(request.workspaceId, (event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
    })
    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
  })
}
