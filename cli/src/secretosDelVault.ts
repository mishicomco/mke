// SECRET K8S = DERIVADO DEL VAULT (fase MATERIALIZAR de `mke deploy`).
//
// Cicatriz (2026-07-28): los `<app>-secrets` del cluster eran la ÚNICA copia de
// verdad de decenas de claves (llaves ES256 del IdP, allowlists, API keys). Un
// `kubectl apply` de más las borró; nadie sabía qué claves debían existir. Desde
// el rescate al vault-mishi (137 secretos, v1) el DUEÑO de esa verdad es el
// vault y el Secret k8s pasa a ser DERIVADO: cada deploy lo re-materializa.
//
// Leyes de esta fase:
//   1. MERGEAR, jamás reemplazar (patch --type merge). Una clave del cluster que
//      el vault no conoce se CONSERVA y se reporta WARN "clave huérfana no
//      rescatada" — el vault todavía no lo sabe todo.
//   2. El vault MANDA: si una clave está en ambos lados, gana el valor del vault.
//   3. SPOF asumido: si el vault no responde, WARN y seguir con lo que ya está
//      materializado en el cluster. Degradar, no caer.
//   4. Ningún valor se imprime JAMÁS — ni en logs, ni en errores, ni en dry-run.
//
// Esquema de nombres del vault (decidido con vault-mishi, 2026-07-27):
//   ns = `<app>` · nombre = `<CLAVE>__<stage|prod>`. La clave del Secret k8s es
//   el nombre SIN el sufijo. `local` no vive en el vault (entorno de laptop).

import { rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VAULT, envOrThrow } from "./mkeConfig.js";
import { run } from "./sh.js";

// ─────────────────────────── lógica PURA (testeable) ────────────────────────

/** sufijo de nombre del vault para un entorno; null = el entorno no vive en el vault. */
export function sufijoEnv(env: string): string | null {
  return env === "stage" || env === "prod" ? env : null;
}

/**
 * `MISHI_BANK_SESSION_SECRET__stage` + env `stage` → `MISHI_BANK_SESSION_SECRET`.
 * Devuelve null si el nombre no pertenece a ESE entorno (otro sufijo, o ninguno).
 */
export function claveDeNombre(nombre: string, env: string): string | null {
  const sufijo = sufijoEnv(env);
  if (!sufijo) return null;
  const cola = `__${sufijo}`;
  if (!nombre.endsWith(cola)) return null;
  const clave = nombre.slice(0, -cola.length);
  return clave.length > 0 ? clave : null;
}

export interface ClaveDelVault {
  /** clave del Secret k8s (nombre sin sufijo). */
  clave: string;
  /** nombre completo en el vault (con sufijo). */
  nombre: string;
}

/** Filtra los nombres de un ns a los que aplican a ESTE entorno, ya mapeados a clave. */
export function clavesDelEntorno(nombres: string[], env: string): ClaveDelVault[] {
  const out: ClaveDelVault[] = [];
  for (const nombre of nombres) {
    const clave = claveDeNombre(nombre, env);
    if (clave) out.push({ clave, nombre });
  }
  return out.sort((a, b) => a.clave.localeCompare(b.clave));
}

export interface PlanMaterializacion {
  /** claves que se traen del vault y se escriben al Secret (el vault manda). */
  aMaterializar: ClaveDelVault[];
  /** claves vivas en el cluster que el vault NO conoce: se CONSERVAN, se avisan. */
  huerfanas: string[];
}

/**
 * Plan de merge. `enCluster` = claves vivas del Secret k8s. Nunca se borra nada:
 * las huérfanas solo se reportan.
 */
export function planMaterializacion(
  delVault: ClaveDelVault[],
  enCluster: string[],
): PlanMaterializacion {
  const conocidas = new Set(delVault.map((c) => c.clave));
  return {
    aMaterializar: delVault,
    huerfanas: enCluster.filter((k) => !conocidas.has(k)).sort(),
  };
}

export interface ComparacionDeclaracion {
  /** declarado en `mke.preview.yaml` y AUSENTE del vault para este env → FAIL. */
  faltantes: string[];
  /** en el vault y NO declarado → WARN (transición; ver nota de fail-closed). */
  noDeclarados: string[];
}

/**
 * Declaración (`secretos:` de `mke.preview.yaml`) vs. lo que el vault tiene para
 * este entorno.
 *
 * TRANSICIÓN (2026-07-28): hoy `faltantes` es FAIL (falta el valor: el deploy
 * arrancaría la app sin un secreto que ella misma dice necesitar) y
 * `noDeclarados` es solo WARN, porque casi ninguna app declara todavía. Cuando
 * TODAS las apps tengan `mke.preview.yaml` con su `secretos:` completo, esta
 * compuerta pasa a fail-closed total: `noDeclarados` también aborta el deploy y
 * la declaración se vuelve el contrato único. No adelantar ese día — rompería
 * todos los deploys vivos.
 */
export function compararDeclaracion(
  declarados: string[],
  clavesEnVault: string[],
): ComparacionDeclaracion {
  const enVault = new Set(clavesEnVault);
  const declaradosSet = new Set(declarados);
  return {
    faltantes: declarados.filter((d) => !enVault.has(d)).sort(),
    noDeclarados: clavesEnVault.filter((c) => !declaradosSet.has(c)).sort(),
  };
}

// ─────────────────────────── cliente HTTP del vault ─────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface AccesoVault {
  url: string;
  /** token de la identidad `mke-runner-deploy` (tipo ci). NUNCA se imprime. */
  token: string;
  fetchImpl?: FetchLike;
}

/**
 * Acceso del runner: token del archivo 0600 (`VAULT.deployTokenFile`) o de la
 * env `VAULT_DEPLOY_TOKEN`. null = sin credencial → la fase degrada con WARN.
 * Crear la identidad: `scripts/crear-identidad-vault-mke.sh`.
 */
export async function accesoDeploy(): Promise<AccesoVault | null> {
  const delEntorno = process.env.VAULT_DEPLOY_TOKEN?.trim();
  if (delEntorno) return { url: VAULT.url, token: delEntorno };
  try {
    const token = (await readFile(VAULT.deployTokenFile, "utf8")).trim();
    return token ? { url: VAULT.url, token } : null;
  } catch {
    return null;
  }
}

function f(acc: AccesoVault): FetchLike {
  return acc.fetchImpl ?? (fetch as unknown as FetchLike);
}

function cabeceras(acc: AccesoVault): Record<string, string> {
  return { Authorization: `Bearer ${acc.token}`, "content-type": "application/json" };
}

/** Cabeceras SIN content-type — para requests sin body (DELETE): declarar
 * `application/json` con body vacío hace que Fastify intente parsear "" y
 * responda 400. Bug cazado en el fuego (Santi 2026-08-08). */
function cabecerasSinBody(acc: AccesoVault): Record<string, string> {
  return { Authorization: `Bearer ${acc.token}` };
}

/** `GET /v1/quien-soy` — como quién autentica este token (diagnóstico, sin
 * valores ni hashes). null si el vault no expone el endpoint o el token no
 * autentica; el llamador degrada el mensaje, nunca la operación. */
export async function quienSoy(acc: AccesoVault): Promise<{ nombre: string; tipo: string } | null> {
  try {
    const r = await f(acc)(`${acc.url}/v1/quien-soy`, { method: "GET", headers: cabecerasSinBody(acc) });
    if (!r.ok) return null;
    const j = (await r.json()) as { nombre?: string; tipo?: string };
    return typeof j.nombre === "string" && typeof j.tipo === "string" ? { nombre: j.nombre, tipo: j.tipo } : null;
  } catch {
    return null;
  }
}

/** Un 403 a ciegas no se puede operar (post-mortem iam-mishi 2026-08-09): el
 * error dice COMO QUIÉN autenticó este runner, para ver al instante si el grant
 * cayó en otra identidad homónima/por-nodo. */
async function contextoDeIdentidad(acc: AccesoVault, status: number): Promise<string> {
  if (status !== 403) return "";
  const yo = await quienSoy(acc);
  return yo
    ? ` (autenticado como '${yo.nombre}' tipo ${yo.tipo} — el grant existe para OTRA identidad; re-corre \`mke app init\` para regrantear a toda la familia de deploy)`
    : "";
}

/** `GET /v1/secretos/:ns` — SOLO metadata (nombres). Lanza con contexto, sin valores. */
export async function listarNombres(acc: AccesoVault, ns: string): Promise<string[]> {
  const r = await f(acc)(`${acc.url}/v1/secretos/${encodeURIComponent(ns)}`, {
    method: "GET",
    headers: cabeceras(acc),
  });
  if (!r.ok) throw new Error(`vault listar ${ns}: HTTP ${r.status}${await contextoDeIdentidad(acc, r.status)}`);
  const j = (await r.json()) as { secretos?: { nombre: string }[] };
  return (j.secretos ?? []).map((s) => s.nombre);
}

/** `GET /v1/secreto/:ns/:nombre` — devuelve el VALOR. Quien lo reciba no lo imprime. */
export async function leerValor(acc: AccesoVault, ns: string, nombre: string): Promise<string> {
  const r = await f(acc)(`${acc.url}/v1/secreto/${encodeURIComponent(ns)}/${encodeURIComponent(nombre)}`, {
    method: "GET",
    headers: cabeceras(acc),
  });
  if (!r.ok) throw new Error(`vault leer ${ns}/${nombre}: HTTP ${r.status}${await contextoDeIdentidad(acc, r.status)}`);
  const j = (await r.json()) as { valor?: string };
  if (typeof j.valor !== "string") throw new Error(`vault leer ${ns}/${nombre}: respuesta sin valor`);
  return j.valor;
}

/** `PUT /v1/secreto/:ns/:nombre` — crea o ROTA (versión nueva, nunca pisa la historia). */
export async function escribirValor(
  acc: AccesoVault,
  ns: string,
  nombre: string,
  valor: string,
  descripcion?: string,
): Promise<{ version: number; rotado: boolean }> {
  const r = await f(acc)(`${acc.url}/v1/secreto/${encodeURIComponent(ns)}/${encodeURIComponent(nombre)}`, {
    method: "PUT",
    headers: cabeceras(acc),
    body: JSON.stringify(descripcion ? { valor, descripcion } : { valor }),
  });
  if (!r.ok) throw new Error(`vault escribir ${ns}/${nombre}: HTTP ${r.status}`);
  return (await r.json()) as { version: number; rotado: boolean };
}

/**
 * Borra un secreto del vault (DELETE /v1/secreto). Idempotente para el llamador:
 * devuelve `borrado` (true si existía, false si ya no estaba); solo lanza ante
 * un error REAL del vault (permiso, red). Lo usa `mke app borrar` para no dejar
 * secretos huérfanos de una app muerta.
 */
export async function borrarValor(
  acc: AccesoVault,
  ns: string,
  nombre: string,
): Promise<{ borrado: boolean }> {
  const r = await f(acc)(`${acc.url}/v1/secreto/${encodeURIComponent(ns)}/${encodeURIComponent(nombre)}`, {
    method: "DELETE",
    headers: cabecerasSinBody(acc),
  });
  if (r.status === 204) return { borrado: true };
  if (r.status === 404) return { borrado: false };
  throw new Error(`vault borrar ${ns}/${nombre}: HTTP ${r.status}`);
}

/** Nombre del secreto de BD en el vault: `<app>/DATABASE_URL__<env>`. */
export function nombreDatabaseUrl(env: string): string {
  const sufijo = sufijoEnv(env);
  if (!sufijo) throw new Error(`el entorno ${env} no vive en el vault (solo stage|prod)`);
  return `DATABASE_URL__${sufijo}`;
}

// ─────────────────────────── lado k8s (impuro) ──────────────────────────────

/** Claves (no valores) del Secret k8s `<app>-secrets`. null = el Secret no existe. */
export async function clavesEnCluster(app: string, env: string): Promise<string[] | null> {
  const spec = envOrThrow(env);
  const r = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "get", "secret", `${app}-secrets`,
    // go-template, NO jsonpath: el jsonpath de kubectl no sabe iterar un MAPA
    // con su clave (`{range $k, $v := .data}` → "unrecognized character ','").
    // Solo salen los NOMBRES de las claves; los valores nunca se piden.
    "-o", 'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}',
  ]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((k) => k.trim()).filter(Boolean).sort();
}

/**
 * PATCH merge de las claves dadas al Secret `<app>-secrets` (lo crea vacío si no
 * existe). El archivo de patch se escribe en tmp con los valores en base64 — es
 * el mismo camino que ya usa `aplicarSecretK8s`; nunca va a stdout.
 */
export async function mergearSecretK8s(
  app: string,
  env: string,
  valores: Record<string, string>,
): Promise<void> {
  const spec = envOrThrow(env);
  const nombre = `${app}-secrets`;
  if (Object.keys(valores).length === 0) return;

  const existe = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace, "get", "secret", nombre,
  ]);
  if (existe.code !== 0) {
    const crear = await run("kubectl", [
      "--context", spec.context, "-n", spec.namespace,
      "create", "secret", "generic", nombre,
    ]);
    if (crear.code !== 0) throw new Error(`crear Secret ${nombre} falló: ${crear.stderr || crear.stdout}`);
  }

  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(valores)) data[k] = Buffer.from(v).toString("base64");
  // nombre único por proceso: /tmp es compartido y un nombre fijo colisiona
  // entre usuarios (el runner mke-ci no puede pisar el archivo 0600 de santi)
  const archivo = join(tmpdir(), `mke-vault-${app}-${env}-${process.pid}.json`);
  writeFileSync(archivo, JSON.stringify({ data }), { mode: 0o600 });
  const patch = await run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "patch", "secret", nombre, "--type", "merge", "--patch-file", archivo,
  ]);
  rmSync(archivo, { force: true });
  if (patch.code !== 0) throw new Error(`patch del Secret ${nombre} falló: ${patch.stderr || patch.stdout}`);
}
