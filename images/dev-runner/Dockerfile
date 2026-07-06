# Imagen GENÉRICA del "pod de iteración" (`mke dev`) — HERMANA de rama-runner.
#
# NO hay imagen por app: esta única imagen clona el repo EN EL ARRANQUE del pod
# (git, clone COMPLETO para poder cambiar de rama después), instala (npm) y corre
# la app en MODO DEV REAL: backend con tsx watch y frontend con vite dev (HMR).
# Node LTS + git + cliente de postgres (psql/pg_isready, para esperar al sidecar
# y resetear la DB efímera en cada cambio de rama). Sirve al initContainer
# (clone+install), al contenedor dev (reset+migra+siembra+watch) y a los exec de
# rama/pull. El proxy del host público → vite lo hace un contenedor caddy aparte.
#
# Build + import al clúster de dev (mke-preview; JAMÁS mke-prod):
#   docker build -t mke-dev-runner:node22 images/dev-runner
#   k3d image import mke-dev-runner:node22 -c mke-preview
#
# El CLI `mke dev up` hace esto por vos si la imagen no está importada.

FROM node:22-bookworm-slim

# git para clonar/cambiar de rama; postgresql-client para pg_isready + psql (reset
# de la DB efímera); ca-certificates para el clone https y el registry de npm.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# corre como el usuario `node` (no root); el emptyDir /workspace se comparte
# entre el initContainer y el contenedor dev.
USER node
WORKDIR /workspace

# Sin ENTRYPOINT/CMD propios: el manifiesto del pod inyecta el comando
# (prepare.sh en el init, boot-dev.sh en el contenedor dev) desde un ConfigMap.
