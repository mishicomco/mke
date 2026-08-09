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
//   - el token vive en `vault-mishi get git-mishi-api-token` y NUNCA se imprime.
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
  /** sha completo del commit del run (`commit_sha` en Forgejo). */
  sha: string;
  evento: string;
  creado: string;
  titulo: string;
}

/** estados terminales de Forgejo que valen como veredicto del run. */
const TERMINALES = ["success", "failure", "cancelled", "skipped", "error"];

async function token(): Promise<string> {
  const t = await secretGet(FORGE.apiTokenSecret);
  if (!t) {
    throw new Error(`no pude leer el token del forge (vault-mishi get ${FORGE.apiTokenSecret})`);
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
      sha: String(x.commit_sha ?? x.head_sha ?? ""),
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

// ── mke ci wait ──────────────────────────────────────────────────────────────
// Cicatriz que lo motiva (2026-08-09): "el último run" NO es "mi run". Justo
// después de un push el run nuevo aún no está registrado, y un loop sobre
// `mke ci runs <app> 1` lee el SUCCESS del run ANTERIOR y reporta verde un
// deploy que sigue corriendo (pasó ≥2 veces: links y dropshipping). Además un
// push a main y un tag v* del mismo sha crean runs casi simultáneos, y un
// runner reiniciado deja el run en vuelo ZOMBIE (log cortado sin "Job failed").
// Por eso este verbo sigue EL run del ref pedido, tolera la ventana en que aún
// no existe, y detecta el zombie por el heartbeat (`updated_at`) de su task.

export type VeredictoWait = "success" | "fallo" | "timeout" | "no-aparecio" | "killed";

/** exit codes del veredicto — para que un script nunca tenga que adivinar. */
export const EXIT_WAIT: Record<VeredictoWait, number> = {
  success: 0,
  fallo: 1, // failure | error | cancelled | skipped ([skip ci] silencia también el run del tag)
  timeout: 2,
  "no-aparecio": 3,
  killed: 4,
};

/** true si el ref pinta a sha (hex ≥7) y no a nombre de rama/tag. */
export function esSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref) && !/^v\d/.test(ref);
}

/**
 * Elige EL run que corresponde al ref pedido — NUNCA "el último". PURA.
 *   - ref sha (hex ≥7): matchea `commit_sha` por prefijo.
 *   - ref tag/rama: matchea `prettyref` EXACTO (Forgejo manda el tag pelado,
 *     ej "v0.1.2"); si además viene `sha`, lo exige (desambigua ramas tipo
 *     `main`, donde runs viejos comparten prettyref).
 *   - `minId` filtra runs pre-existentes (un dispatch/push nuevo siempre crea
 *     un id global MAYOR que los que ya estaban).
 * Devuelve el matching más nuevo (id global más alto), o null.
 */
export function elegirRun(runs: RunCi[], ref: string, opts: { sha?: string; minId?: number } = {}): RunCi | null {
  const candidatos = runs.filter((r) => {
    if (opts.minId !== undefined && r.id <= opts.minId) return false;
    if (r.evento === "delete") return false; // el on:delete de previews comparte prettyref
    const porRef = esSha(ref) ? r.sha.toLowerCase().startsWith(ref.toLowerCase()) : r.rama === ref;
    if (!porRef) return false;
    if (opts.sha && !r.sha.toLowerCase().startsWith(opts.sha.toLowerCase())) return false;
    return true;
  });
  if (!candidatos.length) return null;
  return candidatos.reduce((a, b) => (b.id > a.id ? b : a));
}

/** true si el estado/conclusión del run ya es terminal. */
export function runTerminal(r: RunCi): boolean {
  return TERMINALES.includes(r.estado.toLowerCase()) || r.conclusion !== "";
}

export interface WaitOpciones {
  /** sha esperado (desambigua refs de rama tipo `main`). */
  sha?: string;
  /** solo considerar runs con id global MAYOR (capturalo ANTES de disparar). */
  minId?: number;
  /** timeout total en segundos (default 1200 — chrome-mishi buildea lento). */
  timeoutSeg?: number;
  /** ventana para que el run APAREZCA en la API (default 120). */
  aparecerSeg?: number;
  /** segundos sin heartbeat de la task para declararlo killed (default 300). */
  estancadoSeg?: number;
  /** intervalo de poll (default 5). */
  intervaloSeg?: number;
}

const dormir = (seg: number) => new Promise((r) => setTimeout(r, seg * 1000));

/** heartbeat (`updated_at`) de la task del run, vía /actions/tasks. */
async function heartbeatTask(app: string, indice: number): Promise<Date | null> {
  const r = await apiGet(`/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/tasks?limit=40`);
  if (r.status !== 200) return null;
  try {
    const body = JSON.parse(r.body) as { workflow_runs?: { url?: string; updated_at?: string }[] };
    const task = (body.workflow_runs ?? []).find((t) => String(t.url ?? "").endsWith(`/actions/runs/${indice}`));
    return task?.updated_at ? new Date(task.updated_at) : null;
  } catch {
    return null;
  }
}

/**
 * Espera a que EL run del ref pedido llegue a estado terminal y devuelve un
 * veredicto inequívoco (exit code en EXIT_WAIT). Tolera la ventana donde el
 * run AÚN NO EXISTE (no la confunde con "terminó"); detecta el run zombie de
 * un runner reiniciado (heartbeat estancado → `killed`).
 */
export async function ciWait(app: string, ref: string, opts: WaitOpciones = {}): Promise<VeredictoWait> {
  const timeoutSeg = opts.timeoutSeg ?? 1200;
  const aparecerSeg = opts.aparecerSeg ?? 120;
  const estancadoSeg = opts.estancadoSeg ?? 300;
  const intervaloSeg = opts.intervaloSeg ?? 5;
  const t0 = Date.now();
  const transcurrido = () => Math.round((Date.now() - t0) / 1000);

  if (!esSha(ref) && !/^v\d/.test(ref) && !opts.sha && opts.minId === undefined) {
    console.log(warn(`ref "${ref}" es una rama: sin --sha ni --min-id puedo agarrar un run VIEJO de la misma rama.`));
    console.log(dim(`  pasá --sha $(git rev-parse ${ref}) o capturá --min-id antes del push.`));
  }

  let runId: number | null = null; // una vez visto, se sigue ESE run (lock por id)
  let estadoPrevio = "";
  let ultimoAvance = Date.now();

  for (;;) {
    if (transcurrido() > timeoutSeg) {
      console.log(bad(`timeout (${timeoutSeg}s) esperando el run de ${ref} — sigue sin veredicto terminal`));
      return "timeout";
    }
    const r = await apiGet(`/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/runs?limit=40`);
    if (r.status !== 200) {
      console.log(warn(`forge GET runs → ${r.status}; reintento`));
      await dormir(intervaloSeg);
      continue;
    }
    const runs = parsearRuns(r.body);
    const run: RunCi | null = runId !== null
      ? (runs.find((x) => x.id === runId) ?? null)
      : elegirRun(runs, ref, { sha: opts.sha, minId: opts.minId });

    if (!run) {
      if (runId !== null) {
        // ya lo teníamos y desapareció de la lista: raro; seguir esperando.
        await dormir(intervaloSeg);
        continue;
      }
      if (transcurrido() > aparecerSeg) {
        console.log(bad(`el run de ${ref} NO apareció en ${aparecerSeg}s — ¿el push llegó al forge? ¿"[skip ci]" en el commit?`));
        return "no-aparecio";
      }
      console.log(dim(`  esperando que el run de ${ref} aparezca en el forge… (${transcurrido()}s)`));
      await dormir(intervaloSeg);
      continue;
    }

    if (runId === null) {
      runId = run.id;
      console.log(info(`run #${run.indice} (id ${run.id}) — ${ref} @ ${run.sha.slice(0, 8)}`));
    }

    if (runTerminal(run)) {
      const v = (run.conclusion || run.estado).toLowerCase();
      if (v === "success") {
        console.log(ok(`run #${run.indice} de ${ref} → success (${transcurrido()}s)`));
        return "success";
      }
      if (v === "skipped") {
        console.log(bad(`run #${run.indice} de ${ref} → SKIPPED — ojo: "[skip ci]" en el commit tageado silencia también el run del tag`));
      } else {
        console.log(bad(`run #${run.indice} de ${ref} → ${v}  (logs: mke ci logs ${app} ${run.id})`));
      }
      return "fallo";
    }

    if (run.estado !== estadoPrevio) {
      estadoPrevio = run.estado;
      ultimoAvance = Date.now();
      console.log(dim(`  run #${run.indice}: ${run.estado} (${transcurrido()}s)`));
    }

    // zombie: runner reiniciado a mitad → el run queda "running" con la task
    // sin heartbeat y el log cortado SIN "Job failed".
    if (run.estado.toLowerCase() === "running") {
      const hb = await heartbeatTask(app, run.indice);
      if (hb) ultimoAvance = Math.max(ultimoAvance, hb.getTime());
      const estancado = Math.round((Date.now() - ultimoAvance) / 1000);
      if (estancado > estancadoSeg) {
        console.log(bad(`run #${run.indice} de ${ref} lleva ${estancado}s sin heartbeat — runner muerto/reiniciado (run KILLED, el log queda cortado sin "Job failed")`));
        return "killed";
      }
    }

    await dormir(intervaloSeg);
  }
}

/** id global más alto visible HOY — capturalo ANTES de push/dispatch para usar como --min-id. */
export async function ultimoRunId(app: string): Promise<number> {
  const r = await apiGet(`/repos/${FORGE.org}/${encodeURIComponent(app)}/actions/runs?limit=1`);
  if (r.status !== 200) return 0;
  return parsearRuns(r.body)[0]?.id ?? 0;
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
export async function ciDeploy(app: string, env: string, refPedido?: string, opts: { sinEsperar?: boolean; timeoutSeg?: number } = {}): Promise<void> {
  const validado = validarDispatch(env, refPedido);
  if ("error" in validado) {
    console.log(bad(validado.error));
    process.exitCode = 1;
    return;
  }
  const ref = validado.ref;
  // id más alto ANTES del dispatch: el run nuevo tendrá id mayor (así el wait
  // jamás agarra un run viejo del mismo ref — el falso positivo que motivó todo).
  const minId = opts.sinEsperar ? 0 : await ultimoRunId(app);
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
    if (opts.sinEsperar) {
      console.log(dim(`  seguí el run con: mke ci wait ${app} --ref ${ref}`));
      return;
    }
    // el dispatch encadena el wait: sin veredicto terminal OK, esto NO es verde.
    const veredicto = await ciWait(app, ref, { minId, timeoutSeg: opts.timeoutSeg });
    process.exitCode = EXIT_WAIT[veredicto];
    return;
  }
  console.log(bad(`dispatch → ${res.status}: ${(await res.text()).slice(0, 300)}`));
  process.exitCode = 1;
}
