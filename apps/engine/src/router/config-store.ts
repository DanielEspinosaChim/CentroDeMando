import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RouterConfig } from '@cdm/shared'
import { hasAmbiguousWin32Segment, isUncPath } from '../projects/paths.ts'
import { DEFAULT_ROUTER_CONFIG } from './default-config.ts'

export const ROUTER_CONFIG_FILE_NAME = 'router-config.json'
/** Tope de lectura: una config válida ocupa unas decenas de KB. */
const MAX_CONFIG_BYTES = 256 * 1024

/** Fuente de la configuración vigente del enrutador. */
export interface RouterConfigSource {
  get(): RouterConfig
}

export interface RouterConfigStore extends RouterConfigSource {
  /** Valida, guarda en disco y deja vigente la nueva configuración. Devuelve la guardada. */
  set(config: unknown): RouterConfig
}

function clone(config: RouterConfig): RouterConfig {
  return structuredClone(config)
}

/** Fuente fija (tests y `AgentManager` sin config store). */
export function staticRouterConfig(
  config: RouterConfig = DEFAULT_ROUTER_CONFIG,
): RouterConfigSource {
  const frozen = clone(config)
  return { get: () => clone(frozen) }
}

export interface RouterConfigStoreOptions {
  /** Aviso si el archivo existe pero no es válido (se usan los valores por defecto). */
  onWarning?: (message: string) => void
}

/**
 * Comprueba la carpeta de datos solo por texto, antes de cualquier llamada al disco:
 * con una ruta UNC (`\\servidor\recurso`) un simple `stat` hace que Windows intente
 * conectarse al servidor (lento y, si es hostil, filtra el hash NTLM). `loadConfig` ya la
 * rechaza al arrancar; esto cubre a quien cree el store con otra ruta.
 */
function assertLocalDataDir(dataDir: string): void {
  const resolved = path.resolve(dataDir)
  for (const p of [dataDir, resolved]) {
    if (isUncPath(p) || hasAmbiguousWin32Segment(p)) {
      throw new Error('Carpeta de datos no válida para la configuración del enrutador')
    }
  }
}

/**
 * Lee `router-config.json` de la carpeta de datos (que ya tiene la ACL privada del motor).
 * El nombre del archivo es fijo, así que nunca se sale de `dataDir`; un enlace simbólico
 * en su lugar no se sigue. Si no existe, se usan los valores por defecto sin crear el
 * archivo. Si existe pero no es válido, se avisa y se usan los valores por defecto: el
 * motor no se cae por un archivo editado a mano, y el piso de riesgo no depende de este
 * archivo.
 *
 * `set` recibe datos sin validar (el cuerpo del PUT ya pasó por `parseInput`, pero se
 * vuelve a validar aquí para que nada inválido llegue al disco) y escribe de forma atómica
 * (archivo temporal + `rename`) para no dejar un JSON a medias.
 */
export function createRouterConfigStore(
  dataDir: string,
  opts: RouterConfigStoreOptions = {},
): RouterConfigStore {
  assertLocalDataDir(dataDir)
  const dir = path.resolve(dataDir)
  const file = path.join(dir, ROUTER_CONFIG_FILE_NAME)
  const invalid = () => {
    opts.onWarning?.(`${ROUTER_CONFIG_FILE_NAME} no es válido; se usan los valores por defecto`)
    return clone(DEFAULT_ROUTER_CONFIG)
  }
  let current = load()

  function load(): RouterConfig {
    let raw: string
    try {
      // `lstat`: un enlace simbólico no es un archivo y no se sigue.
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return invalid()
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.onWarning?.(
          `No se pudo leer ${ROUTER_CONFIG_FILE_NAME}; se usan los valores por defecto`,
        )
      }
      return clone(DEFAULT_ROUTER_CONFIG)
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return invalid()
    }
    const parsed = RouterConfig.safeParse(json)
    return parsed.success ? parsed.data : invalid()
  }

  return {
    get: () => clone(current),
    set(input: unknown): RouterConfig {
      const config = RouterConfig.parse(input)
      fs.mkdirSync(dir, { recursive: true })
      // Nombre aleatorio y creación exclusiva (`wx`): si ya existe algo con ese nombre (un
      // archivo o un enlace puesto ahí), se falla en vez de escribir a través de él.
      const tmp = path.join(
        dir,
        `${ROUTER_CONFIG_FILE_NAME}.${randomBytes(12).toString('hex')}.tmp`,
      )
      let created = false
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        created = true
        // `rename` reemplaza la entrada del directorio (aunque fuera un enlace): no escribe
        // a través de él.
        fs.renameSync(tmp, file)
      } catch (err) {
        // Solo se borra el temporal propio: si `wx` falló, el archivo que estaba no es nuestro.
        if (created) fs.rmSync(tmp, { force: true })
        throw err
      }
      current = config
      return clone(current)
    },
  }
}
