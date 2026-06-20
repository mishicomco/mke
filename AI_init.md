# Mishi Kubernetes Engine (MKE) — Guía de instalación e inicialización

> Documento de arranque del **Mishi Kubernetes Engine**: un Kubernetes propio, portable y
> consistente para desplegar tus apps **en local** y **al mundo**.
>
> Estado actual: **foco en `Mishi-Local`** (tu laptop con WSL2). Los niveles `Mishi-Home`
> y `Mishi-Cloud` quedan diseñados pero se implementan después.

---

## 0. TL;DR (para impacientes)

```bash
# 1. Herramientas (dentro de WSL2)
#    docker, kubectl, helm, k3d, cloudflared  (ver §3)

# 2. Crear el clúster local
k3d cluster create mke \
  --servers 1 --agents 2 \
  --port "80:80@loadbalancer" \
  --port "443:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"   # instalamos Traefik nosotros (versionado)

# 3. Componentes base
helm repo add traefik https://traefik.github.io/charts && helm repo update
kubectl create namespace ingress
helm install traefik traefik/traefik -n ingress

# 4. Túnel a Internet (Cloudflare) -> ver §6
#    *.mishi.com.co  ->  cloudflared (in-cluster)  ->  Traefik  ->  tu app

# 5. Desplegar -> ver §7
```

Si ya sabes lo que haces, salta a §4. El resto del documento explica **por qué** cada decisión,
para que el diseño escale a tus tres niveles sin reescribir nada.

---

## 1. Filosofía y arquitectura de MKE

MKE no es "un clúster", es **un mismo sabor de Kubernetes replicado en tres entornos**, de forma
que un `Deployment` que funciona en tu laptop funcione igual en casa y en la nube cambiando solo
configuración, nunca el modelo mental.

| Nivel | Dónde | Distribución | Estado | Uso |
|-------|-------|--------------|--------|-----|
| **Mishi-Local** | Laptop, WSL2 | `k3d` (k3s en Docker) | ⭐ Ahora | Dev, pruebas efímeras, iterar rápido |
| **Mishi-Home** | PC 24/7, WSL2 | `k3s` nativo | Después | Staging, servicios "siempre encendidos", builds pesados |
| **Mishi-Cloud** | GCP / Oracle Cloud | `k3s` en VM (Terraform) o GKE/OKE | Futuro | Producción, alta disponibilidad |

### 1.1 Por qué k3s como hilo conductor

Eres usuario avanzado, así que la justificación va directo:

- **Mismo binario, mismo comportamiento en los 3 niveles.** `k3d` literalmente corre k3s dentro
  de contenedores Docker; en casa corres k3s nativo; en la nube corres k3s en una VM o GKE/OKE
  (que son k8s "puros" compatibles). El API y los manifiestos son idénticos.
- **Ligero y rápido en WSL2.** k3s arranca en segundos, consume poca RAM y no pelea con el
  scheduler de Windows. Ideal para una laptop.
- **Baterías incluidas, pero desmontables.** Trae Traefik (ingress), ServiceLB (LoadBalancer
  vía klipper), local-path-provisioner (PVCs), CoreDNS y metrics-server. Puedes desactivar lo
  que quieras versionar tú (lo hacemos con Traefik en §0/§4).
- **CNCF-conformant.** No es un fork raro: es Kubernetes certificado, solo empaquetado distinto.

**Alternativas que descarté para tu caso (y por qué):**

- `minikube`: pensado para un nodo único de dev; multi-nodo es torpe y el driver en WSL2 da más
  fricción que k3d.
- `kind`: excelente para CI, pero su LoadBalancer y storage son menos "production-like" que k3s;
  además k3s te da continuidad directa con Home/Cloud.
- `microk8s`: usa snap, que en WSL2 es problemático (systemd/snapd). Evítalo aquí.
- `Docker Desktop K8s`: caja negra de un nodo, difícil de versionar y de replicar en casa/nube.

> **Recomendación:** estandariza en **k3s/k3d**. Es la decisión que menos te hará reescribir
> cuando subas a Home y Cloud.

### 1.2 Diagrama lógico (los 3 niveles, mismo patrón)

```
                       Internet  (usuarios, tú compartiendo links)
                          │
                          ▼
              ┌───────────────────────────┐
              │   Cloudflare (free tier)   │   *.mishi.com.co  -> Tunnel
              │   DNS + TLS + Tunnel edge  │   (sin abrir puertos, sin IP pública)
              └───────────────────────────┘
                          │ (conexión saliente del cluster)
        ┌─────────────────┼──────────────────────────────┐
        ▼                 ▼                               ▼
  Mishi-Local       Mishi-Home                       Mishi-Cloud
  (k3d, laptop)     (k3s, PC casa)                   (k3s/GKE, Terraform)
        │                 │                               │
        ▼                 ▼                               ▼
   cloudflared        cloudflared                     cloudflared
   (Deployment)       (Deployment)                    (Deployment)
        │                 │                               │
        ▼                 ▼                               ▼
     Traefik           Traefik                         Traefik
   (Ingress ctrl)    (Ingress ctrl)                  (Ingress ctrl)
        │                 │                               │
        ▼                 ▼                               ▼
   tus apps          tus apps                        tus apps
   (web + DB)        (web + DB)                      (web + DB)
```

La pieza clave: **cloudflared corre *dentro* del clúster**. El clúster abre una conexión
**saliente** a Cloudflare; no necesitas IP pública, port-forwarding, ni configurar tu router.
Funciona detrás de NAT/CGNAT, que es justo el caso de una laptop y de muchos ISP residenciales.

---

## 2. Convenciones del proyecto MKE

Para que los tres niveles sean intercambiables, fijamos convenciones desde el día 1:

- **Nombre del clúster:** `mke` (local), `mke-home`, `mke-cloud`.
- **Contextos kubectl:** `k3d-mke`, `mke-home`, `mke-cloud`. Usa [`kubectx`](https://github.com/ahmetb/kubectx) para saltar entre ellos.
- **Dominios:**
  - Local interno: `*.mke.localhost` (resuelve a 127.0.0.1) o `*.127.0.0.1.sslip.io`.
  - Público: `*.mishi.com.co` (vía Cloudflare Tunnel).
- **Namespaces:** uno por app/proyecto (`app-foo`, `app-bar`); infraestructura en `ingress`,
  `cloudflare`, `cert-manager`, `monitoring`.
- **Todo es declarativo y vive en Git.** Nada de `kubectl edit` a mano en algo que quieras
  conservar. Ver §8 (GitOps).
- **Separación clave (¡importante!):** **Terraform** gestiona la frontera con proveedores/nube
  (Cloudflare ahora; VMs GCP/Oracle después). **Kustomize/Helm** (luego GitOps) gestiona lo que
  vive *dentro* del clúster (Traefik, cloudflared, apps). No metas workloads en Terraform. Ver §6.5.
- **Estructura del repo (raíz = `MKE/`):**

  ```
  MKE/                              # raíz del proyecto Mishi Kubernetes Engine
  ├── AI_init.md                    # este documento
  ├── AI_handoff.md                 # bitácora entre sesiones
  ├── AI_todo.md                    # tablero de tareas
  ├── .gitignore                    # ignora tfstate, *.tfvars, kubeconfig...
  ├── clusters/
  │   ├── _modules/
  │   │   └── cloudflare-tunnel/    # módulo Terraform reutilizable (Local/Home/Cloud)
  │   ├── local/
  │   │   ├── k3d.yaml              # definición del clúster k3d
  │   │   ├── traefik-values.yaml   # values de Helm para Traefik
  │   │   └── terraform/            # capa Cloudflare de Mishi-Local (usa el módulo)
  │   ├── home/                     # Mishi-Home (después)
  │   └── cloud/
  │       └── terraform/            # Mishi-Cloud — esqueleto/plan (futuro)
  ├── platform/                     # componentes base in-cluster
  │   └── cloudflared/deployment.yaml
  └── apps/                         # tus aplicaciones (web + db)
  ```

---

## 3. Prerrequisitos (Mishi-Local, WSL2)

### 3.1 WSL2 saludable

Estás en `WSL2`. Verifica y, si puedes, habilita systemd y limita recursos.

```bash
# En PowerShell de Windows:
wsl --version            # WSL >= 1.2 para soporte de systemd
wsl --update
```

`/etc/wsl.conf` (dentro de WSL) — habilita systemd (útil para k3s nativo en Home; en local con
k3d no es estrictamente necesario, pero lo dejamos consistente):

```ini
[boot]
systemd=true
```

`C:\Users\<tú>\.wslconfig` (en Windows) — ponle techo de RAM/CPU para que Docker+k3d no se coman
la máquina:

```ini
[wsl2]
memory=8GB        # ajusta a tu laptop (deja headroom para Windows)
processors=4
swap=2GB
```

Reinicia WSL tras cambios: `wsl --shutdown` en PowerShell.

### 3.2 Docker

`k3d` necesita un Docker funcional dentro de WSL2. Dos caminos:

- **Opción A — Docker Desktop** (con integración WSL2 activada). Más simple si ya lo usas.
- **Opción B — Docker Engine nativo en WSL2** (recomendado para evitar la capa de Docker
  Desktop y para parecerse a Home):

  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER     # re-loguéate o: newgrp docker
  # Con systemd activo:
  sudo systemctl enable --now docker
  docker run --rm hello-world       # smoke test
  ```

### 3.3 CLIs

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl

# k3d
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# cloudflared (para crear/gestionar el túnel)
# Debian/Ubuntu:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb && rm cloudflared.deb

# Calidad de vida (opcional pero recomendado)
sudo apt install -y kubectx kubens   # o instala kubectx/kubens desde su repo
```

Verifica versiones:

```bash
docker version && k3d version && kubectl version --client && helm version && cloudflared --version
```

---

## 4. Crear el clúster `Mishi-Local`

### 4.1 Definición declarativa del clúster

En vez de un comando largo, declara el clúster en un archivo (versionable en
`clusters/local/k3d.yaml`):

```yaml
# clusters/local/k3d.yaml
apiVersion: k3d.io/v1alpha5
kind: Simple
metadata:
  name: mke
servers: 1
agents: 2
ports:
  - port: "80:80"
    nodeFilters: [loadbalancer]
  - port: "443:443"
    nodeFilters: [loadbalancer]
options:
  k3s:
    extraArgs:
      # Desactivamos el Traefik que trae k3s para instalar el nuestro (versionado vía Helm).
      - arg: "--disable=traefik"
        nodeFilters: [server:*]
      # Desactivamos servicelb solo si vas a usar otro LB; en local lo dejamos.
  kubeconfig:
    updateDefaultKubeconfig: true
    switchCurrentContext: true
```

Crear:

```bash
k3d cluster create --config clusters/local/k3d.yaml
kubectl config use-context k3d-mke
kubectl get nodes -o wide
```

Deberías ver 1 server + 2 agents `Ready`.

### 4.2 Storage persistente (para tus bases de datos)

k3s ya trae `local-path-provisioner` como **StorageClass por defecto**. Verifica:

```bash
kubectl get storageclass
# NAME                   PROVISIONER             ...
# local-path (default)   rancher.io/local-path   ...
```

> ⚠️ **Importante en WSL2 / k3d:** los PVCs `local-path` viven dentro del contenedor del nodo.
> Si borras el clúster (`k3d cluster delete`), **se pierden los datos**. Para datos que quieras
> conservar entre recreaciones del clúster, monta un volumen del host en el nodo k3d
> (`--volume /home/santi/mke-data:/var/lib/rancher/k3s/storage@all`) o, mejor, trata las DBs
> locales como **efímeras** y haz backups lógicos (`pg_dump`) con un CronJob. En Home/Cloud
> usarás storage real (longhorn, discos persistentes).

### 4.3 Ingress: Traefik versionado por ti

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
kubectl create namespace ingress

# clusters/local/traefik-values.yaml
cat > clusters/local/traefik-values.yaml <<'EOF'
ingressClass:
  enabled: true
  isDefaultClass: true
service:
  type: LoadBalancer          # k3d/servicelb mapea a los puertos 80/443 del host
ports:
  web:
    port: 8000
    expose: { default: true }
    exposedPort: 80
  websecure:
    port: 8443
    expose: { default: true }
    exposedPort: 443
providers:
  kubernetesIngress:
    enabled: true
  kubernetesCRD:
    enabled: true             # habilita IngressRoute si lo prefieres
EOF

helm install traefik traefik/traefik -n ingress -f clusters/local/traefik-values.yaml
kubectl get svc -n ingress traefik
```

Prueba rápida con una app de juguete y un host local (`whoami`):

```bash
kubectl create deployment whoami --image=traefik/whoami
kubectl expose deployment whoami --port=80
kubectl create ingress whoami --class=traefik \
  --rule="whoami.127.0.0.1.sslip.io/*=whoami:80"

curl http://whoami.127.0.0.1.sslip.io   # sslip.io resuelve *.127.0.0.1 a 127.0.0.1
```

Si responde, ya tienes **ingress local funcionando**. (`sslip.io`/`nip.io` te evitan tocar
`/etc/hosts` para cada subdominio.)

---

## 5. (Opcional) TLS local con cert-manager

Para tráfico público **no lo necesitas**: Cloudflare termina TLS en su edge (§6). Pero si quieres
HTTPS también en local o certificados propios para servicios internos:

```bash
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true
```

Para local basta un `ClusterIssuer` self-signed; para Cloud usarás `ACME/Let's Encrypt` con el
`DNS-01` solver de Cloudflare. Lo dejamos preparado pero **no es prioridad para Mishi-Local**.

---

## 6. Exponer al mundo: Cloudflare Tunnel (free tier) → `*.mishi.com.co`

Este es tu caso de uso estrella: **levantar un servicio y compartir un subdominio en segundos**,
sin abrir puertos ni exponer tu IP. El patrón:

```
*.mishi.com.co  ──DNS CNAME──▶  <tunnel>.cfargotunnel.com
       (Cloudflare edge, TLS aquí)
              │  túnel cifrado saliente
              ▼
   cloudflared (Deployment en el clúster)
              │  http://traefik.ingress.svc:80   (Host header preservado)
              ▼
        Traefik  ──▶  Ingress de tu app  ──▶  Pod
```

> 🟢 **Recomendado: hazlo con Terraform (§6.5).** Todo lo de §6.1–§6.3 (crear túnel, ruta
> wildcard, DNS, e incluso el Secret en el clúster) está automatizado en
> `clusters/local/terraform`. Lo de abajo es el equivalente manual, útil para entender qué pasa.

### 6.1 Crear el túnel (una sola vez) — manual

```bash
cloudflared tunnel login                      # abre el navegador, elige la zona mishi.com.co
cloudflared tunnel create mke-local           # crea el túnel y un credentials json
cloudflared tunnel list                        # anota el TUNNEL_ID
```

Tienes dos modos. Para "rápido y versionable", usa el **token de túnel** (remotely-managed) y deja
que el ingress lo resuelva Traefik por Host:

```bash
# Obtén el token del túnel (string largo) desde el dashboard de Cloudflare:
# Zero Trust -> Networks -> Tunnels -> mke-local -> Configure -> Token
# Guárdalo como secreto:
kubectl create namespace cloudflare
kubectl create secret generic tunnel-token -n cloudflare \
  --from-literal=token='<PEGA_AQUI_EL_TOKEN>'
```

### 6.2 Desplegar `cloudflared` en el clúster

```yaml
# platform/cloudflared/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: cloudflare
spec:
  replicas: 2                      # HA del túnel; en local puedes dejar 1
  selector: { matchLabels: { app: cloudflared } }
  template:
    metadata: { labels: { app: cloudflared } }
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args:
            - tunnel
            - --no-autoupdate
            - --metrics
            - 0.0.0.0:2000
            - run
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef: { name: tunnel-token, key: token }
          livenessProbe:
            httpGet: { path: /ready, port: 2000 }
            initialDelaySeconds: 10
            periodSeconds: 10
```

```bash
kubectl apply -f platform/cloudflared/deployment.yaml
kubectl -n cloudflare get pods    # deben quedar Running
```

### 6.3 Ruteo: un wildcard y listo

En el dashboard de Cloudflare (Zero Trust → Tunnels → `mke-local` → **Public Hostnames**),
añade **una** ruta comodín:

| Hostname | Service |
|----------|---------|
| `*.mishi.com.co` | `http://traefik.ingress.svc.cluster.local:80` |

Esto crea automáticamente el DNS y manda **todo** `*.mishi.com.co` al Traefik del clúster.
A partir de aquí, **publicar una app nueva = crear un Ingress** con su Host; no vuelves a tocar
Cloudflare.

> **Nota sobre el wildcard:** Cloudflare cubre `*.mishi.com.co` (un nivel). El TLS del edge
> también es de un nivel salvo que tengas Advanced Certificate Manager. Para subdominios simples
> de testing (`foo.mishi.com.co`) funciona perfecto en free tier.

### 6.4 Publicar una app por su Host

```bash
kubectl create ingress whoami -n default --class=traefik \
  --rule="whoami.mishi.com.co/*=whoami:80"
# Visita https://whoami.mishi.com.co  -> Cloudflare TLS -> túnel -> Traefik -> pod
```

Tiempo de "idea a URL pública compartible": **segundos**. Justo lo que pediste.

### 6.5 Infraestructura como código: el túnel con Terraform (recomendado)

Todo lo manual de §6.1–§6.3 (clicks en el dashboard) está codificado y versionado. Terraform
gestiona la **frontera con Cloudflare**; Kustomize/Helm gestiona lo de dentro del clúster. El
único puente es que Terraform, como *crea* el túnel y produce su token, también crea el `Secret`
`tunnel-token` en el clúster — así no copias/pegas secretos.

**Qué crea** (`clusters/local/terraform`, vía el módulo reutilizable `_modules/cloudflare-tunnel`):

- El túnel `mke-local` (remotely-managed).
- La regla de ingress `*.mishi.com.co → http://traefik.ingress.svc.cluster.local:80`.
- El registro DNS wildcard (CNAME proxied → `<tunnel-id>.cfargotunnel.com`).
- (Opcional, `create_k8s_secret=true`) el namespace `cloudflare` + Secret `tunnel-token`.

**Provider:** `cloudflare/cloudflare ~> 5.0`. Ojo: v5 renombró `cloudflare_record` →
`cloudflare_dns_record` y `config` pasó a ser atributo. Si usas otra versión, verifica nombres.

**Uso:**

```bash
cd clusters/local/terraform
cp terraform.tfvars.example terraform.tfvars   # rellena account_id, zone_id, api_token
terraform init
terraform plan
terraform apply
# Tras esto: kubectl apply -f platform/cloudflared/deployment.yaml  (ya tiene el Secret listo)
```

El **API token** necesita permisos `Account > Cloudflare Tunnel:Edit` y `Zone > DNS:Edit`. Si el
clúster k3d no está arriba al aplicar, pon `create_k8s_secret = false` y crea el Secret luego con
`terraform output -raw tunnel_token`.

> El mismo módulo se reutiliza tal cual en Mishi-Home (`tunnel_name = "mke-home"`) y Mishi-Cloud.

---

## 7. Desplegar una app real (web + base de datos)

Como ya traes imágenes Docker, el flujo es directo. Ejemplo: API + Postgres con persistencia.

```yaml
# apps/demo/postgres.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: pg-data, namespace: app-demo }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources: { requests: { storage: 2Gi } }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: app-demo }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:16
          envFrom: [{ secretRef: { name: pg-secret } }]
          ports: [{ containerPort: 5432 }]
          volumeMounts: [{ name: pg-data, mountPath: /var/lib/postgresql/data }]
      volumes:
        - name: pg-data
          persistentVolumeClaim: { claimName: pg-data }
---
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: app-demo }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
```

```yaml
# apps/demo/api.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: app-demo }
spec:
  replicas: 2
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/mishi/demo-api:latest    # tu imagen
          ports: [{ containerPort: 8080 }]
          envFrom: [{ secretRef: { name: pg-secret } }]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: app-demo }
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  namespace: app-demo
  annotations: { kubernetes.io/ingress.class: traefik }
spec:
  rules:
    - host: demo.mishi.com.co        # <- queda público vía el túnel del §6
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: api, port: { number: 80 } } }
```

```bash
kubectl create namespace app-demo
kubectl create secret generic pg-secret -n app-demo \
  --from-literal=POSTGRES_PASSWORD='cambia-esto' \
  --from-literal=DATABASE_URL='postgres://postgres:cambia-esto@postgres:5432/postgres'
kubectl apply -f apps/demo/
```

### 7.1 Cargar imágenes locales sin registry

Mientras desarrollas, evita publicar a un registry en cada iteración:

```bash
docker build -t demo-api:dev .
k3d image import demo-api:dev -c mke      # inyecta la imagen en los nodos k3d
# usa image: demo-api:dev e imagePullPolicy: IfNotPresent
```

---

## 8. GitOps y operación (recomendado, no obligatorio aún)

Para que MKE sea reproducible y los 3 niveles converjan, gestiona el estado con Git:

- **Ahora (suficiente):** un repo `mishi-infra` con los manifiestos + `kubectl apply -k` (Kustomize)
  y overlays por nivel (`clusters/local`, `clusters/home`, `clusters/cloud`).
- **Cuando tengas Home 24/7:** instala **Argo CD** o **Flux** en el clúster y que sincronicen desde
  Git. Así "desplegar" = `git push`. Esto brilla especialmente en Home/Cloud, donde el clúster
  está siempre encendido y puede reconciliar solo.

**Secrets:** no commitees secretos en claro. Para empezar usa `kubectl create secret` (como arriba).
Cuando uses GitOps, adopta **SOPS + age** o **Sealed Secrets** para guardar secretos cifrados en Git.

### 8.1 Comandos del día a día

```bash
kubectl get pods -A                       # estado global
kubectl logs -f deploy/api -n app-demo    # logs
kubectl port-forward svc/api 8080:80 -n app-demo   # acceso local sin túnel
k9s                                       # TUI recomendada para navegar el clúster
k3d cluster stop mke   / start mke        # apagar/encender el clúster local
k3d cluster delete mke                    # destruir (¡pierde PVCs local-path!)
```

---

## 9. Roadmap: de Local a Home y Cloud

Diseñado para que **no reescribas** nada, solo cambies overlays.

### 9.1 Mishi-Home (PC 24/7, WSL2)

- Instala **k3s nativo** (no k3d) en el WSL del PC: `curl -sfL https://get.k3s.io | sh -`.
  Requiere systemd en WSL (§3.1) y, si el PC se apaga en demanda, configura el túnel para
  reconectar solo (cloudflared lo hace).
- Storage real: instala **Longhorn** o usa `local-path` con un disco dedicado.
- Crea un **segundo túnel** `mke-home` (o usa el mismo con otra ruta) para `*.home.mishi.com.co`,
  o mueve `*.mishi.com.co` a Home cuando sea tu "siempre encendido".
- Mismo Traefik, mismo cloudflared, mismos manifiestos de apps. Solo cambia el overlay.

### 9.2 Mishi-Cloud (GCP / Oracle Cloud con Terraform)

- **Oracle Cloud Free Tier** es muy generoso (VMs ARM Ampere gratis) → buen candidato barato para
  un k3s real con IP pública. **GCP** si quieres GKE Autopilot administrado.
- **Terraform** provisiona: red, VM(s), reglas de firewall, y un `cloud-init` que instala k3s.
  Estructura y plan en `clusters/cloud/terraform/` (hoy es esqueleto). La capa de Cloudflare
  **reutiliza el mismo módulo** `_modules/cloudflare-tunnel` con `tunnel_name = "mke-cloud"` —
  cero reescritura respecto a Local.
- Aquí sí conviene **cert-manager + Let's Encrypt (DNS-01 con Cloudflare)** y, si quieres HA,
  multi-nodo + Longhorn + backups a object storage.
- El túnel de Cloudflare sigue sirviendo, pero en Cloud también puedes exponer por IP pública +
  Cloudflare proxy clásico si prefieres.

---

## 10. Recomendaciones y decisiones abiertas

**Mis recomendaciones (prioridad para ti ahora):**

1. **Estandariza en k3s/k3d desde el día 1.** Es la decisión que más te ahorra a futuro. ✅
2. **cloudflared in-cluster + wildcard `*.mishi.com.co`.** Publicar = crear un Ingress. Cero
   fricción para compartir. ✅
3. **Trata las DBs locales como efímeras** y respáldalas con `pg_dump`/CronJob; guarda lo serio
   para Home/Cloud con storage real. ✅
4. **Versiona todo en Git** (`mishi-infra`) con Kustomize y overlays por nivel desde ya; adopta
   Argo CD/Flux cuando llegue Home. ✅
5. Instala **k9s** y **kubectx/kubens** — calidad de vida enorme en multi-clúster. ✅

**Decisiones que te dejo abiertas (no me bloquean para esta guía, pero conviene que elijas):**

- **Registry de imágenes:** ¿`ghcr.io` (GitHub), Docker Hub, o un registry propio? Para Local basta
  `k3d image import`; para Home/Cloud necesitarás uno. Recomiendo **GHCR** (gratis, integra con CI).
- **Build pipeline:** ¿builds a mano o **GitHub Actions** que construya y publique a GHCR en cada
  push? Recomendado lo segundo en cuanto pase de Local.
- **Observabilidad:** ¿quieres ya **Prometheus + Grafana + Loki** (stack `kube-prometheus-stack`),
  o lo dejamos para Home? En Local suele ser overkill; lo activaría en Home.
- **Dominio del túnel:** confirmar si usarás `*.mishi.com.co` directo o un nivel dedicado a testing
  como `*.dev.mishi.com.co` para no mezclar con producción futura.

---

## 11. Checklist de arranque (Mishi-Local)

- [ ] WSL2 actualizado, `.wslconfig` con límites de RAM/CPU
- [ ] Docker funcionando dentro de WSL2 (`docker run hello-world`)
- [ ] `kubectl`, `k3d`, `helm`, `cloudflared` instalados
- [ ] Clúster `mke` creado (`k3d cluster create --config clusters/local/k3d.yaml`)
- [ ] StorageClass `local-path` por defecto verificada
- [ ] Traefik instalado en namespace `ingress`
- [ ] Prueba `whoami` accesible vía `*.127.0.0.1.sslip.io`
- [ ] `terraform apply` en `clusters/local/terraform` (túnel + DNS wildcard + Secret) ✦ §6.5
- [ ] `cloudflared` corriendo en namespace `cloudflare` (`platform/cloudflared/deployment.yaml`)
- [ ] Ruta wildcard `*.mishi.com.co` → `traefik.ingress.svc:80` activa (la crea Terraform)
- [ ] App demo (web + Postgres) desplegada y accesible en `demo.mishi.com.co`
- [ ] Todo el estado versionado en `mishi-infra`

---

*Mishi Kubernetes Engine — documento de inicialización. Siguiente paso sugerido: ejecutar §3–§4
y validar el ingress local antes de conectar el túnel.*
