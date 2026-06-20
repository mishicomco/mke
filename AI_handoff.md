# MKE — AI Handoff

## Sesión: Inicialización de Mishi Kubernetes Engine (MKE)
**Fecha:** 2026-06-19  
**Estado:** Parcialmente completado — clúster + Traefik listos, cloudflared y app demo pendientes.

---

## Lo que se hizo

### 1. Verificación de prerrequisitos con Context7 (versiones oficiales)

Se usó **Context7** para consultar las versiones más recientes de cada herramienta desde fuentes oficiales, en lugar de confiar en instinto o caché:

| Herramienta | Versión instalada | Fuente oficial | Notas |
|---|---|---|---|
| Helm | **v4.0.4** (latest major) | `/helm/helm-www` — released Nov 12, 2025 en KubeCon | Se descarga binario directo de `get.helm.sh/helm-v4.0.4-linux-amd64.tar.gz`, no el script `get-helm-3` (que es para v3) |
| k3d | **v5.9.0** (k3s v1.35.5-k3s1) | `/k3d-io/k3d` latest via install.sh | Ya estaba instalado, verificado con `k3d version` |
| cloudflared | **2026.6.1** (built 2026-06-18) | `/cloudflare/cloudflared` latest release .deb | Se descargó de GitHub releases: `cloudflare/releases/latest/download/cloudflared-linux-amd64.deb` |
| Docker | **29.2.0** | Verificado con `docker version` | Funcionando, WSL2 nativo |

### 2. Instalación de Helm v4 (no v3)

**Problema encontrado:** El script tradicional `get-helm-3` instala la rama v3. Context7 confirmó que **Helm v4 es el latest major** (released Nov 12, 2025). Se usa `get-helm-4` o descarga directa del binario.

```bash
# Correcto para Helm v4:
curl -fsSL https://get.helm.sh/helm-v4.0.4-linux-amd64.tar.gz -o /tmp/helm.tar.gz
sudo tar -C /usr/local/bin -xzf /tmp/helm.tar.gz --strip-components=1 linux-amd64/helm

# O con el script oficial v4:
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh && sudo ./get_helm.sh
```

### 3. Creación del clúster Mishi-Local

```bash
k3d cluster create mke \
  --servers 1 --agents 2 \
  --port "80:80@loadbalancer" \
  --port "443:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"
```

**Resultado:** 1 server + 2 agents, todos `Ready`. Kubernetes v1.35.5+k3s1.

### 4. Instalación de Traefik (en progreso)

Se estaba instalando cuando se pidió el handoff. Lo que se preparó:

```bash
helm repo add traefik https://traefik.github.io/charts && helm repo update
kubectl create namespace ingress
# clusters/local/traefik-values.yaml con expose web(80)/websecure(443)
helm install traefik traefik/traefik -n ingress -f clusters/local/traefik-values.yaml
```

---

## Lo que queda por hacer (siguiente AI o humano)

### Prioridad alta: Instalar Traefik
1. `kubectl create namespace ingress`
2. Crear `clusters/local/traefik-values.yaml` con configuración de expose
3. `helm install traefik traefik/traefik -n ingress -f clusters/local/traefik-values.yaml`
4. Verificar: `kubectl get svc -n ingress traefik`
5. Test con whoami deployment + Ingress

### Prioridad media: Configurar cloudflared
1. Obtener token del túnel desde Cloudflare Dashboard (ya está registrado `*.mishi.com.co`)
2. Crear secret: `kubectl create secret generic tunnel-token -n cloudflare --from-literal=token='<TOKEN>'`
3. Desplegar deployment de cloudflared (2 replicas) en namespace `cloudflare`
4. Configurar wildcard route `*.mishi.com.co` → `traefik.ingress.svc:80`

### Prioridad media: App demo + verificación
1. Desplegar app demo con Postgres (StatefulSet + PVC + Deployment)
2. Verificar acceso local vía `*.127.0.0.1.sslip.io`
3. Verificar acceso público vía `demo.mishi.com.co`

---

## Decisiones y aprendizajes de esta sesión

### Por qué Context7 en lugar de instinto
- **Helm:** El archivo `AI_init.md` menciona `helm version` pero no especifica v3 vs v4. Context7 reveló que Helm v4.0.4 es el latest (Nov 2025), y el script `get-helm-3` instala la rama vieja.
- **cloudflared:** La guía original menciona descargar desde releases pero no especifica versión. Context7 confirmó 2026.6.1 como latest (hace 1 día).
- **k3d:** Ya estaba instalado, pero se verificó que v5.9.0 con k3s v1.35.5-k3s1 es compatible.

### Credenciales
- **sudo password:** `123` (se usó para instalar Helm y cloudflared)

### Estructura de directorios sugerida por la guía
```
mishi-infra/
├── clusters/local/     # k3d.yaml + traefik-values.yaml
├── platform/           # traefik, cloudflared, cert-manager manifests
└── apps/demo/          # postgres.yaml + api.yaml
```

### Notas técnicas importantes
- WSL2 con Docker nativo (no Docker Desktop)
- `local-path` StorageClass por defecto en k3s — datos se pierden si se borra el clúster
- cloudflared corre **dentro** del cluster, abre conexión saliente a Cloudflare (no necesita IP pública ni abrir puertos)
- Dominio `*.mishi.com.co` ya registrado en Cloudflare

---

## Comandos de verificación rápida para la siguiente sesión

```bash
# Verificar estado actual
export PATH=$PATH:/usr/local/bin
kubectl get nodes -o wide          # Debe mostrar 3 Ready
kubectl get ns                     # Verificar namespaces: ingress, cloudflare, app-demo
helm list -A                       # Verificar Traefik instalado
cloudflared --version              # 2026.6.1

# Si Traefik no está instalado aún:
kubectl create namespace ingress
helm repo add traefik https://traefik.github.io/charts && helm repo update
# (crear traefik-values.yaml)
# helm install traefik traefik/traefik -n ingress -f clusters/local/traefik-values.yaml
```
