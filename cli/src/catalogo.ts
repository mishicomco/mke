// CATÁLOGO DERIVADO — qué apps/hosts existen en el cluster, publicado como
// ConfigMap `mke-catalogo` (data `catalogo.json`) en los ns `stage` y `prod`.
//
// Regla de la jerarquía de verdad (../CLAUDE.md): la verdad se pudre donde se
// DECLARA. Así que el catálogo NO se declara en ningún lado: se DERIVA de los
// Ingress VIVOS del cluster —
//   - Ingress con `app.kubernetes.io/part-of: mke` = una app con BACKEND
//     (su propio pod sirviendo /api|/v1|/salud) → `api: true`, `ruta` = el
//     primer path de salud que declare.
//   - hosts del Ingress `static-mishi` = fronts servidos del PVC compartido
//     → `front: true`. Si el host también tiene backend, gana `api: true`.
// Si una app deja de existir, desaparece del catálogo sola en el próximo deploy.
//
// CONTRATO con status-mishi (2026-07-27): AMBAS copias (stage y prod) llevan el
// catálogo COMPLETO del cluster — hosts de stage Y de prod juntos. status es un
// tablero de todo el ecosistema y necesita la vista cruzada; el ambiente lo
// deriva del sufijo del host (`-stage`). Formato: [{app, host, api}] (+ `front`
// y `ruta`, campos añadidos, no rompen a quien solo lee los tres primeros).
//
// Se regenera en cada `mke deploy` y en cada `mke app init`.

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envOrThrow } from "./mkeConfig.js";
import { frontDeHost } from "./appSpec.js";
import { run, ok, warn, dim } from "./sh.js";

export const NOMBRE_CONFIGMAP = "mke-catalogo";
export const CLAVE_DATA = "catalogo.json";
/** entornos que entran al catálogo y lo publican (local es el laptop). */
export const ENVS_CATALOGO = ["stage", "prod"] as const;

export interface EntradaCatalogo {
  app: string;
  host: string;
  api: boolean;
  /** el front del host lo sirve static-mishi desde el PVC compartido. */
  front: boolean;
  /** path de salud propio del backend, derivado del ingress (null si no hay API). */
  ruta: string | null;
}

export interface IngressLite {
  name: string;
  labels: Record<string, string>;
  hosts: string[];
  /** paths declarados por el ingress (para derivar la ruta de salud). */
  paths: string[];
}

/** Aplana la salida de `kubectl get ingress -o json` a lo poco que importa. */
export function parsearIngresses(salidaJson: string): IngressLite[] {
  let items: unknown[] = [];
  try {
    items = (JSON.parse(salidaJson) as { items?: unknown[] }).items ?? [];
  } catch {
    return [];
  }
  return items.map((it) => {
    const i = it as {
      metadata?: { name?: string; labels?: Record<string, string> };
      spec?: { rules?: Array<{ host?: string; http?: { paths?: Array<{ path?: string }> } }> };
    };
    const rules = i.spec?.rules ?? [];
    return {
      name: i.metadata?.name ?? "",
      labels: i.metadata?.labels ?? {},
      hosts: rules.map((r) => r.host ?? "").filter(Boolean),
      paths: rules.flatMap((r) => (r.http?.paths ?? []).map((p) => p.path ?? "")).filter(Boolean),
    };
  });
}

/** Ruta de salud preferida entre los paths que declara un ingress. */
export function rutaDeSalud(paths: string[]): string | null {
  for (const preferida of ["/salud", "/health", "/api", "/v1"]) {
    if (paths.includes(preferida)) return preferida;
  }
  return paths[0] ?? null;
}

/**
 * Catálogo de UN entorno a partir de sus Ingress vivos. PURA — es lo único que
 * hay que testear; el resto es kubectl.
 */
export function derivarCatalogo(ingresses: IngressLite[], env: string): EntradaCatalogo[] {
  const porHost = new Map<string, EntradaCatalogo>();

  for (const ing of ingresses) {
    const esStatic = ing.name === "static-mishi";
    const esMke = ing.labels["app.kubernetes.io/part-of"] === "mke";
    if (!esStatic && !esMke) continue;
    for (const host of ing.hosts) {
      const previo = porHost.get(host);
      if (esStatic) {
        if (previo) previo.front = true;
        else porHost.set(host, { app: frontDeHost(host, env), host, api: false, front: true, ruta: null });
        continue;
      }
      const app = ing.labels["app.kubernetes.io/name"] ?? ing.name;
      porHost.set(host, {
        app,
        host,
        api: true,
        front: previo?.front ?? false,
        ruta: rutaDeSalud(ing.paths),
      });
    }
  }

  return ordenar([...porHost.values()]);
}

function ordenar(entradas: EntradaCatalogo[]): EntradaCatalogo[] {
  return entradas.sort((a, b) => a.app.localeCompare(b.app) || a.host.localeCompare(b.host));
}

/** Lee los Ingress vivos de un entorno y devuelve su catálogo (null si no se pudo leer). */
export async function catalogoDelEntorno(env: string): Promise<EntradaCatalogo[] | null> {
  const spec = envOrThrow(env);
  // Un ns inexistente NO es "cero ingresses": kubectl responde lista vacía con
  // exit 0 y el catálogo saldría MUDO sin ese ambiente (desde un nodo de la
  // flota que no ve el otro cluster, p.ej. el laptop no ve stage). Ns ausente
  // = entorno ilegible, para que el rescate de abajo conserve sus entradas.
  const ns = await run("kubectl", ["--context", spec.context, "get", "namespace", spec.namespace, "-o", "name"]);
  if (ns.code !== 0) return null;
  const r = await run("kubectl", ["--context", spec.context, "-n", spec.namespace, "get", "ingress", "-o", "json"]);
  if (r.code !== 0) return null;
  return derivarCatalogo(parsearIngresses(r.stdout), env);
}

/** ¿La entrada pertenece a este entorno? Mismo contrato que status-mishi: por sufijo del host. */
export function entradaDeEnv(e: EntradaCatalogo, env: string): boolean {
  const esStage = e.host.includes("-stage.");
  return env === "stage" ? esStage : !esStage;
}

/** Lee el ConfigMap `mke-catalogo` ya publicado en un entorno (null si no hay). */
async function catalogoPublicado(env: string): Promise<EntradaCatalogo[] | null> {
  const spec = envOrThrow(env);
  const r = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "get", "configmap", NOMBRE_CONFIGMAP, "-o", `jsonpath={.data.${CLAVE_DATA.replace(".", "\\.")}}`,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout) as EntradaCatalogo[];
  } catch {
    return null;
  }
}

/**
 * Catálogo COMPLETO del cluster: stage + prod juntos (contrato con status-mishi).
 * Si un entorno no se puede leer (nodo de la flota que no ve ese cluster), sus
 * entradas se RESCATAN del último catálogo publicado en los entornos legibles —
 * viejas es mejor que borradas en silencio; el dueño de ese ambiente las
 * refresca en su próximo deploy. Solo si no hay de dónde rescatar, se omite.
 */
export async function catalogoCompleto(): Promise<EntradaCatalogo[]> {
  const todo: EntradaCatalogo[] = [];
  const ilegibles: string[] = [];
  const legibles: string[] = [];
  for (const env of ENVS_CATALOGO) {
    const parcial = await catalogoDelEntorno(env);
    if (parcial === null) {
      ilegibles.push(env);
      continue;
    }
    legibles.push(env);
    todo.push(...parcial);
  }
  for (const env of ilegibles) {
    let rescatadas: EntradaCatalogo[] | null = null;
    for (const fuente of legibles) {
      const publicado = await catalogoPublicado(fuente);
      if (publicado) {
        rescatadas = publicado.filter((e) => entradaDeEnv(e, env));
        break;
      }
    }
    if (rescatadas && rescatadas.length > 0) {
      console.log(warn(`catálogo: ${env} no es legible desde este nodo — conservo sus ${rescatadas.length} entrada(s) del catálogo publicado`));
      todo.push(...rescatadas);
    } else {
      console.log(warn(`catálogo: no pude leer los ingress de ${env} ni rescatar su catálogo publicado (queda fuera)`));
    }
  }
  return ordenar(todo);
}

/** Aplica el ConfigMap `mke-catalogo` (catálogo completo) en un entorno. */
export async function aplicarCatalogo(env: string, catalogo: EntradaCatalogo[]): Promise<boolean> {
  const spec = envOrThrow(env);
  const archivo = join(tmpdir(), `mke-catalogo-${env}.json`);
  writeFileSync(archivo, `${JSON.stringify(catalogo, null, 2)}\n`);
  const yaml = join(tmpdir(), `mke-catalogo-${env}.yaml`);
  try {
    const generado = await run("kubectl", [
      "--context", spec.context, "-n", spec.namespace,
      "create", "configmap", NOMBRE_CONFIGMAP,
      `--from-file=${CLAVE_DATA}=${archivo}`,
      "--dry-run=client", "-o", "yaml",
    ]);
    if (generado.code !== 0) return false;
    writeFileSync(yaml, generado.stdout);
    const apply = await run("kubectl", ["--context", spec.context, "apply", "-f", yaml]);
    return apply.code === 0;
  } finally {
    for (const f of [archivo, yaml]) {
      try { unlinkSync(f); } catch { /* tmp ya no está */ }
    }
  }
}

/**
 * Regenera el ConfigMap `mke-catalogo` en stage Y prod, ambos con el catálogo
 * COMPLETO del cluster. Best-effort y NUNCA fatal: un catálogo desactualizado
 * no justifica tumbar un deploy que ya está sano.
 */
export async function regenerarCatalogos(): Promise<void> {
  const catalogo = await catalogoCompleto();
  for (const env of ENVS_CATALOGO) {
    const aplicado = await aplicarCatalogo(env, catalogo);
    if (!aplicado) console.log(warn(`catálogo de ${env} no se pudo aplicar (sigo)`));
    else console.log(ok(`catálogo ${dim(`${NOMBRE_CONFIGMAP} (${env})`)} regenerado — ${catalogo.length} host(s) del cluster`));
  }
}
