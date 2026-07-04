# Imagen GENÉRICA del "pod de rama" (diseño "Ramas en el harness v2" de Studio).
#
# NO hay imagen por rama: esta única imagen clona la rama EN EL ARRANQUE del pod
# (git), instala (npm) y construye el front, y corre el backend. Node LTS + git +
# cliente de postgres (pg_isready, para esperar al sidecar). Sirve tanto al
# initContainer (clone+install+build) como al contenedor del backend (migrate+
# seed+dev). El front estático lo sirve un contenedor caddy aparte, mismo origen.
#
# Build + import al clúster de ramas (mke-preview; JAMÁS mke-prod):
#   docker build -t mke-rama-runner:node22 images/rama-runner
#   k3d image import mke-rama-runner:node22 -c mke-preview
#
# El CLI `mke rama up` hace esto por vos si la imagen no está importada.

FROM node:22-bookworm-slim

# git para clonar la rama; postgresql-client para pg_isready; ca-certificates
# para el clone https y npm registry.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# corre como el usuario `node` (no root); el emptyDir /workspace se comparte
# entre el initContainer y los contenedores del pod.
USER node
WORKDIR /workspace

# Sin ENTRYPOINT/CMD propios: el manifiesto del pod inyecta el comando
# (prepare.sh en el init, boot-backend.sh en el backend) desde un ConfigMap.
