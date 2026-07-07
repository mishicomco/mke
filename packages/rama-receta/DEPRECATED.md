# DEPRECADO — `@mishicomco/rama-receta`

**Unificación FIRMADA por Santi, 2026-07-06.** El ecosistema tiene UN SOLO
mecanismo de pods de rama: el **pod de ITERACIÓN DURADERO** de `mke dev`
(receta `@mishicomco/dev-receta`). El "pod de rama" EFÍMERO que genera esta
receta — front **estático** (`npm run build`) + caddy sirviendo `dist`, una FOTO
de la rama — **murió como concepto**.

## Por qué murió

- Iterar sobre una FOTO estática es lento (rebuild por cambio) y no es dev real.
  `mke dev` corre la app en **modo dev real** (vite dev HMR + tsx watch) y cambia
  de rama con `git` DENTRO del pod, sin recrear el pod.
- La **fidelidad de build** de una rama (que compile como en producción) la cubre
  el **examen de STAGE post-merge**, no un segundo pod que la duplique.
- Dos mecanismos = dos superficies que divergen. El incidente que forzó la
  unificación (una rama sin `VITE_CONNECT_URL`/`VITE_GOOGLE_CLIENT_ID`, y
  re-aplicar `up` borrando envs) se arregló SOLO en `dev` con el contrato
  `k8s/dev.env`; mantener `rama` en paralelo lo habría dejado a medias.

## Qué reemplaza a qué

| Antes (`mke rama` / esta receta)        | Ahora (`mke dev` / `@mishicomco/dev-receta`)        |
|-----------------------------------------|-----------------------------------------------------|
| pod EFÍMERO por rama, front estático    | pod DURADERO por app, vite dev HMR + tsx watch      |
| cambiar de rama = recrear el pod        | `mke dev rama` = git checkout dentro del pod        |
| config por rama: N/A                    | `k8s/dev.env` (config pública) + `--env` (override) |
| `mke rama up <app> <rama>`              | `mke dev up <app> <rama> --live` (fachada lo hace)  |

`mke rama up/down/ls` sigue existiendo como **fachada** que delega en `mke dev`
(imprime una línea de deprecación). Ver `cli/src/rama.ts` y `mke rama --help`.

## Por qué NO se borra este paquete

**Mishi Studio lo VENDORIZA** (copia el generador de manifiestos en su propio
código) para encender ramas server-side. Borrarlo rompería a Studio hasta que
migre su vendorizado a `@mishicomco/dev-receta`.

### Qué migrará Studio

- Reemplazar el import/vendor de `manifiestosRama(...)` por `manifiestosDev(...)`
  de `@mishicomco/dev-receta` (pod DURADERO, no efímero).
- El examen server-side de una rama corre CONTRA el dev-pod (host
  `<app>-dev-feat.mishi.com.co`), leyendo su estado de las
  labels/annotations `mke.dev/*` (app, rama activa, sha VIVO, `mke.dev/live`).
- Config pública por rama: declararla en `k8s/dev.env` del repo de la app (no
  inyectarla desde Studio). Secretos: contrato RAMA_ENCENDIDA / futuros leases de
  vault-mishi.

Cuando Studio termine de migrar, este paquete puede eliminarse.
