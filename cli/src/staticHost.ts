// Host del front en el ingress de static-mishi — el ÚNICO eslabón manual del
// nacimiento de apps (nadie agregaba el host de la app nueva: 404 hasta que
// alguien editaba static-mishi a mano). `mke app init` corre este paso SIEMPRE
// para AMBOS entornos (stage y prod): el host del ingress no depende de en qué
// env se provisionó la BD hoy — es barato dejarlo listo de una.
//
// Edita el YAML a mano (no un parser YAML genérico) porque el archivo real es
// chico y de forma UNIFORME: toda regla es el mismo bloque
// `- host: <h> -> / -> static-mishi:80` — incluidas las apps CON backend (bank,
// omni, travelhabit): su `/api` lo agrega el ingress PROPIO del backend, nunca
// éste (visto en el comentario del archivo real). Insertar = clonar el bloque.
// No se reordena ni se toca ninguna otra línea/comentario existente.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { appsRoot } from "./mkeConfig.js";
import { ok, bad, info, warn, dim } from "./sh.js";

const execFileAsync = promisify(execFile);

export const STATIC_MISHI_REPO = "static-mishi";

function ingressPath(env: "stage" | "prod"): string {
  return join(appsRoot(), STATIC_MISHI_REPO, "k8s", "overlays", env, "ingress.yaml");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** true si el host ya tiene una regla `- host: <h>` en el ingress (idempotencia). */
export function hostExistsInIngress(yamlText: string, host: string): boolean {
  const re = new RegExp(`^\\s*-\\s*host:\\s*${escapeRegex(host)}\\s*$`, "m");
  return re.test(yamlText);
}

/**
 * Agrega un bloque de regla para `host`, clonando la forma de las reglas
 * existentes (mismo indentado que el archivo real). No-op si el host ya
 * existe. Revienta si el yaml no tiene una clave `rules:` de nivel esperado —
 * mejor fallar ruidoso que editar a ciegas un archivo con forma inesperada.
 */
export function addHostToIngress(yamlText: string, host: string): string {
  if (hostExistsInIngress(yamlText, host)) return yamlText;
  if (!/^\s*rules:\s*$/m.test(yamlText)) {
    throw new Error("el ingress no tiene una clave `rules:` de nivel esperado — no edito a ciegas");
  }
  const bloque = [
    `    - host: ${host}`,
    `      http:`,
    `        paths:`,
    `          - path: /`,
    `            pathType: Prefix`,
    `            backend:`,
    `              service:`,
    `                name: static-mishi`,
    `                port:`,
    `                  number: 80`,
  ].join("\n");
  const sinFinal = yamlText.replace(/\s+$/, "");
  return `${sinFinal}\n${bloque}\n`;
}

/** host stage/prod que le corresponden a un subdominio, por convención de plataforma. */
export function planStaticHosts(subdominio: string): { stageHost: string; prodHost: string } {
  return {
    stageHost: `${subdominio}-stage.mishi.com.co`,
    prodHost: `${subdominio}.mishi.com.co`,
  };
}

export interface StaticHostResult {
  stageHost: string;
  prodHost: string;
  stageAlready: boolean;
  prodAlready: boolean;
  /** true si se escribió algún archivo (hace falta commit+push). */
  changed: boolean;
}

/**
 * Aplica el host de `subdominio` a AMBOS overlays (stage y prod) del ingress
 * de static-mishi, en el checkout local del repo (appsRoot()/static-mishi).
 * Idempotente: si ambos ya existían no toca disco. Solo I/O de archivo — NO
 * hace commit/push (ver `commitAndPushStaticHosts`).
 */
export function applyStaticHosts(subdominio: string): StaticHostResult {
  const { stageHost, prodHost } = planStaticHosts(subdominio);
  const stagePath = ingressPath("stage");
  const prodPath = ingressPath("prod");
  if (!existsSync(stagePath) || !existsSync(prodPath)) {
    throw new Error(`no encuentro el ingress de static-mishi (${stagePath} / ${prodPath})`);
  }
  const stageText = readFileSync(stagePath, "utf8");
  const prodText = readFileSync(prodPath, "utf8");
  const stageAlready = hostExistsInIngress(stageText, stageHost);
  const prodAlready = hostExistsInIngress(prodText, prodHost);

  let changed = false;
  if (!stageAlready) {
    writeFileSync(stagePath, addHostToIngress(stageText, stageHost));
    changed = true;
  }
  if (!prodAlready) {
    writeFileSync(prodPath, addHostToIngress(prodText, prodHost));
    changed = true;
  }
  return { stageHost, prodHost, stageAlready, prodAlready, changed };
}

/**
 * Push sin que un GITHUB_TOKEN inválido en el entorno pise las credenciales
 * de `gh` (gotcha documentado en CLAUDE.md). No se implementa como `sh -c`
 * para no depender de escapado de shell — env override directo.
 */
async function gitPush(repo: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", repo, "-c", "credential.helper=!gh auth git-credential", "push"],
      { env },
    );
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

/**
 * commit + push del repo static-mishi (solo si `result.changed`; no-op si no
 * hubo cambios en disco). static-mishi SÍ recibe commits directos a main para
 * este paso: es config de plataforma, cerrar este hueco lo aprobó Santi.
 */
export async function commitAndPushStaticHosts(app: string, result: StaticHostResult): Promise<void> {
  if (!result.changed) return;
  const repo = join(appsRoot(), STATIC_MISHI_REPO);
  try {
    await execFileAsync("git", [
      "-C", repo, "add",
      "k8s/overlays/stage/ingress.yaml",
      "k8s/overlays/prod/ingress.yaml",
    ]);
  } catch (err) {
    throw new Error(`git add falló en static-mishi: ${err instanceof Error ? err.message : String(err)}`);
  }
  const msg = `feat(ingress): host de ${app} (stage+prod) — nacimiento automático (mke app init)`;
  try {
    await execFileAsync("git", ["-C", repo, "commit", "-m", msg]);
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    throw new Error(`git commit falló en static-mishi: ${e.stdout ?? e.message}`);
  }
  const push = await gitPush(repo);
  if (push.code !== 0) throw new Error(`git push falló en static-mishi: ${push.stderr || push.stdout}`);
}

/**
 * Paso completo (I/O + commit + push) con logging ok/warn — lo reusan tanto
 * `mke app init` como el verbo suelto `mke static agregar`.
 */
export async function ensureStaticHostPaso(
  app: string,
  subdominio: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ already: boolean } | null> {
  const plan = planStaticHosts(subdominio);
  if (opts.dryRun) {
    console.log(`  host del front en static-mishi (ingress stage+prod): ${dim(plan.stageHost)} + ${dim(plan.prodHost)}`);
    return null;
  }
  console.log(info(`host del front en static-mishi (stage+prod) para \`${subdominio}\``));
  try {
    const result = applyStaticHosts(subdominio);
    await commitAndPushStaticHosts(app, result);
    const already = result.stageAlready && result.prodAlready;
    console.log(ok(already
      ? `host static-mishi ya existía en ambos overlays (${result.stageHost} + ${result.prodHost})`
      : `host static-mishi agregado (stage: ${result.stageAlready ? "ya existía" : "nuevo"}, prod: ${result.prodAlready ? "ya existía" : "nuevo"})`));
    if (!already) {
      console.log(dim("  el CI de static-mishi despliega el overlay al hacer push a main — no se aplica a mano acá."));
    }
    return { already };
  } catch (err) {
    console.log(bad(`host static-mishi falló: ${err instanceof Error ? err.message : String(err)}`));
    console.log(warn("los demás pasos sí se completaron — agregá el host a mano en static-mishi/k8s/overlays/{stage,prod}/ingress.yaml"));
    return null;
  }
}
