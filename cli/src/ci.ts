// `mke ci` — el CI del forge (git-mishi / Forgejo) desde el CLI.
//
// Cicatriz que lo motiva (2026-07-27): sacar los logs de un run fallido fue una
// odisea. Lo aprendido, HORNEADO acá para no volver a descubrirlo:
//   - los ids que devuelve `/actions/tasks` NO sirven para pedir logs;
//   - el endpoint bueno es `GET /repos/{owner}/{repo}/actions/runs/{id}/logs`
//     y devuelve un ZIP (no texto);
//   - ese `{id}` es el `id` GLOBAL del run, NO el `index_in_repo` que muestra la
//     web (verificado 2026-07-27: id 118 → 200 application/zip; índice 11 → 404);
//   - Forgejo no manda `conclusion`/`head_branch` (eso es GitHub): el veredicto
//     va en `status` y la rama en `prettyref`;
//   - el forge se alcanza por LAN desde el pc gamer (http://git.mishi.com.co —
//     /etc/hosts lo manda a 127.0.0.1, solo :80). `forgeBaseLocal()` ya lo resuelve.
//   - el token vive en `mishi-secret get git-mishi-api-token` y NUNCA se imprime.
//
// Y el otro incidente: un `workflow_dispatch` con un input desconocido cayó en
// silencio a stage y el run salió VERDE. Por eso `mke ci deploy` VALIDA el
// `environment` contra stage|prod ANTES de disparar nada.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FORGE, forgeBaseLocal, secretGet } from "./forgeRepo.js";
import { leerZip } from "./zipLeer.js";
import { ok, bad, warn, info, dim } from "./sh.js";

/** workflow estándar del ecosistema (el que trae el template create-mishi-app). */
export const WORKFLOW = "ci-cd.yml";
/** entornos válidos para el input `environment` del dispatch. */
export const ENVS_CI = ["stage", "prod"] as const;

export interface RunCi {
  /** id GLOBAL del run — es el que acepta `/actions/runs/{id}/logs`. */
  id: number;
  /** `index_in_repo` (el número que muestra la web). NO sirve para pedir logs. */
  indice: number;
  estado: string;
  /** veredicto terminal (Forgejo lo mete en `status`; GitHub en `conclusion`). */
  conclusion: string;
  rama: string;
  evento: string;
  creado: string;
  titulo: string;
}

/** estados terminales de Forgejo que valen como veredicto del run. */
const TERMINALES = ["success", "failure", "cancelled", "skipped", "error"];

async function token(): Promise<string> {
  const t = await secretGet(FORGE.apiTokenSecret);
  if (!t) {
    throw new Error(`no pude leer el token del forge (mishi-secret get ${FORGE.apiTokenSecret})`);
  }
  return t;
}

/** Normaliza la respuesta del forge a la forma que muestra el CLI. */
export function parsearRuns(json: string): RunCi[] {
  let bruto: unknown[] = [];
  try {
    const body = JSON.parse(json) as { workflow_runs?: unknown[] } | unknown[];
    bruto = Array.isArray(body) ? body : (body.workflow_runs ?? []);
  } catch {
    return [];
  }
  // Forgejo NO devuelve `conclusion` ni `head_branch` (eso es GitHub): el
  // veredicto viene en `status` y la rama/tag en `prettyref`. Se aceptan ambas
  // formas para no atarse a una versión del forge.
  return bruto.map((r) => {
    const x = r as Record<string, unknown>;
    const estado = String(x.status ?? "?");
    const conclusion = x.conclusion !== undefined && x.conclusion !== null
      ? String(x.conclusion)
      : TERMINALES.includes(estado.toLowerCase())
        ? estado
        : "";
    return {
      id: Number(x.id ?? 0),
      indice: Number(x.index_in_repo ?? 0),
      estado,
      conclusion,
      rama: String(x.head_branch ?? x.prettyref ?? ""),
      evento: String(x.event ?? x.trigger_event ?? ""),
      creado: String(x.created_at ?? x.created ?? x.started ?? ""),
      titulo: String(x.title ?? ""),
    };
  });
}

/** true si el run terminó mal (o fue cancelado). */
export function runFallido(r: RunCi): boolean {
  return ["failure", "cancelled", "error", "failed"].includes(r.conclusion.toLowerCase());
}

async function apiGet(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${await forgeBaseLocal()}/api/v1${path}`, {
    headers: { Authorization: `token ${await token()}`, Accept: "application/json" },
  });
  return { status: res.status, body: await res.text() };
}

/** Últimos runs del repo del app en el forge. */
export async function ciRuns(app: string, n = 10): Promise<void> {
  const r = await apiGet(`/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/runs?limit=${n}`);
  if (r.status !== 200) {
    console.log(bad(`forge GET runs → ${r.status}: ${r.body.slice(0, 200)}`));
    return;
  }
  const runs = parsearRuns(r.body).slice(0, n);
  if (!runs.length) {
    console.log(warn(`sin runs para ${FORGE.org}/${app}`));
    return;
  }
  console.log(`\n  runs de ${dim(`${FORGE.org}/${app}`)}\n`);
  for (const x of runs) {
    const etiqueta = `#${x.indice || x.id}  ${x.estado}  ${x.rama || "?"}  ${dim(`${x.evento} ${x.creado} · ${x.titulo}`)}`;
    console.log(`  ${runFallido(x) ? bad(etiqueta) : ok(etiqueta)}  ${dim(`(id ${x.id})`)}`);
  }
  console.log(dim("  el id de logs es el `id` global, NO el número del run que muestra la web."));
  console.log("");
}

/** id del último run fallido (o del último run si ninguno falló). */
async function ultimoRunInteresante(app: string): Promise<number | null> {
  const r = await apiGet(`/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/runs?limit=20`);
  if (r.status !== 200) {
    console.log(bad(`forge GET runs → ${r.status}: ${r.body.slice(0, 200)}`));
    return null;
  }
  const runs = parsearRuns(r.body);
  if (!runs.length) return null;
  return (runs.find(runFallido) ?? runs[0]).id;
}

/** Líneas que huelen a error, para no vomitar el log entero. */
export function lineasDeError(texto: string, cuantas = 40): string[] {
  const lineas = texto.split("\n").map((l) => l.replace(/\r/g, "").trimEnd()).filter(Boolean);
  const sospechosas = lineas.filter((l) =>
    /(^|\W)(error|fail(ed|ure)?|fatal|abort|❌|::error|exit code [1-9]|denied|not found)/i.test(l),
  );
  const elegidas = sospechosas.length ? sospechosas : lineas;
  return elegidas.slice(-cuantas);
}

/**
 * Baja el ZIP de logs de un run (endpoint `/actions/runs/{id}/logs`), lo extrae
 * a un tmp y muestra las últimas líneas que huelen a error. Sin `runId`, usa el
 * ÚLTIMO run fallido. El ZIP se descomprime en proceso (`zipLeer.ts`): el pc
 * gamer no tiene `unzip`.
 */
export async function ciLogs(app: string, runId?: number): Promise<void> {
  const id = runId ?? (await ultimoRunInteresante(app));
  if (id === null) {
    console.log(warn(`sin runs para ${FORGE.org}/${app}`));
    return;
  }
  console.log(info(`logs del run #${id} de ${dim(`${FORGE.org}/${app}`)}`));

  const res = await fetch(
    `${await forgeBaseLocal()}/api/v1/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/runs/${id}/logs`,
    { headers: { Authorization: `token ${await token()}` } },
  );
  if (!res.ok) {
    console.log(bad(`forge GET logs → ${res.status} (recordá: los ids de /actions/tasks NO sirven acá)`));
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), `mke-ci-logs-${id}-`));
  let entradas;
  try {
    entradas = leerZip(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.log(bad(`no pude leer el ZIP de logs: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  if (!entradas.length) {
    console.log(warn("el ZIP no traía archivos de log"));
    return;
  }

  try {
    for (const entrada of entradas) {
      // se deja el log completo en tmp por si hace falta mirarlo entero.
      const destino = join(dir, entrada.nombre.replace(/[/\\]/g, "_"));
      writeFileSync(destino, entrada.contenido);
      const lineas = lineasDeError(entrada.contenido.toString("utf8"));
      if (!lineas.length) continue;
      console.log(`\n  ${info(entrada.nombre)}`);
      for (const l of lineas) console.log(dim(`  │ ${l}`));
    }
    console.log(`\n  ${dim(`logs completos en ${dir}`)}\n`);
  } catch (e) {
    console.log(bad(`error leyendo los logs: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/**
 * Valida environment + ref ANTES de disparar nada. PURA (es lo que hay que
 * testear; el dispatch en sí es una llamada HTTP).
 *
 * Reglas (decisión de Santi 2026-07-27):
 *   - `environment` solo stage|prod. Un input desconocido caía en SILENCIO a
 *     stage y el run salía VERDE.
 *   - stage: `ref` default `main` (el contrato normal es push a main).
 *   - prod: `--ref` EXPLÍCITO y tiene que ser un tag `v*`. El contrato de prod
 *     es un tag versionado; deployar prod desde `main` a dedo es justo el
 *     accidente que este verbo no debe permitir.
 */
export function validarDispatch(env: string, ref?: string): { ref: string } | { error: string } {
  if (!(ENVS_CI as readonly string[]).includes(env)) {
    return { error: `environment inválido: "${env}" — usá ${ENVS_CI.join(" | ")} (un input desconocido cae en silencio a stage)` };
  }
  if (env !== "prod") return { ref: ref ?? "main" };

  if (!ref) {
    return {
      error:
        "prod exige --ref EXPLÍCITO con un tag de versión (ej: --ref v0.1.2). " +
        "El contrato de prod es un tag `v*`, no `main`.",
    };
  }
  if (!/^v\d/.test(ref)) {
    return { error: `--ref "${ref}" no es un tag de versión — prod solo se despliega desde un tag \`v*\` (ej: v0.1.2)` };
  }
  return { ref };
}

/**
 * Dispara el workflow estándar con el input `environment` (y el `ref` de prod)
 * VALIDADOS — ver `validarDispatch`.
 */
export async function ciDeploy(app: string, env: string, refPedido?: string): Promise<void> {
  const validado = validarDispatch(env, refPedido);
  if ("error" in validado) {
    console.log(bad(validado.error));
    process.exitCode = 1;
    return;
  }
  const ref = validado.ref;
  const res = await fetch(
    `${await forgeBaseLocal()}/api/v1/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${await token()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: { environment: env } }),
    },
  );
  if (res.ok || res.status === 204) {
    console.log(ok(`dispatch de ${WORKFLOW} para ${FORGE.org}/${app} → environment=${env} (ref ${ref})`));
    console.log(dim(`  seguí el run con: mke ci runs ${app}`));
    return;
  }
  console.log(bad(`dispatch → ${res.status}: ${(await res.text()).slice(0, 300)}`));
  process.exitCode = 1;
}
