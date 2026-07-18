// La RECETA del "preview-pod" (`mke preview`) del harness v2 de Mishi Studio
// (diseño FIRMADO por Santi, 2026-07-06; unificado en `mke preview` 2026-07-11).
// Generación PURA de manifiestos de k8s: entradas {app, rama, repoUrl, …} →
// array de OBJETOS manifest (JSON), sin efectos ni serialización. El consumidor
// decide serializar (kubectl apply -f = List JSON; la API de k8s = objeto por
// objeto).
//
// ÚNICO mecanismo de rama del ecosistema: el preview-pod EFÍMERO atado a la vida
// de la rama (`mke preview`) es la ÚNICA forma de encender una rama para iterar.
// Los verbos históricos `mke dev` (pod DURADERO por app) y `mke rama` (fachada
// de `mke dev`) MURIERON (2026-07-11) — esta receta conserva la maquinaria que
// `mke preview` sigue reusando (init clona+instala, vite HMR + tsx watch, caddy
// un-solo-origen, config pública por-rama `k8s/dev.env`), no los verbos en sí.
//
// CONFIG PÚBLICA por-rama: la app declara sus envs NO secretos (ej.
// VITE_CONNECT_URL, VITE_GOOGLE_CLIENT_ID) en `k8s/dev.env` (líneas K=V) DENTRO
// de su repo. El pod la sourcea al boot y al cambiar de rama (cargar-dev-env.sh)
// → cada rama trae SU config. PROHIBIDO poner secretos en dev.env: para secretos
// rige el LEASE del vault (Contrato 1) que consume `mke preview`.
//
// Anatomía del pod (ns propio `preview`; JAMÁS mke-prod):
//   · initContainer `preparar` (imagen runner): git clone COMPLETO (sin --depth,
//     para poder cambiar de rama después) → checkout de la rama inicial → npm
//     install. Volumen /workspace = emptyDir: sobrevive reinicios del contenedor,
//     no del pod (re-clona al recrear el pod).
//   · contenedor `dev` (imagen runner): espera al postgres → migra (+siembra o
//     espejo, orquestado por el CLI) → escribe la config de vite del modo dev →
//     arranca backend (tsx watch) Y vite dev, + un poll opcional. PREVIEW=true
//     SIEMPRE (lo posee la receta, nunca un humano).
//   · contenedor `web` (caddy): proxy del host público → vite dev CON WEBSOCKETS
//     (HMR) y /api,/health → backend. Un solo origen.
//   · sidecar `postgres` (postgres:16-alpine, emptyDir): DB efímera por loopback;
//     nace y muere con el pod. JAMÁS datos de stage ni secretos reales.
//
// Recursos: Namespace + Secret(s) + ConfigMap (scripts + Caddyfile + vite config)
// + Deployment + Service + Ingress, con labels `mke.preview/*` para un borrado
// limpio. Host BARE `<app>-<slug(rama)>.mishi.com.co`.

// ─── constantes de la receta (dueño ÚNICO; no las dupliques) ─────────────────

export const DEV_RUNNER_IMAGE = "mke-dev-runner:node22";
export const DEV_DOMAIN = "mishi.com.co";
/** puertos internos del pod (loopback); el público entra por caddy:8080 → svc:80. */
export const DEV_BACKEND_PORT = 3000;
export const DEV_VITE_PORT = 5173;
export const DEV_CADDY_PORT = 8080;

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

/** cambio de rama (exec por el CLI): fetch + checkout + install si cambió el
 * lockfile + reset de la DB + RECARGA de la config por-rama (dev.env). tsx/vite
 * recogen los archivos solos; la NUEVA dev.env se aplica reiniciando backend/vite
 * vía el sentinel /workspace/.dev/restart (los supervisores de boot-preview.sh la
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
function caddyfile(
  backendPort: number,
  vitePort: number,
  liveBase?: string,
  forma: { frontend: boolean; backend: boolean } = { frontend: true, backend: true },
  rutas: Record<string, number> = {},
): string {
  // rutas extra declaradas por la app (mke.preview.yaml `rutas:`): prefijo →
  // puerto loopback del pod. handle_path RECORTA el prefijo antes de proxear
  // (p.ej. /vnc/vnc.html → :6080/vnc.html). Van PRIMERO: ganan al catch-all.
  const extras = Object.entries(rutas)
    .map(([p, puerto]) => {
      const prefijo = p.endsWith("/") ? p : `${p}/`;
      return `\thandle_path ${prefijo}* {
\t\treverse_proxy 127.0.0.1:${puerto}
\t}
`;
    })
    .join("");
  // backend-only: NO hay vite — todo el host va al backend (un solo origen se
  // conserva: ingress→caddy→backend). El readiness del pod prueba /health por
  // esta misma cadena.
  if (!forma.frontend) {
    return `:${DEV_CADDY_PORT} {
${extras}	handle {
		reverse_proxy 127.0.0.1:${backendPort}
	}
}
`;
  }
  // frontend-only: sin backend no hay a quién proxear /api|/health|/dev.
  if (!forma.backend) {
    return `:${DEV_CADDY_PORT} {
${extras}	handle {
		reverse_proxy 127.0.0.1:${vitePort}
	}
}
`;
  }
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
${extras}	handle /api/* {
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

export type K8sManifest = Record<string, unknown>;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// ─── preview-pod (`mke preview`, verbo DEFINITIVO — fusión 2026-07-11) — pod
// EFÍMERO atado a la vida de la RAMA. Reusa la maquinaria compartida de arriba
// (init clona+instala, vite HMR + tsx watch, caddy un-solo-origen, POSTGRES
// EFÍMERO como sidecar) con las diferencias de fondo del verbo:
//  - namespace/host PROPIOS, con la rama SIEMPRE en el nombre: `<app>-<slug(rama)>`,
//    host BARE (sin sufijo) `<app>-<slug(rama)>.mishi.com.co` (un solo label DNS).
//  - DB = SIDECAR postgres efímero (emptyDir): muere con el pod, sin DROP central.
//    `DATABASE_URL` apunta al loopback (`127.0.0.1:5432/dev`). Migrar/sembrar y
//    `--espejo` los orquesta el CLI por `kubectl exec` tras el rollout (igual
//    patrón que `mishi-studio/scripts/iterar-rama.sh`); el boot además corre un
//    `db:migrate` idempotente para auto-sanar el schema si el pod reinicia.
//  - Secretos/config resueltos por un LEASE del vault (Contrato 1): el token del
//    lease viaja en un Secret propio `<name>-lease` + env `LEASE_TOKEN`, y TODO
//    el bundle lleva los labels `mke.preview/app|rama|lease`. La `config` NO
//    sensible del manifiesto `mke.preview.yaml` (Contrato 2) va directo al env
//    en claro. CERO `--env` humano. DEGRADACIÓN interina: si el vault aún no
//    tiene el escenario 4, el CLI arranca SIN lease (`leaseId="sin-lease"`, sin
//    Secret de lease) — el pod corre igual para probar pod+DB+HMR.

export const PREVIEW_NAMESPACE = "preview";
/** valor del label `mke.preview/lease` cuando se arranca sin lease (vault sin escenario 4). */
export const PREVIEW_SIN_LEASE = "sin-lease";
/** host BARE (sin sufijo): `<app>-<slug(rama)>.mishi.com.co`, un solo label DNS. */
export const PREVIEW_HOST_SUFFIX = "";
export const PREVIEW_RUNNER_IMAGE = DEV_RUNNER_IMAGE;

/** nombre del preview-pod: `<app>-<slug(rama)>`, saneado y recortado (≤50) para
 * que el host BARE quede bien dentro del límite de 63 de un label DNS. */
export function previewPodName(app: string, rama: string): string {
  const slugRama = slugDev(rama);
  const s = `${app}-${slugRama}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`no pude derivar un nombre de preview válido de '${app}'/'${rama}'`);
  return s;
}

/** host público del preview-pod: `<app>-<slug(rama)>.mishi.com.co` (BARE). */
export function previewPodHost(
  app: string,
  rama: string,
  opts: { hostSuffix?: string; domain?: string } = {},
): string {
  const suffix = opts.hostSuffix ?? PREVIEW_HOST_SUFFIX;
  const domain = opts.domain ?? DEV_DOMAIN;
  return `${previewPodName(app, rama)}${suffix}.${domain}`;
}

/** labelSelector canónico del bundle de un preview-pod, por app×rama. */
export function selectorDePreview(app: string, rama: string): string {
  return `mke.preview/app=${app},mke.preview/rama=${slugDev(rama)}`;
}

/** boot del preview-pod: espera al SIDECAR postgres y corre un \`db:migrate\`
 * idempotente (auto-sana el schema si el pod reinició con la DB efímera vacía).
 * NO resetea ni siembra: la siembra inicial y el \`--espejo\` los orquesta el CLI
 * por kubectl exec tras el rollout (para que \`up\` controle sembrar vs espejo). */
const BOOT_PREVIEW_SH = `#!/bin/sh
set -eu
cd /workspace/repo
mkdir -p /workspace/.dev
rm -f /workspace/.dev/restart
RAMA_ACTIVA=$(cat /workspace/.dev/rama 2>/dev/null || echo "$RAMA")

# La FORMA de la app se DERIVA del árbol del repo (apps/backend, apps/frontend)
# también acá en runtime — cinturón y tirantes con la derivación del CLI, que
# decide qué contenedores existen (sin backend no hay sidecar postgres).
if [ -d apps/backend ]; then
  echo "[preview] esperando postgres…"
  until pg_isready -h 127.0.0.1 -p 5432 -U dev >/dev/null 2>&1; do sleep 2; done
fi

# config PÚBLICA por-rama declarada por la app (k8s/dev.env) → al entorno ANTES
# de migrar/arrancar la app. La config del Contrato 2 (mke.preview.yaml) ya vino
# por env del Deployment; \`cargar-dev-env.sh\` es un complemento opcional del repo.
. /mke/cargar-dev-env.sh

# migración idempotente de auto-sanado (si el pod reinició con la DB vacía). La
# siembra/espejo inicial la corre el CLI tras el rollout — acá NO se siembra.
if [ -d apps/backend ]; then
  npm run db:migrate -w apps/backend || echo "[preview] db:migrate en boot falló (sigo; el CLI lo reintenta)"
fi

FRONT=apps/frontend
if [ -d "$FRONT" ] && [ -f /mke/vite.dev.mke.config.ts ]; then
  cp /mke/vite.dev.mke.config.ts "$FRONT/vite.dev.mke.config.ts"
fi

matar_arbol() {
  for hijo in $(cat /proc/"$1"/task/"$1"/children 2>/dev/null); do matar_arbol "$hijo"; done
  kill -TERM "$1" 2>/dev/null || true
}

supervisar() {
  etiqueta="$1"; shift
  intento=0
  while true; do
    . /mke/cargar-dev-env.sh
    "$@" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f /workspace/.dev/restart ]; then
        echo "[preview] reinicio de $etiqueta (cambió la rama/config)"
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
      echo "[preview] $etiqueta murió (intento $intento) — reinicio en \${espera}s"
      sleep "$espera"
    fi
  done
}

# Hook de boot POR-APP (derivado del árbol, como la forma): si el repo trae
# k8s/preview-boot.sh, se supervisa como un proceso más ANTES de la app — ahí
# la app arranca lo que su runtime necesite (p.ej. Xvfb/x11vnc/noVNC para un
# Chrome headful). Corre con la misma dev.env cargada.
if [ -f k8s/preview-boot.sh ]; then
  echo "[preview] hook de boot de la app (k8s/preview-boot.sh)"
  supervisar preview-boot sh k8s/preview-boot.sh &
fi

if [ -d apps/backend ]; then
  echo "[preview] backend tsx watch en :$BACKEND_PORT"
  supervisar backend sh -c 'npm run dev -w apps/backend' &
fi

if [ -d apps/frontend ]; then
  echo "[preview] vite dev en :$VITE_PORT"
  supervisar vite sh -c "cd '$FRONT' && npx vite -c vite.dev.mke.config.ts" &
fi

if [ ! -d apps/backend ] && [ ! -d apps/frontend ]; then
  echo "[preview] la rama no tiene apps/backend ni apps/frontend — nada que arrancar" >&2
  exit 1
fi

if [ "\${POLL_SECONDS:-0}" -gt 0 ] 2>/dev/null; then
  echo "[preview] poll cada \${POLL_SECONDS}s sobre $RAMA_ACTIVA"
  sh /mke/poll.sh &
fi

wait
`;

export interface PreviewRecetaInput {
  /** nombre público/corto de la app (prefijo de nombre y host; ej `mishi-bank`). */
  app: string;
  /** rama git a encender (SIEMPRE en el nombre; a diferencia de `mke dev`). */
  rama: string;
  /** URL de clone (puede llevar el token embebido). */
  repoUrl: string;
  /** identidad del lease del vault (Contrato 1) — va en el label `mke.preview/lease`.
   * En modo degradado (vault sin escenario 4) es `PREVIEW_SIN_LEASE`. */
  leaseId: string;
  /** token del lease (Contrato 1): el pod lo usa para leer sus secretos del vault.
   * Viaja en un Secret propio (`<name>-lease`), NUNCA en claro en el Deployment.
   * Ausente ⇒ modo degradado (sin Secret de lease ni env `LEASE_TOKEN`). */
  leaseToken?: string;
  /** mapa `config` del manifiesto `mke.preview.yaml` (Contrato 2): NO-secretos,
   * van directo al env del pod en claro (URLs internas, flags). */
  config?: Record<string, string>;
  /** imagen genérica del runner (default = la de `mke dev`). */
  imagen?: string;
  namespace?: string;
  hostSuffix?: string;
  domain?: string;
  pollSeconds?: number;
  live?: boolean;
  /** token de LECTURA de GitHub Packages (opcional, igual que en `mke dev`). */
  npmToken?: string;
  /** FORMA de la app, DERIVADA por el CLI del árbol del worktree de la rama
   * (existsSync apps/frontend|apps/backend) — la verdad se deriva, no se declara.
   * Default: forma completa (backend+frontend), idéntica a la receta histórica. */
  frontend?: boolean;
  backend?: boolean;
  /** rutas extra del caddy (mke.preview.yaml `rutas:`): prefijo → puerto loopback. */
  rutas?: Record<string, number>;
}

/**
 * Namespace + Secret(s) + ConfigMap + Deployment + Service + Ingress del
 * preview-pod, como OBJETOS. Misma anatomía de arriba (init clona + instala,
 * vite HMR + tsx watch, caddy un-solo-origen, POSTGRES efímero sidecar)
 * pero: namespace/host/nombre propios con la RAMA en el nombre; CERO `--env`
 * humano (la `config` del Contrato 2 va al env en claro y el `leaseToken` del
 * Contrato 1 va en un Secret propio + env `LEASE_TOKEN`); TODO objeto del bundle
 * lleva los labels `mke.preview/app|rama|lease`.
 */
export function manifiestosPreview(inp: PreviewRecetaInput): K8sManifest[] {
  const app = inp.app;
  const rama = inp.rama;
  const namespace = inp.namespace ?? PREVIEW_NAMESPACE;
  const imagen = inp.imagen ?? PREVIEW_RUNNER_IMAGE;
  const pollSeconds = inp.pollSeconds ?? 0;
  const name = previewPodName(app, rama);
  const host = previewPodHost(app, rama, { hostSuffix: inp.hostSuffix, domain: inp.domain });
  const liveBase = inp.live ? devLiveBase(app) : undefined;
  const ramaSlug = slugDev(rama);
  const forma = { frontend: inp.frontend ?? true, backend: inp.backend ?? true };
  if (!forma.frontend && !forma.backend) {
    throw new Error(`la app ${app} (rama ${rama}) no tiene apps/backend ni apps/frontend — nada que encender`);
  }
  if (liveBase && !forma.frontend) {
    throw new Error(`--live (modo EMBED) requiere frontend y la rama ${rama} de ${app} no tiene apps/frontend`);
  }

  const labels: Record<string, string> = {
    "mke.preview/app": app,
    "mke.preview/rama": ramaSlug,
    "mke.preview/lease": inp.leaseId,
  };

  const namespaceObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespace, labels: { "app.kubernetes.io/part-of": "mke-preview" } },
  };

  const secretObj: K8sManifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: `${name}-git`, namespace, labels },
    type: "Opaque",
    data: { REPO_URL: b64(inp.repoUrl) },
  };

  // token del lease (Contrato 1) → Secret propio + env LEASE_TOKEN. NUNCA los
  // valores de `secretos` en claro: eso lo materializa el vault con este token.
  // Sin leaseToken ⇒ modo degradado (vault sin escenario 4): no hay Secret.
  const leaseSecretObj: K8sManifest | null = inp.leaseToken
    ? {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `${name}-lease`, namespace, labels },
        type: "Opaque",
        data: { LEASE_TOKEN: b64(inp.leaseToken) },
      }
    : null;
  const leaseTokenEnv = inp.leaseToken
    ? [{ name: "LEASE_TOKEN", valueFrom: { secretKeyRef: { name: `${name}-lease`, key: "LEASE_TOKEN" } } }]
    : [];

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
    ? [{ name: "NODE_AUTH_TOKEN", valueFrom: { secretKeyRef: { name: `${name}-npm`, key: "NODE_AUTH_TOKEN" } } }]
    : [];

  const configMapObj: K8sManifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `${name}-scripts`, namespace, labels },
    data: {
      "prepare.sh": PREPARE_SH,
      "build-packages.sh": BUILD_PACKAGES_SH,
      "cargar-dev-env.sh": CARGAR_DEV_ENV_SH,
      "boot-preview.sh": BOOT_PREVIEW_SH,
      "rama.sh": RAMA_SH,
      "pull.sh": PULL_SH,
      "poll.sh": POLL_SH,
      ...(forma.frontend ? { "vite.dev.mke.config.ts": viteDevConfig(DEV_VITE_PORT, liveBase) } : {}),
      Caddyfile: caddyfile(DEV_BACKEND_PORT, DEV_VITE_PORT, liveBase, forma, inp.rutas ?? {}),
    },
  };

  // config (Contrato 2) va DIRECTO al env, en claro (no son secretos). PREVIEW=true
  // (convención existente) + PREVIEW_MODE=true (contrato de siembra de este verbo).
  // DATABASE_URL apunta al SIDECAR loopback (la DB efímera muere con el pod).
  const configEnv = Object.entries(inp.config ?? {}).map(([k, value]) => ({ name: k, value }));
  const devEnv: { name: string; value: string }[] = [
    { name: "APP", value: app },
    { name: "RAMA", value: rama },
    { name: "PREVIEW", value: "true" },
    { name: "PREVIEW_MODE", value: "true" },
    { name: "NODE_ENV", value: "development" },
    { name: "PORT", value: String(DEV_BACKEND_PORT) },
    { name: "BACKEND_PORT", value: String(DEV_BACKEND_PORT) },
    { name: "VITE_PORT", value: String(DEV_VITE_PORT) },
    { name: "POLL_SECONDS", value: String(pollSeconds) },
    ...(forma.backend ? [{ name: "DATABASE_URL", value: "postgres://dev:dev@127.0.0.1:5432/dev" }] : []),
    ...configEnv,
  ];

  const podLabels = { app: name, ...labels };

  const deploymentObj: K8sManifest = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      labels,
      annotations: {
        "mke.preview/rama": rama,
        "mke.preview/sha": "",
        ...(liveBase ? { "mke.dev/live": "true" } : {}),
      },
    },
    spec: {
      replicas: 1,
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
              env: [
                { name: "APP", value: app },
                { name: "RAMA", value: rama },
                { name: "REPO_URL", valueFrom: { secretKeyRef: { name: `${name}-git`, key: "REPO_URL" } } },
                ...npmTokenEnv,
              ],
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "scripts", mountPath: "/mke" },
              ],
            },
          ],
          containers: [
            ...(forma.backend ? [{
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
            }] : []),
            {
              name: "dev",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "/mke/boot-preview.sh"],
              env: [...devEnv, ...leaseTokenEnv, ...npmTokenEnv],
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
                // backend-only: /health prueba la cadena completa caddy→backend
                // (el / de un backend puede ser 404 legítimo). Con frontend, /
                // prueba caddy→vite como siempre.
                httpGet: { path: forma.frontend ? "/" : "/health", port: DEV_CADDY_PORT },
                periodSeconds: 5,
                failureThreshold: 120,
              },
              volumeMounts: [{ name: "scripts", mountPath: "/mke" }],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            ...(forma.backend ? [{ name: "pgdata", emptyDir: {} }] : []),
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
        { host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { number: 80 } } } }] } },
      ],
    },
  };

  return [
    namespaceObj,
    secretObj,
    ...(leaseSecretObj ? [leaseSecretObj] : []),
    ...(npmSecretObj ? [npmSecretObj] : []),
    configMapObj,
    deploymentObj,
    serviceObj,
    ingressObj,
  ];
}
