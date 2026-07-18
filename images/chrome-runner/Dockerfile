# Runner de preview CON NAVEGADOR — `mke-chrome-runner` (hermana de dev-runner).
#
# Para apps cuya función ES un navegador (chrome-mishi): el runner genérico no
# trae Chrome, así que un pod preview no puede examinar lo único que la app hace.
# Esta imagen = dev-runner (node22 + git + psql) + el stack gráfico de stage:
#   xvfb (display virtual), x11vnc (VNC de ese display), novnc/websockify
#   (VNC-sobre-websocket → viaja por el túnel cloudflared como HTTP puro),
#   google-chrome-stable (Chrome REAL: playwright-core no descarga navegadores).
#
# La app la declara en su mke.preview.yaml (`imagen: mke-chrome-runner:node22`)
# y arranca Xvfb/x11vnc/noVNC con su hook `k8s/preview-boot.sh`.
#
# Build + import al clúster de preview (JAMÁS mke-prod):
#   docker build -t mke-chrome-runner:node22 images/chrome-runner
#   k3d image import mke-chrome-runner:node22 -c mke-preview

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates postgresql-client \
      xvfb x11vnc novnc websockify \
      wget gnupg \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && apt-get purge -y wget gnupg \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/google-chrome-stable

USER node
WORKDIR /workspace

# Sin ENTRYPOINT/CMD: el manifiesto inyecta el comando (prepare.sh / boot-preview.sh).
