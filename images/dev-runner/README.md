# mke-dev-runner

Imagen genérica del **pod de iteración** (`mke dev`) — la hermana de
[`rama-runner`](../rama-runner). Node 22 + git + `postgresql-client`, sin
ENTRYPOINT: el pod inyecta los comandos desde un ConfigMap (la receta
[`@mishicomco/dev-receta`](../../packages/dev-receta)).

A diferencia de `rama-runner` (que construye el front **estático** y sirve una
FOTO de la rama), este runner corre la app en **modo dev real**: `tsx watch` para
el backend y `vite dev` (HMR) para el frontend, sobre un clone **completo** del
repo. Cambiar de rama / traer cambios = git dentro del pod (`rama.sh` / `pull.sh`)
sin recrear el pod, para que las ediciones se vean en segundos.

```bash
docker build -t mke-dev-runner:node22 images/dev-runner
k3d image import mke-dev-runner:node22 -c mke-preview   # JAMÁS mke-prod
```

`mke dev up` construye e importa la imagen por vos si no está presente.
