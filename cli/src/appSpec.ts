// FORMA de una app, DERIVADA de su repo — nunca declarada dos veces.
//
// El `ci-cd.yml` de cada app venía repitiendo a mano lo mismo que el árbol ya
// dice (¿tiene frontend?, ¿tiene migraciones drizzle?, ¿cuál es el subdominio
// público?). Este módulo es el único lugar que lo deriva, y lo consumen
// `mke deploy`, la compuerta de migraciones y el catálogo.
//
// Fuentes, en orden de autoridad (todas COMO CÓDIGO dentro del repo del app —
// nada de registro central ni de flags obligatorias en el workflow):
//   1. `--host` / `--dir` / `--deploy` explícitos del CLI.
//   2. el overlay REAL que se va a aplicar (`value:` del patch del Ingress en
//      `k8s/overlays/<env>/kustomization.yaml`) — es lo que de verdad queda
//      servido.
//   3. `.mishi-app.json` (lo escribe create-mishi-app): `respuestas.subdominio`
//      y `respuestas.conFrontend`.
//   4. el árbol: existe `apps/frontend/` ⇒ hay front; existe
//      `apps/backend/drizzle/meta/_journal.json` ⇒ hay compuerta de migraciones.
//
// Si el subdominio difiere del id interno (omni-whatsapp → omni), la verdad
// está en el overlay / `.mishi-app.json`, no en una tabla aparte.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appsRoot, envOrThrow, hostFor } from "./mkeConfig.js";
import { toSnake } from "./dbProvision.js";
import { run } from "./sh.js";

export interface AppSpec {
  /** id interno del app (= id de imagen, nombre de Deployment por default). */
  app: string;
  env: string;
  /** raíz del checkout del repo. */
  dir: string;
  /** `k8s/overlays/<env>` — lo que se aplica. */
  overlay: string;
  /** host público que sirve esta app en este entorno. */
  host: string;
  /** subdominio = primer label del host sin sufijo de entorno; ES el subPath del PVC static-www. */
  front: string;
  /** nombre del Deployment (override con --deploy). */
  deployName: string;
  /** nombre del contenedor del Deployment (por convención = app). */
  contenedor: string;
  tieneBackend: boolean;
  tieneFrontend: boolean;
  /** apps/backend/drizzle con al menos el journal → hay compuerta de migraciones. */
  tieneDrizzle: boolean;
  drizzleDir: string;
  tablasSensiblesPath: string;
  /** nombre de la BD/rol en postgres-mishi (una BD por app). */
  db: string;
  /** Secret k8s con DATABASE_URL/SESSION_SECRET. */
  secretK8s: string;
}

/** primer label del host, sin el sufijo del entorno: `status-stage.mishi.com.co` → `status`. */
export function frontDeHost(host: string, env: string): string {
  const label = host.split(".")[0];
  const suffix = envOrThrow(env).hostSuffix;
  return suffix && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

/**
 * Host que declara el overlay del entorno (patch `op: replace` del Ingress).
 * Devuelve null si el overlay no parchea el host (app que usa la convención).
 */
export function hostDeOverlayTexto(kustomizationYaml: string): string | null {
  // el patch es un JSON6902 embebido: `value: <fqdn>` (con comentario opcional).
  const m = kustomizationYaml.match(/^\s*value:\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*(?:#.*)?$/im);
  return m ? m[1] : null;
}

export interface MishiApp {
  subdominio?: string;
  conFrontend?: boolean;
}

/** Lee `.mishi-app.json` del repo (lo escribe create-mishi-app). {} si no está. */
export function leerMishiApp(dir: string): MishiApp {
  const p = join(dir, ".mishi-app.json");
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { respuestas?: MishiApp };
    return j.respuestas ?? {};
  } catch {
    return {};
  }
}

export interface AppSpecOpts {
  dir?: string;
  host?: string;
  deploy?: string;
}

/** Deriva la forma de la app leyendo su árbol. Lanza si el repo/overlay no existen. */
export function derivarAppSpec(app: string, env: string, opts: AppSpecOpts = {}): AppSpec {
  envOrThrow(env);
  const dir = opts.dir ?? join(appsRoot(), app);
  if (!existsSync(dir)) {
    throw new Error(`no existe el repo del app: ${dir} (pasá --dir o exportá MKE_APPS_ROOT)`);
  }
  const overlay = join(dir, "k8s", "overlays", env);
  if (!existsSync(overlay)) throw new Error(`no existe el overlay: ${overlay}`);

  const manifiesto = leerMishiApp(dir);
  const kustomization = join(overlay, "kustomization.yaml");
  const hostOverlay = existsSync(kustomization)
    ? hostDeOverlayTexto(readFileSync(kustomization, "utf8"))
    : null;
  const host = opts.host ?? hostOverlay ?? hostFor(manifiesto.subdominio ?? app, env);

  const drizzleDir = join(dir, "apps", "backend", "drizzle");
  const tieneDrizzle = existsSync(join(drizzleDir, "meta", "_journal.json"));
  // el árbol manda sobre `conFrontend`: si hay Dockerfile de frontend, hay front.
  const tieneFrontend =
    existsSync(join(dir, "apps", "frontend", "Dockerfile")) ||
    (manifiesto.conFrontend === true && existsSync(join(dir, "apps", "frontend")));

  return {
    app,
    env,
    dir,
    overlay,
    host,
    front: manifiesto.subdominio ?? frontDeHost(host, env),
    deployName: opts.deploy ?? app,
    contenedor: app,
    tieneBackend: existsSync(join(dir, "apps", "backend", "Dockerfile")),
    tieneFrontend,
    tieneDrizzle,
    drizzleDir,
    tablasSensiblesPath: join(dir, "apps", "backend", "db", "tablas-sensibles.txt"),
    db: toSnake(app),
    secretK8s: `${app}-secrets`,
  };
}

/** SHA corto (12) del checkout — el tag inmutable de la imagen, igual que el CI. */
export async function shaCorto(dir: string): Promise<string> {
  const r = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (r.code !== 0 || !r.stdout.trim()) return "dev";
  return r.stdout.trim().slice(0, 12);
}
