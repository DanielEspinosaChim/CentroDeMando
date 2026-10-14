#!/usr/bin/env python3
"""Trazabilidad spec → test: cada criterio de aceptación tiene al menos un test.

Lee los criterios numerados de la sección "## Criterios de aceptación" de cada
spec/features/NNN-*/spec.md y les asigna un ID: C<NNN>-<n> (ej. C001-3).
Busca esos IDs en los archivos de tests (nombre del test, docstring o
comentario; sirve para Python, TypeScript o cualquier lenguaje).

Solo exige cobertura en features ya en implementación (su tasks.md tiene al
menos una tarea marcada [x]); las features que solo están especificadas se
listan como pendientes sin fallar.

Uso:
  python scripts/trazabilidad.py            # reporte en consola
  python scripts/trazabilidad.py --check    # falla (exit 1) si falta algún test
  python scripts/trazabilidad.py --escribir # además genera docs/trazabilidad.md
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
FEATURES = RAIZ / "spec" / "features"
PATRONES_TESTS = (
    "tests/**/*.py",
    "test/**/*.py",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.test.js",
    "**/*.spec.js",
    "**/test_*.py",
    "**/*_test.py",
)
IGNORAR = ("node_modules", ".venv", ".git", "site-packages", ".claude")
ID_RE = re.compile(r"\bC(\d{3})-(\d+)\b")
CRITERIO_RE = re.compile(r"^\s*(\d+)\.\s+\S")


def criterios(spec: Path) -> list[int]:
    """Números de los criterios listados bajo '## Criterios de aceptación'."""
    dentro, nums = False, []
    for linea in spec.read_text(encoding="utf-8").splitlines():
        if linea.startswith("## "):
            dentro = "criterios de aceptación" in linea.lower()
            continue
        m = CRITERIO_RE.match(linea) if dentro else None
        if m:
            nums.append(int(m.group(1)))
    return nums


def en_implementacion(carpeta: Path) -> bool:
    tasks = carpeta / "tasks.md"
    return (
        tasks.exists()
        and re.search(
            r"^\s*- \[x\]",
            tasks.read_text(encoding="utf-8"),
            re.MULTILINE | re.IGNORECASE,
        )
        is not None
    )


def ids_en_tests() -> dict[str, list[str]]:
    encontrados: dict[str, list[str]] = {}
    vistos: set[Path] = set()
    for patron in PATRONES_TESTS:
        for archivo in RAIZ.glob(patron):
            if (
                archivo in vistos
                or any(p in archivo.parts for p in IGNORAR)
                or not archivo.is_file()
            ):
                continue
            vistos.add(archivo)
            for m in ID_RE.finditer(
                archivo.read_text(encoding="utf-8", errors="ignore")
            ):
                encontrados.setdefault(m.group(0), []).append(
                    str(archivo.relative_to(RAIZ))
                )
    return encontrados


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit 1 si falta un test en una feature en implementación",
    )
    ap.add_argument(
        "--escribir", action="store_true", help="genera docs/trazabilidad.md"
    )
    args = ap.parse_args()

    if not FEATURES.exists():
        print("No hay spec/features/; nada que trazar.")
        return 0

    en_tests = ids_en_tests()
    filas, faltan_activos = [], []
    for carpeta in sorted(p for p in FEATURES.iterdir() if p.is_dir()):
        num = carpeta.name[:3]
        spec = carpeta / "spec.md"
        if not num.isdigit() or num == "000" or not spec.exists():
            continue
        activa = en_implementacion(carpeta)
        for n in criterios(spec):
            cid = f"C{num}-{n}"
            archivos = sorted(set(en_tests.get(cid, [])))
            estado = (
                "cubierto" if archivos else ("FALTA TEST" if activa else "pendiente")
            )
            filas.append((cid, carpeta.name, estado, ", ".join(archivos) or "—"))
            if activa and not archivos:
                faltan_activos.append(cid)

    cubiertos = sum(1 for f in filas if f[2] == "cubierto")
    resumen = (
        f"Criterios: {len(filas)} · cubiertos: {cubiertos} · "
        f"sin test en features activas: {len(faltan_activos)}"
    )
    print(resumen)
    for cid, feat, estado, _ in filas:
        if estado != "cubierto":
            print(f"  {estado:10} {cid}  ({feat})")

    if args.escribir:
        destino = RAIZ / "docs" / "trazabilidad.md"
        destino.parent.mkdir(exist_ok=True)
        lineas = [
            "# Trazabilidad spec → test",
            "",
            "Generado por `scripts/trazabilidad.py`; no editar a mano.",
            "CI falla si está desactualizado.",
            "",
            resumen,
            "",
            "| Criterio | Feature | Estado | Tests |",
            "|---|---|---|---|",
            *[f"| {c} | {f} | {e} | {t} |" for c, f, e, t in filas],
            "",
        ]
        destino.write_text("\n".join(lineas), encoding="utf-8")
        print(f"Escrito {destino.relative_to(RAIZ)}")

    if args.check and faltan_activos:
        print(
            "Agrega un test por criterio con su ID (ej. C001-3) en el nombre o docstring."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
