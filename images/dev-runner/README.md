# mke-dev-runner

Imagen genérica del **pod de iteración** (`mke dev`) — el **ÚNICO** runner de
ramas del ecosistema desde la unificación (2026-07-06). Node 22 + git +
`postgresql-client`, sin ENTRYPOINT: el pod inyecta los comandos desde un
ConfigMap (la receta [`@mishicomco/dev-receta`](../../packages/dev-receta)).

Corre la app en **modo dev real**: `tsx watch` para el backend y `vite dev` (HMR)
para el frontend, sobre un clone **completo** del repo. Cambiar de rama / traer
cambios = git dentro del pod (`rama.sh` / `pull.sh`) sin recrear el pod, para que
las ediciones se vean en segundos. La config pública por rama vive en
`k8s/dev.env` del repo de la app (ver la receta).

> El viejo [`rama-runner`](../rama-runner) (front **estático**, una FOTO de la
> rama) está DEPRECADO — ver `packages/rama-receta/DEPRECATED.md`.

```bash
docker build -t mke-dev-runner:node22 images/dev-runner
k3d image import mke-dev-runner:node22 -c mke-preview   # JAMÁS mke-prod
```

`mke dev up` construye e importa la imagen por vos si no está presente.
