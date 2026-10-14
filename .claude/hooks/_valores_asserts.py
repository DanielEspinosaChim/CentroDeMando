"""Ayudante de test-weakening-guard.sh: ¿se quitó o cambió algún valor esperado?

Lee de las variables de entorno OLD y NEW el texto antes y después de la
edición, toma las líneas con assert/expect y compara los literales (números y
strings) que aparecen en ellas. Imprime 1 si algún valor esperado del texto
viejo ya no está en el nuevo; 0 si no.
"""

import os
import re

ASSERT = re.compile(
    r"(^|[^a-zA-Z_])assert[ (]|self\.assert[A-Z]|pytest\.raises|expect\(|assert\.|"
    r"toThrow|toEqual|toBe\("
)
LITERAL = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])|\"[^\"\n]*\"|'[^'\n]*'")


def valores(texto: str) -> list[str]:
    encontrados: list[str] = []
    for linea in texto.splitlines():
        if ASSERT.search(linea):
            encontrados.extend(LITERAL.findall(linea))
    return encontrados


viejos = valores(os.environ.get("OLD", ""))
nuevos = valores(os.environ.get("NEW", ""))
print(1 if any(v not in nuevos for v in viejos) else 0)
