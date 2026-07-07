# mke-rama-runner — DEPRECADO

> **DEPRECADO (unificación 2026-07-06).** El "pod de rama" EFÍMERO (front
> estático, una FOTO) murió como concepto. El ÚNICO mecanismo de rama es el pod
> de ITERACIÓN de [`dev-runner`](../dev-runner) (`mke dev`); `mke rama` es hoy una
> fachada de `mke dev`. Detalle y plan de migración de Studio:
> `packages/rama-receta/DEPRECATED.md`. Esta imagen se conserva solo mientras
> Studio vendoriza la receta vieja.

Imagen genérica del **pod de rama** de Mishi Studio v2 (verbo `mke rama`). Una sola
imagen para TODAS las apps: NO se construye una imagen por rama. El pod clona la
rama en el arranque, instala, construye el front y corre el backend.

Contiene: Node LTS (22) + `git` + `postgresql-client` (para `pg_isready`).

## Build + import (manual)

```bash
docker build -t mke-rama-runner:node22 images/rama-runner
k3d image import mke-rama-runner:node22 -c mke-preview   # clúster de ramas, NUNCA mke-prod
```

`mke rama up` verifica que la imagen esté importada en el clúster y, si falta, la
construye e importa automáticamente. Rebuild solo cuando cambie este Dockerfile
(p.ej. subir la versión de Node); el ciclo de vida de las ramas no la toca.
