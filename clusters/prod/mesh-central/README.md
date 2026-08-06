# mesh-central — manifiestos rescatados del cluster

Estos YAML estaban aplicados en el cluster vivo pero **no existían en ningún
repo**. Se exportaron desde `kubectl.kubernetes.io/last-applied-configuration`
(el manifiesto original limpio, no un volcado del objeto vivo) y se verificaron
con `kubectl diff`: reaplicarlos no produce ningún cambio.

| ambiente | archivo | namespace | host |
|---|---|---|---|
| prod | `clusters/prod/mesh-central/mesh-central.yaml` | `prod` | `mesh.mishi.com.co` |
| stage | `clusters/stage/mesh-central/mesh-central.yaml` | `mesh-central` | `mesh-stage.mishi.com.co` |

Contenido de cada archivo: Deployment, Service, Ingress, Middleware de Traefik y
los dos PVC (`mesh-central-data`, `mesh-central-files`).

## Lo único que de verdad no se puede perder

La **identidad del servidor** vive dentro del PVC `mesh-central-data` (~33 MB),
no en un Secret ni en estos manifiestos:

- `agentserver-cert-private.key` y `agentserver-cert-public.crt` — lo que los
  agentes remotos reconocen para confiar en el servidor.
- `codesign-cert-*` — firma de los instaladores de agente ya distribuidos.
- `config.json`, que contiene la `sessionKey` generada al azar la primera vez.
- Las bases NeDB (`meshcentral-*.db`): usuarios, grupos y equipos.

**No existe el Secret `mesh-central-secrets`.** El initContainer lo lee como
`optional: true`, así que la `sessionKey` fue aleatoria y solo persiste en el
`config.json` del PVC.

Consecuencia: si el pod arranca contra un PVC vacío, MeshCentral genera una
identidad nueva y **todos los agentes remotos quedan huérfanos** — hay que
reinstalarlos máquina por máquina. El initContainer es idempotente (si
`config.json` existe, no lo toca), así que restaurar el PVC antes de que el pod
arranque preserva todo y los agentes reconectan solos.

## Orden correcto al levantar en un cluster nuevo

1. `kubectl apply -f mesh-central.yaml` — crea los PVC vacíos y el Deployment.
2. `kubectl -n <ns> scale deploy/mesh-central --replicas=0` — antes de que
   escriba nada.
3. Restaurar el tar de `meshcentral-data` (y `meshcentral-files`) sobre los PVC,
   con un Job efímero que los monte. Receta en
   `postgres-mishi/backups/RESTORE.md` §3.
4. `kubectl -n <ns> scale deploy/mesh-central --replicas=1`.
5. Verificar que un agente remoto aparece conectado **sin intervención** (dale
   hasta ~15 min de reintentos). Si no reconectan, la identidad no migró: parar
   y volver atrás.

El backup de estos PVC lo hace `postgres-mishi/backups/host/mke-backup.sh`
(tar → gzip → rclone a `gdrive:mke-backups`).
