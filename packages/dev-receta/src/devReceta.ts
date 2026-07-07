// La RECETA del "pod de iteración" (`mke dev`) del harness v2 de Mishi Studio
// (diseño FIRMADO por Santi, 2026-07-06). Generación PURA de manifiestos de k8s:
// entradas {app, rama, repoUrl, …} → array de OBJETOS manifest (JSON), sin
// efectos ni serialización. El consumidor decide serializar (kubectl apply -f =
// List JSON; la API de k8s = objeto por objeto).
//
// ÚNICO mecanismo de rama del ecosistema (unificación FIRMADA por Santi,
// 2026-07-06): el pod DURADERO de iteración es la ÚNICA forma de encender una
// rama. El viejo "pod de rama" EFÍMERO (front estático + caddy, una FOTO) MURIÓ
// como concepto; `@mishicomco/rama-receta` queda DEPRECADA (Studio la vendoriza
// hasta migrar) y `mke rama` es hoy una fachada de `mke dev`. La fidelidad de
// build de una rama la cubre el examen de STAGE post-merge, no un segundo pod.
//
//   dev → pod DURADERO por app, servidor de ITERACIÓN: corre la app en MODO DEV
//         REAL (vite dev con HMR + tsx watch) sobre un clone del repo. Cambiar de
//         rama / traer cambios = git DENTRO del pod (checkout/reset) sin recrear
//         el pod → Santi ve las ediciones en segundos. "Nada de puertos
//         artesanales, nada de fallback: siempre iteramos en mke-preview."
//
// CONFIG PÚBLICA por-rama: la app declara sus envs NO secretos (ej.
// VITE_CONNECT_URL, VITE_GOOGLE_CLIENT_ID) en `k8s/dev.env` (líneas K=V) DENTRO
// de su repo. El pod la sourcea al boot y al cambiar de rama (cargar-dev-env.sh)
// → cada rama trae SU config y re-aplicar `up` sin `--env` YA NO pierde nada
// (la verdad vive en el repo, no en un flag efímero). PROHIBIDO poner secretos en
// dev.env: para secretos rige el contrato RAMA_ENCENDIDA (efímeros autogenerados)
// y, a futuro, leases de vault-mishi (ver README, cama tendida — NO construido).
// Precedencia: `--env K=V` del CLI (Secret + envFrom) GANA sobre dev.env.
//
// Anatomía del pod (ns propio `dev`; JAMÁS mke-prod):
//   · initContainer `preparar` (imagen runner): git clone COMPLETO (sin --depth,
//     para poder cambiar de rama después) → checkout de la rama inicial → npm
//     install. Volumen /workspace = emptyDir: sobrevive reinicios del contenedor,
//     no del pod (re-clona al recrear el pod).
//   · contenedor `dev` (imagen runner): espera al postgres → reset DB (drop
//     schema) + migra + siembra → escribe la config de vite del modo dev →
//     arranca backend (tsx watch) Y vite dev, + un poll opcional. PREVIEW=true
//     SIEMPRE (lo posee la receta, nunca un humano).
//   · contenedor `web` (caddy): proxy del host público → vite dev CON WEBSOCKETS
//     (HMR) y /api,/health → backend. Un solo origen.
//   · sidecar `postgres` (postgres:16-alpine, emptyDir): DB efímera por loopback;
//     nace y muere con el pod. JAMÁS datos de stage ni secretos reales.
//
// Recursos: Namespace `dev` + Secret (REPO_URL) + ConfigMap (scripts + Caddyfile
// + vite config) + Deployment + Service + Ingress, todos con el label
// `mke.dev/name` para un borrado limpio. Host `<app>-dev-feat.mishi.com.co`
// (o `<app>-<nombre>-dev-feat…` con --nombre para tener varios).

// ─── constantes de la receta (dueño ÚNICO; no las dupliques) ─────────────────

export const DEV_NAMESPACE = "dev";
export const DEV_HOST_SUFFIX = "-feat"; // guardarraíl de DNS del CLI acepta *-feat.mishi.com.co
export const DEV_RUNNER_IMAGE = "mke-dev-runner:node22";
export const DEV_DOMAIN = "mishi.com.co";
/** puertos internos del pod (loopback); el público entra por caddy:8080 → svc:80. */
export const DEV_BACKEND_PORT = 3000;
export const DEV_VITE_PORT = 5173;
export const DEV_CADDY_PORT = 8080;
/** cada cuánto (s) el poll consulta git ls-remote sobre la rama activa. */
export const DEV_POLL_SECONDS = 20;

// ─── slug / nombres / hosts (PUROS) ──────────────────────────────────────────

/** slug apto para DNS/k8s: minúsculas, no-alfanumérico → `-`, colapsa/recorta. */
export function slugDev(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  if (!out) throw new Error(`no pude derivar un slug válido de '${s}'`);
  return out;
}

/**
 * nombre del servidor de iteración de una app: `<app>-dev`, o `<app>-<nombre>-dev`
 * si se pide un nombre (para tener varios servidores de la misma app a la vez).
 * Saneado y recortado a un límite seguro para nombres de k8s y labels DNS.
 */
export function devName(app: string, nombre?: string): string {
  const base = nombre ? `${app}-${nombre}-dev` : `${app}-dev`;
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`no pude derivar un nombre de dev válido de '${app}'/'${nombre ?? ""}'`);
  return s;
}

/** host público del servidor de iteración: `<name>-feat.mishi.com.co`. */
export function devHost(
  app: string,
  nombre?: string,
  opts: { hostSuffix?: string; domain?: string } = {},
): string {
  const suffix = opts.hostSuffix ?? DEV_HOST_SUFFIX;
  const domain = opts.domain ?? DEV_DOMAIN;
  return `${devName(app, nombre)}${suffix}.${domain}`;
}

/** URL INTERNA del service del pod dentro del clúster: `http://<name>.<ns>.svc:80`. */
export function devServicioInterno(name: string, namespace: string = DEV_NAMESPACE): string {
  return `http://${name}.${namespace}.svc:80`;
}

/** labelSelector canónico para borrar/listar los recursos de un dev por nombre. */
export function selectorDeDev(name: string): string {
  return `mke.dev/name=${name}`;
}

/**
 * base pública del modo EMBED (`--live`): el prefijo bajo el que Mishi Studio
 * embebe la app SAME-ORIGEN por su proxy `/live/<app>/`. En este modo vite sirve
 * bajo esta base y caddy redirige solo la raíz exacta acá (para que el host -feat
 * siga siendo usable a mano). Deriva del nombre corto de la app. */
export function devLiveBase(app: string): string {
  return `/live/${app}/`;
}

// ─── config de vite del modo dev (PURA; la posee la receta) ──────────────────

/**
 * Config de vite del modo dev: HEREDA el vite.config del app (plugins, proxy /api,
 * etc.) y le añade lo mínimo para que sea alcanzable por el túnel de mke-preview:
 * host 0.0.0.0, allowedHosts (cualquier host detrás del túnel) y HMR por wss:443
 * (Cloudflare hace el TLS-offload; el navegador abre el websocket de HMR contra
 * el host público en :443). El pod copia este archivo al frontend y corre
 * `vite -c vite.dev.mke.config.ts`. GENERADO — no se edita a mano.
 *
 * En modo EMBED (`viteBase`, ej `/live/mishi-bank/`) se fija `base` para que la
 * app se sirva bajo ese prefijo y Studio la embeba same-origen. El path del
 * websocket de HMR sale del `base` automáticamente — por eso NO tocamos `hmr`.
 */
export function viteDevConfig(vitePort: number = DEV_VITE_PORT, viteBase?: string): string {
  const baseLinea = viteBase ? `\n  base: ${JSON.stringify(viteBase)},` : "";
  return `// modo dev (mke dev): hereda el vite.config del app + dev server abierto para el
// túnel de mke-preview (HMR por wss:443 detrás de Cloudflare). GENERADO por
// @mishicomco/dev-receta — NO editar a mano.
import { mergeConfig } from "vite";
import base from "./vite.config";
export default mergeConfig(base as never, {${baseLinea}
  server: {
    host: "0.0.0.0",
    port: ${vitePort},
    strictPort: true,
    allowedHosts: true,
    hmr: { protocol: "wss", clientPort: 443 },
  },
});
`;
}

// ─── config pública por-rama: k8s/dev.env (PURO; espejo del loader del pod) ───

/**
 * Parsea el formato `dev.env` (líneas `K=V`) que la app declara en su repo.
 * Ignora líneas vacías y comentarios (`#…`). La clave se recorta; el valor se
 * recorta en los bordes (tolerante con `K = V`). Sin `=` → línea inválida (fuera).
 * Espejo EXACTO en semántica del loader de shell del pod (cargar-dev-env.sh).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    out[k] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Fusiona la config del archivo `dev.env` con los overrides del CLI (`--env`),
 * con la PRECEDENCIA firmada: el override GANA sobre el archivo. Modela lo que
 * pasa en el pod, donde `--env` llega por el Secret (envFrom, ya en el entorno) y
 * cargar-dev-env.sh solo rellena las claves que aún NO estén en el entorno.
 */
export function mergeDevEnv(
  fileVars: Record<string, string>,
  overrideVars: Record<string, string> = {},
): Record<string, string> {
  return { ...fileVars, ...overrideVars };
}

/**
 * CANDADO: `k8s/dev.env` es config PÚBLICA — vite hornea todo lo que empieza
 * por `VITE_` en el bundle del navegador. Un Bearer horneado ahí (ej.
 * `VITE_STUDIO_TOKEN`) es indefendible: cualquiera con devtools lo lee. Detecta
 * claves `VITE_*TOKEN*` (o el nombre exacto conocido) declaradas en dev.env, sin
 * asumir un valor concreto — es un guardarraíl de NOMBRE, no de contenido.
 * Espejo EXACTO del check en `cargar-dev-env.sh` (in-pod, en shell).
 */
export function clavesViteTokenProhibidas(vars: Record<string, string>): string[] {
  return Object.keys(vars).filter((k) => /^VITE_.*TOKEN/i.test(k));
}

// ─── scripts embebidos (van a un ConfigMap; el pod los ejecuta) ──────────────

/** carga la CONFIG PÚBLICA por-rama declarada por la app en `k8s/dev.env` (K=V).
 * Se SOURCEA (no ejecuta) desde boot-dev.sh (antes de migrar/sembrar y en cada
 * (re)arranque de backend/vite) y desde rama.sh (para que migraciones/siembra de
 * la nueva rama vean su config). PRECEDENCIA: solo exporta una clave si NO está
 * ya en el entorno → `--env` del CLI (Secret+envFrom) y la config de la receta
 * (PORT, PREVIEW, DATABASE_URL, …) GANAN. PROHIBIDO secretos en dev.env. */
const CARGAR_DEV_ENV_SH = `#!/bin/sh
# NO 'set -e' general: se SOURCEA; un error normal acá no debe matar al que lo
# invoca. EXCEPCIÓN a propósito: el candado de VITE_*TOKEN* SÍ mata al llamador
# (boot-dev.sh/rama.sh corren con set -eu, un 'exit' acá los aborta) — aborto
# ruidoso a propósito, ver comentario abajo.
ARCHIVO=/workspace/repo/k8s/dev.env
if [ -f "$ARCHIVO" ]; then
  while IFS= read -r linea || [ -n "$linea" ]; do
    case "$linea" in ''|\\#*) continue ;; esac
    case "$linea" in *=*) : ;; *) continue ;; esac
    clave=$(printf '%s' "\${linea%%=*}" | tr -d '[:space:]')
    [ -z "$clave" ] && continue
    # CANDADO: dev.env es config PÚBLICA (vite hornea todo VITE_* en el bundle
    # del navegador). Un VITE_*TOKEN* ahí es un Bearer indefendible en JS
    # público — abortamos el boot ruidosamente, NUNCA lo cargamos en silencio.
    case "$clave" in
      VITE_*TOKEN*|VITE_*Token*|VITE_*token*)
        echo "[dev] CANDADO: '$clave' en k8s/dev.env — PROHIBIDO hornear tokens VITE_* en el bundle del navegador." >&2
        echo "[dev] quita '$clave' de k8s/dev.env. La cabina del pod entra por login (identity-preview), no por Bearer." >&2
        exit 1
        ;;
    esac
    # valor recortado en los bordes (espejo de parseDotEnv); espacios internos ok
    valor=$(printf '%s' "\${linea#*=}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    # ya presente en el entorno (p.ej. --env del CLI) → gana, no lo pisamos
    if printenv "$clave" >/dev/null 2>&1; then continue; fi
    export "$clave=$valor"
    echo "[dev] dev.env: $clave"
  done < "$ARCHIVO"
fi
`;

/** construye los PACKAGES del monorepo (no el repo completo: eso incluiría el
 * frontend y es lento). El backend importa packages que compilan a dist/
 * (ej. @mishi-bank/contract) — npm install solo no basta. Reusado por
 * prepare.sh, rama.sh y pull.sh. */
const BUILD_PACKAGES_SH = `#!/bin/sh
set -eu
cd /workspace/repo
for pkg in packages/*/package.json; do
  [ -f "$pkg" ] || continue
  dir=$(dirname "$pkg")
  echo "[dev] build $dir"
  npm run build -w "$dir" --if-present || echo "[dev] build de $dir falló (sigo)"
done
`;

/** initContainer: clona el repo COMPLETO (para cambiar de rama), checkout,
 * install + build de los packages del workspace (dist/ que importa el backend). */
const PREPARE_SH = `#!/bin/sh
set -eu
echo "[dev] preparando $APP (rama inicial $RAMA)"
cd /workspace
if [ ! -d repo/.git ]; then
  git clone "$REPO_URL" repo
fi
cd repo
git fetch origin --prune
git checkout "$RAMA" 2>/dev/null || git checkout -B "$RAMA" "origin/$RAMA"
git reset --hard "origin/$RAMA" || true
mkdir -p /workspace/.dev
echo "$RAMA" > /workspace/.dev/rama
echo "[dev] npm install"
npm install --no-audit --no-fund
sh /mke/build-packages.sh
echo "[dev] preparado: $(git rev-parse --short HEAD)"
`;

/** reset de la DB efímera: drop schema + migraciones + siembra. Reusado por el
 * arranque y por el cambio de rama (rama.sh). */
const RESET_DB_SH = `#!/bin/sh
set -eu
cd /workspace/repo
echo "[dev] reset DB (drop schema public)"
PGPASSWORD=dev psql -h 127.0.0.1 -U dev -d dev -v ON_ERROR_STOP=1 \\
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' || echo "[dev] drop schema falló (sigo)"
echo "[dev] migraciones"
npm run db:migrate -w apps/backend || echo "[dev] db:migrate falló (sigo)"
if [ -n "\${SEED_CMD:-}" ]; then
  echo "[dev] seed: $SEED_CMD"
  sh -c "$SEED_CMD" || echo "[dev] seed falló (sigo)"
elif npm run -w apps/backend 2>/dev/null | grep -q 'seed:escenario'; then
  echo "[dev] seed:escenario feliz"
  npm run seed:escenario -w apps/backend -- feliz || echo "[dev] seed falló (sigo)"
fi
`;

/** arranque del contenedor dev: reset+migra+siembra, config de vite, backend
 * tsx watch + vite dev + poll opcional. Se queda en foreground (wait).
 *
 * SOURCEA la config pública por-rama (k8s/dev.env) ANTES de migrar/sembrar y en
 * CADA (re)arranque de backend/vite, para que la app siempre tenga su config del
 * repo (esto vuelve IMPOSIBLE el incidente de "faltó VITE_CONNECT_URL" y de
 * "re-aplicar up sin --env borró los envs"). Cada app corre en un supervisor que
 * la relanza si muere (crash de boot) o si rama.sh pide un reinicio (sentinel
 * /workspace/.dev/restart) para que un cambio de rama recoja la NUEVA config. */
const BOOT_DEV_SH = `#!/bin/sh
set -eu
cd /workspace/repo
mkdir -p /workspace/.dev
rm -f /workspace/.dev/restart
RAMA_ACTIVA=$(cat /workspace/.dev/rama 2>/dev/null || echo "$RAMA")

echo "[dev] esperando postgres…"
until pg_isready -h 127.0.0.1 -p 5432 -U dev >/dev/null 2>&1; do sleep 2; done

# config PÚBLICA por-rama declarada por la app (k8s/dev.env) → al entorno ANTES de
# migrar/sembrar (para que la vean) y de arrancar la app. Precedencia: --env gana.
. /mke/cargar-dev-env.sh

sh /mke/reset-db.sh || echo "[dev] reset-db falló (sigo)"

# config de vite del modo dev (la posee la receta) → al frontend del app
FRONT=apps/frontend
[ -d "$FRONT" ] || FRONT=.
cp /mke/vite.dev.mke.config.ts "$FRONT/vite.dev.mke.config.ts"

# mata un PID y toda su descendencia (sin procps: recorre /proc). Se usa para
# reiniciar limpiamente backend (npm→tsx→node) sin dejar el puerto ocupado.
matar_arbol() {
  for hijo in $(cat /proc/"$1"/task/"$1"/children 2>/dev/null); do matar_arbol "$hijo"; done
  kill -TERM "$1" 2>/dev/null || true
}

# supervisor de un proceso de la app: re-sourcea dev.env en CADA arranque, lo
# lanza, y lo vigila. Si aparece el sentinel de reinicio (rama.sh) mata el árbol y
# relanza con la NUEVA config; si murió solo (crash de boot) reintenta con backoff.
# \$1 = etiqueta ; resto = comando.
supervisar() {
  etiqueta="$1"; shift
  intento=0
  while true; do
    . /mke/cargar-dev-env.sh
    "$@" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f /workspace/.dev/restart ]; then
        echo "[dev] reinicio de $etiqueta (cambió la rama/config)"
        matar_arbol "$pid"
        break
      fi
      sleep 2
    done
    wait "$pid" 2>/dev/null || true
    if [ -f /workspace/.dev/restart ]; then
      intento=0
    else
      intento=$((intento+1))
      if [ "$intento" -lt 6 ]; then espera=$((intento*5)); else espera=30; fi
      echo "[dev] $etiqueta murió (intento $intento) — reinicio en \${espera}s"
      sleep "$espera"
    fi
  done
}

# backend en modo watch (tsx). Corre por-workspace (no turbo) para no acoplar el
# arranque a un script 'dev' opaco: el pod controla puertos y topología del proxy.
if [ -d apps/backend ]; then
  echo "[dev] backend tsx watch en :$BACKEND_PORT"
  supervisar backend sh -c 'npm run dev -w apps/backend' &
fi

# frontend vite dev con la config generada (HMR wss:443)
echo "[dev] vite dev en :$VITE_PORT"
supervisar vite sh -c "cd '$FRONT' && npx vite -c vite.dev.mke.config.ts" &

# poll opcional: cada POLL_SECONDS trae origin/<rama activa> (semántica de pull).
if [ "\${POLL_SECONDS:-0}" -gt 0 ] 2>/dev/null; then
  echo "[dev] poll cada \${POLL_SECONDS}s sobre $RAMA_ACTIVA"
  sh /mke/poll.sh &
fi

wait
`;

/** cambio de rama (exec por el CLI): fetch + checkout + install si cambió el
 * lockfile + reset de la DB + RECARGA de la config por-rama (dev.env). tsx/vite
 * recogen los archivos solos; la NUEVA dev.env se aplica reiniciando backend/vite
 * vía el sentinel /workspace/.dev/restart (los supervisores de boot-dev.sh la
 * re-sourcean al relanzar). Así "cambiar de rama recoge los envs DE ESA rama". */
const RAMA_SH = `#!/bin/sh
set -eu
NUEVA="\${1:?uso: rama.sh <rama>}"
cd /workspace/repo
echo "[dev] fetch + checkout $NUEVA"
git fetch origin --prune
LOCK_ANTES=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
git checkout "$NUEVA" 2>/dev/null || git checkout -B "$NUEVA" "origin/$NUEVA"
git reset --hard "origin/$NUEVA"
echo "$NUEVA" > /workspace/.dev/rama
LOCK_DESPUES=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "")
if [ "$LOCK_ANTES" != "$LOCK_DESPUES" ]; then
  echo "[dev] lockfile cambió → npm install"
  npm install --no-audit --no-fund
fi
sh /mke/build-packages.sh
# config pública de la NUEVA rama → al entorno de este exec (para migrar/sembrar);
# los supervisores de la app la re-sourcean al reiniciar (sentinel de abajo).
. /mke/cargar-dev-env.sh
sh /mke/reset-db.sh
# pide a los supervisores de backend/vite un reinicio para adoptar la nueva
# dev.env (ventana > el poll de 2s de supervisar; luego se limpia el sentinel).
touch /workspace/.dev/restart
sleep 4
rm -f /workspace/.dev/restart
echo "[dev] rama activa: $NUEVA @ $(git rev-parse --short HEAD)"
`;

/** traer cambios de la rama activa YA (exec por el CLI y por el poll). También
 * reconstruye los packages: un pull puede traer cambios del contract. */
const PULL_SH = `#!/bin/sh
set -eu
cd /workspace/repo
RAMA_ACTIVA=$(cat /workspace/.dev/rama 2>/dev/null || echo main)
git fetch origin --prune
git reset --hard "origin/$RAMA_ACTIVA"
sh /mke/build-packages.sh
echo "[dev] al día: $RAMA_ACTIVA @ $(git rev-parse --short HEAD)"
`;

/** poll in-pod: cada POLL_SECONDS compara ls-remote vs HEAD y refresca si cambió. */
const POLL_SH = `#!/bin/sh
set -eu
cd /workspace/repo
while true; do
  sleep "\${POLL_SECONDS:-20}"
  RAMA_ACTIVA=$(cat /workspace/.dev/rama 2>/dev/null || echo main)
  REMOTO=$(git ls-remote origin "refs/heads/$RAMA_ACTIVA" 2>/dev/null | cut -f1)
  LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$REMOTO" ] && [ "$REMOTO" != "$LOCAL" ]; then
    echo "[dev] push detectado en $RAMA_ACTIVA (\${REMOTO}) → refresco"
    git fetch origin --prune || true
    git reset --hard "origin/$RAMA_ACTIVA" || true
  fi
done
`;

/** caddy: proxy del host público → vite dev (WEBSOCKETS/HMR transparentes) y
 * /api,/health,/dev → backend. Un solo origen. /dev/* es el contrato de escena
 * del ecosistema (estado/entrar-como/salir, solo-preview) que Studio consume
 * vía el host del pod. */
function caddyfile(backendPort: number, vitePort: number, liveBase?: string): string {
  // modo EMBED: vite sirve bajo `liveBase` (ej /live/mishi-bank/). Redirigimos
  // SOLO la raíz exacta `/` a esa base para que el host -feat siga usable a mano;
  // el resto (incluido /live/<app>/*) va a vite tal cual. OJO: NO duplicamos acá
  // el proxy de la app (^/live/[^/]+/api → backend con rewrite): eso lo hace el
  // propio vite.config del app (bank ya es BASE_URL-aware).
  const redirRaiz = liveBase
    ? `\thandle / {
\t\tredir ${liveBase} 302
\t}
`
    : "";
  return `:${DEV_CADDY_PORT} {
	handle /api/* {
		reverse_proxy 127.0.0.1:${backendPort}
	}
	handle /health* {
		reverse_proxy 127.0.0.1:${backendPort}
	}
	handle /dev/* {
		reverse_proxy 127.0.0.1:${backendPort}
	}
${redirRaiz}	handle {
		reverse_proxy 127.0.0.1:${vitePort}
	}
}
`;
}

// ─── generación de manifiestos (PURA) ────────────────────────────────────────

export interface DevRecetaInput {
  /** nombre público/corto de la app (prefijo de nombres y host; ej `mishi-bank`). */
  app: string;
  /** rama git inicial a encender (default `main`). */
  rama?: string;
  /** URL de clone (puede llevar el token embebido: https://x-access-token:…@…). */
  repoUrl: string;
  /** nombre opcional para tener varios servidores de la misma app a la vez. */
  nombre?: string;
  /** imagen genérica del runner (default `mke-dev-runner:node22`). */
  imagen?: string;
  /** namespace destino (default `dev`). */
  namespace?: string;
  /** sufijo del host público (default `-feat`). */
  hostSuffix?: string;
  /** dominio (default `mishi.com.co`). */
  domain?: string;
  /** segundos del poll in-pod; 0 = sin poll (default 0). */
  pollSeconds?: number;
  /** comando de siembra del app (como el `sembrarCmd` que consume Studio). */
  seedCmd?: string;
  /** pares VAR=valor extra por app (ej. bank: CONNECT_URL/CONNECT_JWKS_URL a un
   * connect compartido de preview, NODE_AUTH_TOKEN para GitHub Packages). Van en
   * un Secret propio (`<name>-env`) + envFrom — nunca en claro en el Deployment —
   * inyectado al contenedor dev Y al init `preparar` (su npm install puede
   * necesitarlo); los exec de rama.sh/pull.sh heredan el env del contenedor dev.
   * NO dupliques claves que la receta ya posee (PORT, PREVIEW, DATABASE_URL,
   * RAMA, NODE_ENV, …): el env explícito gana y kubectl apply puede chocar. */
  envExtra?: Record<string, string>;
  /** modo EMBED (opt-in, `mke dev up --live`): vite sirve bajo `/live/<app>/` y
   * caddy redirige la raíz exacta ahí, para que Mishi Studio embeba la app
   * same-origen bajo su proxy `/live/<app>/`. Se marca en el Deployment con la
   * annotation `mke.dev/live: "true"` para que Studio lo DERIVE. Declarativo: es
   * un flag de `up` — re-aplicar sin `--live` lo apaga (vuelve al modo normal). */
  live?: boolean;
  /** token de LECTURA de GitHub Packages (opcional). Toda app estándar depende
   * de paquetes privados @mishicomco (el template usa el SDK connect) y su
   * .npmrc autentica con `${NODE_AUTH_TOKEN}` — sin él, el npm install del init
   * muere con 401. Va en un Secret propio (`<name>-npm`, key NODE_AUTH_TOKEN) y
   * se inyecta como env `NODE_AUTH_TOKEN` en el init `preparar` Y en el
   * contenedor dev (rama.sh también corre npm install al cambiar de rama).
   * NUNCA en claro en el Deployment. Si no llega, no se crea nada (apps sin
   * paquetes privados no lo necesitan). */
  npmToken?: string;
}

export type K8sManifest = Record<string, unknown>;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/**
 * Namespace + Secret + ConfigMap + Deployment + Service + Ingress del pod de
 * iteración, como OBJETOS (no YAML). El REPO_URL viaja base64 en el Secret, nunca
 * en claro.
 */
export function manifiestosDev(inp: DevRecetaInput): K8sManifest[] {
  const app = inp.app;
  const rama = inp.rama ?? "main";
  const namespace = inp.namespace ?? DEV_NAMESPACE;
  const imagen = inp.imagen ?? DEV_RUNNER_IMAGE;
  const pollSeconds = inp.pollSeconds ?? 0;
  const name = devName(app, inp.nombre);
  const host = devHost(app, inp.nombre, { hostSuffix: inp.hostSuffix, domain: inp.domain });
  // modo EMBED: base pública `/live/<app>/` bajo la que vite sirve la app.
  const liveBase = inp.live ? devLiveBase(app) : undefined;

  const labels: Record<string, string> = {
    "mke.dev/managed": "true",
    "mke.dev/name": name,
    "mke.dev/app": app,
  };
  if (inp.nombre) labels["mke.dev/nombre"] = slugDev(inp.nombre);

  const namespaceObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: { "app.kubernetes.io/part-of": "mke-dev" },
    },
  };

  const secretObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: `${name}-git`, namespace, labels },
    type: "Opaque",
    data: { REPO_URL: b64(inp.repoUrl) },
  };

  // env extra por app → Secret propio (`<name>-env`) + envFrom, NUNCA valores en
  // claro en el Deployment (ahí van tokens como NODE_AUTH_TOKEN). Se inyecta al
  // contenedor dev Y al initContainer preparar: el `npm install` del init puede
  // necesitarlo (bank instala de GitHub Packages con ${NODE_AUTH_TOKEN} en su
  // .npmrc), y los exec de rama.sh/pull.sh heredan el env del contenedor dev.
  const envExtra = inp.envExtra ?? {};
  const hayEnvExtra = Object.keys(envExtra).length > 0;
  const envSecretObj: K8sManifest | null = hayEnvExtra
    ? {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `${name}-env`, namespace, labels },
        type: "Opaque",
        data: Object.fromEntries(Object.entries(envExtra).map(([k, v]) => [k, b64(v)])),
      }
    : null;
  // OJO: el env explícito de la receta (PORT, PREVIEW, DATABASE_URL, …) GANA
  // sobre envFrom; no dupliques claves que la receta ya posee en envExtra.
  const envFrom = hayEnvExtra ? [{ secretRef: { name: `${name}-env` } }] : undefined;

  // token de GitHub Packages → Secret propio (`<name>-npm`) + env NODE_AUTH_TOKEN
  // por secretKeyRef en preparar Y dev (rama.sh corre npm install al cambiar de
  // rama). Opcional: sin token no se crea nada.
  const npmSecretObj: K8sManifest | null = inp.npmToken
    ? {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `${name}-npm`, namespace, labels },
        type: "Opaque",
        data: { NODE_AUTH_TOKEN: b64(inp.npmToken) },
      }
    : null;
  const npmTokenEnv: { name: string; valueFrom: unknown }[] = inp.npmToken
    ? [
        {
          name: "NODE_AUTH_TOKEN",
          valueFrom: { secretKeyRef: { name: `${name}-npm`, key: "NODE_AUTH_TOKEN" } },
        },
      ]
    : [];

  const configMapObj: K8sManifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `${name}-scripts`, namespace, labels },
    data: {
      "prepare.sh": PREPARE_SH,
      "build-packages.sh": BUILD_PACKAGES_SH,
      "cargar-dev-env.sh": CARGAR_DEV_ENV_SH,
      "boot-dev.sh": BOOT_DEV_SH,
      "reset-db.sh": RESET_DB_SH,
      "rama.sh": RAMA_SH,
      "pull.sh": PULL_SH,
      "poll.sh": POLL_SH,
      "vite.dev.mke.config.ts": viteDevConfig(DEV_VITE_PORT, liveBase),
      Caddyfile: caddyfile(DEV_BACKEND_PORT, DEV_VITE_PORT, liveBase),
    },
  };

  // env base del contenedor dev + los extra por app (bank: CONNECT_URL, etc.).
  // PREVIEW=true SIEMPRE — el flag lo posee la receta, nunca un humano.
  const devEnv: { name: string; value: string }[] = [
    { name: "APP", value: app },
    { name: "RAMA", value: rama },
    { name: "PREVIEW", value: "true" },
    { name: "NODE_ENV", value: "development" },
    { name: "PORT", value: String(DEV_BACKEND_PORT) },
    { name: "BACKEND_PORT", value: String(DEV_BACKEND_PORT) },
    { name: "VITE_PORT", value: String(DEV_VITE_PORT) },
    { name: "POLL_SECONDS", value: String(pollSeconds) },
    { name: "DATABASE_URL", value: "postgres://dev:dev@127.0.0.1:5432/dev" },
  ];
  if (inp.seedCmd) devEnv.push({ name: "SEED_CMD", value: inp.seedCmd });

  const podLabels = { app: name, ...labels };

  const deploymentObj: K8sManifest = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      labels,
      // rama/sha vivos: los escribe el CLI (up/rama/pull); `dev estado` los lee.
      // `mke.dev/live` marca el modo EMBED para que Studio DERIVE que este pod
      // sirve bajo `/live/<app>/` (declarativo: presente solo si --live en el up).
      annotations: {
        "mke.dev/rama": rama,
        "mke.dev/sha": "",
        ...(liveBase ? { "mke.dev/live": "true" } : {}),
      },
    },
    spec: {
      replicas: 1,
      // /workspace es emptyDir y clona al arrancar: nunca dos pods a la vez.
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          securityContext: { fsGroup: 1000 },
          initContainers: [
            {
              name: "preparar",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "/mke/prepare.sh"],
              ...(envFrom ? { envFrom } : {}),
              env: [
                { name: "APP", value: app },
                { name: "RAMA", value: rama },
                {
                  name: "REPO_URL",
                  valueFrom: { secretKeyRef: { name: `${name}-git`, key: "REPO_URL" } },
                },
                ...npmTokenEnv,
              ],
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/mke" },
              ],
            },
          ],
          containers: [
            {
              name: "postgres",
              image: "postgres:16-alpine",
              env: [
                { name: "POSTGRES_USER", value: "dev" },
                { name: "POSTGRES_PASSWORD", value: "dev" },
                { name: "POSTGRES_DB", value: "dev" },
                { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
              ],
              ports: [{ containerPort: 5432 }],
              readinessProbe: {
                exec: { command: ["pg_isready", "-U", "dev", "-d", "dev"] },
                periodSeconds: 3,
                failureThreshold: 40,
              },
              volumeMounts: [{ name: "pgdata", mountPath: "/var/lib/postgresql/data" }],
            },
            {
              name: "dev",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "/mke/boot-dev.sh"],
              ...(envFrom ? { envFrom } : {}),
              // NODE_AUTH_TOKEN también acá: rama.sh corre npm install si el
              // lockfile cambió, y hereda el env de este contenedor.
              env: [...devEnv, ...npmTokenEnv],
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/mke" },
              ],
            },
            {
              name: "web",
              image: "caddy:2-alpine",
              command: ["caddy", "run", "--config", "/mke/Caddyfile", "--adapter", "caddyfile"],
              ports: [{ containerPort: DEV_CADDY_PORT }],
              readinessProbe: {
                httpGet: { path: "/", port: DEV_CADDY_PORT },
                periodSeconds: 5,
                failureThreshold: 120,
              },
              volumeMounts: [{ name: "scripts", mountPath: "/mke" }],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "pgdata", emptyDir: {} },
            { name: "scripts", configMap: { name: `${name}-scripts`, defaultMode: 0o755 } },
          ],
        },
      },
    },
  };

  const serviceObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      selector: { app: name },
      ports: [{ port: 80, targetPort: DEV_CADDY_PORT }],
    },
  };

  const ingressObj: K8sManifest = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace, labels },
    spec: {
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name, port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  };

  return [
    namespaceObj,
    secretObj,
    ...(envSecretObj ? [envSecretObj] : []),
    ...(npmSecretObj ? [npmSecretObj] : []),
    configMapObj,
    deploymentObj,
    serviceObj,
    ingressObj,
  ];
}
