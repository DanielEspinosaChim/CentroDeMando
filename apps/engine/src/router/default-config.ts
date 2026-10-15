import { DEFAULT_MODEL_BY_ROLE, type RouterConfig } from '@cdm/shared'

/**
 * Palabras de riesgo que el motor aplica siempre, además de las de la configuración.
 * No se pueden quitar desde `router-config.json`: así el piso de riesgo (nada que toque
 * credenciales, pagos o permisos baja de sonnet) no se desactiva por configuración.
 * Se comparan normalizadas (sin acentos, minúsculas) y por subcadena, sin borde de palabra
 * (ver `findRiskKeyword`): "auth" cubre "oauth", "authorization" o "CLAUDE_CODE_OAUTH_TOKEN";
 * "autenticacion" va aparte porque no contiene "auth". Los falsos positivos ("apagar"
 * contiene "pagar", "author" contiene "auth", "enclave" contiene "clave") se aceptan porque
 * solo suben la tarea a sonnet.
 */
export const CORE_RISK_KEYWORDS: readonly string[] = [
  'contraseña',
  'password',
  'passwd',
  'clave',
  'token',
  'secret',
  'secreto',
  'credencial',
  'credential',
  '.env',
  'api key',
  'apikey',
  'api_key',
  'llave privada',
  'private key',
  'ssh',
  'certificado',
  'certificate',
  'cookie',
  'jwt',
  'auth',
  'autenticacion',
  'pago',
  'pagar',
  'payment',
  'cobrar',
  'stripe',
  'permiso',
  'permission',
]

/** Configuración por defecto (se usa si no existe `router-config.json`). */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  roleDefaults: { ...DEFAULT_MODEL_BY_ROLE },
  smallKeywords: [
    'color',
    'texto',
    'typo',
    'errata',
    'ortografia',
    'renombrar',
    'renombra',
    'rename',
    'copy',
    'margen',
    'margin',
    'padding',
    'espaciado',
    'icono',
    'icon',
    'font',
    'etiqueta',
    'label',
    'comentario',
    'comment',
    'tooltip',
    'placeholder',
  ],
  largeKeywords: [
    'arquitectura',
    'architecture',
    'diseña el modulo',
    'diseñar el modulo',
    'diseña un modulo',
    'diseñar un modulo',
    'diseñar modulo',
    'modulo nuevo',
    'nuevo modulo',
    'design the module',
    'new module',
    'refactor',
    'migracion',
    'migration',
    'migrate',
    'desde cero',
    'from scratch',
    'rediseño',
    'redesign',
  ],
  riskKeywords: [
    ...CORE_RISK_KEYWORDS,
    'login',
    'oauth',
    'cifrado',
    'encryption',
    'tarjeta',
    'credit card',
    'factura',
    'billing',
    'cobro',
    'rol de usuario',
  ],
  smallMaxChars: 200,
  escalateAfterFailures: 2,
}
