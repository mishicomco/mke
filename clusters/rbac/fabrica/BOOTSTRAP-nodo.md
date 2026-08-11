# Bootstrap de un nodo de la fábrica de CI desde cero

Cierra el hueco de reproducibilidad hallado en la prueba de fuego (2026-08-11): los
units ya están versionados (`README.md`), pero levantar el HOST desde limpio
—usuario `mke-ci`, rootless, las 4 credenciales, el runner— era solo prosa. Aquí
están los comandos EXACTOS (los que se corrieron al construir la fábrica), en orden.

> **Dos escenarios distintos:**
> - **Reinstalar un nodo EXISTENTE** (gamer o laptop): las identidades de plataforma
>   (`mke-runner-deploy`, `mke-ci-lector`, SA `mke-deploy`) YA existen y se REUSAN —
>   solo re-colocas sus tokens en el HOME (vía vault/GPG). NO acuñes nuevas.
> - **Nodo NUEVO** (una tercera máquina): además hay que acuñar identidades y crear
>   variantes `.service` nuevas (uid/PATH propios). Marcado como ⓝ abajo.

## Parámetros por nodo

| | gamer (stage) | laptop (prod) |
|---|---|---|
| uid/gid de `mke-ci` | 1001 | 1002 |
| base subuid/subgid | 165536 | 231072 |
| `DOCKER_HOST` | `unix:///run/user/1001/docker.sock` | `unix:///run/user/1002/docker.sock` |
| Node | `/opt/node/bin` (instalado aparte) | Node del sistema |
| contexto kube | `k3d-mke-gamer` | local del laptop |
| ns BD / apps | `databases-dev` / `stage` | `databases` / `prod` |
| `mke-nodo.json` | `registries.stage` | `envsLocales:["prod"]` + `registries.prod` |

`UID` abajo = 1001 (gamer) o 1002 (laptop). Todo como root salvo lo marcado `sudo -u mke-ci`.

## Fase A — usuario + docker rootless (mecánico)

```sh
apt-get install -y uidmap slirp4netns            # docker-ce-rootless-extras ya suele estar
useradd -m -s /bin/bash mke-ci && chmod 700 /home/mke-ci && usermod -L mke-ci
echo "mke-ci:<BASE>:65536" >> /etc/subuid        # BASE = 165536 gamer / 231072 laptop
echo "mke-ci:<BASE>:65536" >> /etc/subgid
loginctl enable-linger mke-ci
# rootless daemon + registry por IP del bridge (rootless NO ve localhost del host):
sudo -u mke-ci env XDG_RUNTIME_DIR=/run/user/<UID> HOME=/home/mke-ci sh -c '
  mkdir -p ~/.config/docker
  printf "%s" "{\"insecure-registries\":[\"172.17.0.1:5111\"]}" > ~/.config/docker/daemon.json
  dockerd-rootless-setuptool.sh install
  systemctl --user start docker'
# verificar: docker info | grep rootless   (Storage Driver overlayfs, rootless)
```
Gamer también: instalar Node en `/opt/node` (`tar -xJf node-v24.*-linux-x64.tar.xz -C /opt && ln -sfn /opt/node-v24.* /opt/node`).

## Fase B — clone de mke + shim

```sh
sudo -u mke-ci git config --global credential.helper store       # usa ~/.git-credentials (Fase C)
sudo -u mke-ci git clone http://git.mishi.com.co/mishicomco/mke.git /home/mke-ci/mke
cd /home/mke-ci/mke/cli && sudo -u mke-ci env HOME=/home/mke-ci npm ci
# shim /home/mke-ci/.local/bin/mke: exporta PATH(+/opt/node/bin en gamer)+DOCKER_HOST,
#   sourcea ~/.config/mishi/ci.env, cd cli, exec node --import tsx src/mke.ts "$@"
```

## Fase C — las 4 credenciales scoped (los VALORES vienen de fuera)

Ninguna vive en el repo (correcto). Origen de cada una:

1. **`~/.kube/config`** = token del SA `mke-deploy` (aplicar antes el RBAC, Fase E).
   Extraer y armar el kubeconfig — ver `RUNBOOK-hallazgo0.md` §"kubeconfig del SA":
   ```sh
   SA_TOKEN="$(kubectl -n mke-ci get secret mke-deploy-token -o jsonpath='{.data.token}' | base64 -d)"
   CA="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
   SRV="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')"
   # escribir ~mke-ci/.kube/config (0600) con cluster{server:$SRV,ca-data:$CA} user{token:$SA_TOKEN}
   ```
2. **`~/.config/mishi/vault-mke.token`** = identidad `mke-runner-deploy`. Reinstalar nodo
   existente: copiar el token de un backup / re-emitir. ⓝ Nodo nuevo: acuñar con
   `scripts/crear-identidad-vault-nodo.sh` (**requiere el store GPG offline
   `~/.config/mishi/secrets/` con `vault-root-token` — en el host privilegiado de Santi,
   NUNCA en `mke-ci`**).
3. **`~/.config/mishi/ci.env`** (0600) = `CLOUDFLARE_DNS_API` + `NODE_AUTH_TOKEN`, ambos del
   vault por pipe (no imprimir): `{ printf 'CLOUDFLARE_DNS_API=%s\n' "$(vault-mishi get
   cloudflare-dns-api)"; printf 'NODE_AUTH_TOKEN=%s\n' "$(vault-mishi get git-mishi-npm-token)"; }
   > ci.env` (desde el host privilegiado; `chown mke-ci` + `chmod 600`).
4. **`~/.git-credentials`** (0600) = `http://mke-ci-lector:<TOKEN>@git.mishi.com.co`, con
   `TOKEN = vault-mishi get git-mishi-lector-token`. ⓝ Si el usuario `mke-ci-lector` no
   existiera, crearlo en el forge (usuario restringido + collab read en `mke` + token
   `read:repository`) con el admin `mishi:$(vault-mishi get git-mishi-admin)`.

Y **`~/.config/mishi/mke-nodo.json`** (contenido literal en la tabla de arriba: push por
`172.17.0.1:5111`, ref `k3d-registry-mishi:5111`).

## Fase D — runner de Forgejo

```sh
# binario (mismo release en ambos nodos; v12.13.1 al construir la fábrica):
#   descargar de code.forgejo.org/forgejo/runner releases → ~mke-ci/forgejo-runner/forgejo-runner (0755)
# registrar cada runner contra el forge (token de registro desde la UI/API del forge):
sudo -u mke-ci ~mke-ci/forgejo-runner/forgejo-runner register --no-interactive \
  --instance http://git.mishi.com.co --token <REG_TOKEN> \
  --name <pc-gamer-mke|laptop-mke> --labels self-hosted:host,mke:host,mke-<stage|prod>:host
# (repetir para el runner -2). Genera el .runner en cada dir prod/ y prod-2/.
# cache propio por runner (dos daemons mismo HOME chocan en ~/.cache/actcache):
for n in prod prod-2; do printf 'cache:\n  enabled: true\n  dir: /home/mke-ci/forgejo-runner/%s/actcache\n' "$n" \
  > ~mke-ci/forgejo-runner/$n/config.yml; done
```

## Fase E — RBAC del cluster (una vez, humano con admin)

Aplicar en el cluster de ESTE nodo: `mke-deploy-sa.yaml`, `emisor-access.yaml`,
`mke-deploy-app-namespaces{,-prod}.yaml`, `mke-deploy-databases{,-prod}.yaml` (variantes
`-prod` para el laptop). Debe ir **antes** de la Fase C1 (el `mke-deploy-token` tiene que
existir para extraerlo). Orden exacto: `RUNBOOK-hallazgo0.md` y `RUNBOOK-emisor.md`.

## Fase F — units + arranque

Ver `README.md` §"Re-bootstrap" (install de los `.service`/`.timer` + `mke-ci-actualizar`,
`daemon-reload`, `enable --now mke-ci-sync.timer`, `restart forgejo-runner-prod{,-2}`).

## Verificación final

Un `mke deploy <app> stage --dir <checkout>` (o un push real) bajo `mke-ci` debe salir VERDE
end-to-end. `auth can-i`: NO secrets cluster-wide/kube-system, SÍ deployments del ns del
ambiente + exec en el ns de BD. `mke-ci` NO lee `~santi`/`~mishi`, `/root`, ni el socket rootful.
