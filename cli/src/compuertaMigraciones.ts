// COMPUERTA de migraciones — fase (b) de `mke deploy`, mudada del ci-cd.yml.
//
// Orden inviolable, todo fail-fast (si un paso falla, NO hay rollout):
//   1. lint de migraciones (ley expand-contract) — `lintMigraciones.ts`
//   2. dump pre-migración                        — `dumpPreMigracion.ts`
//   3. Job k8s de migrar (imagen :sha, MIGRATE_ONLY=true)
//   4. drift-check (journal BD == migraciones del repo) — `driftDb.ts`
//
// El Job corre DENTRO del cluster con la MISMA imagen recién construida y
// reusa el env[] EXACTO del Deployment vigente (incluye secretKeyRef) para no
// derivar secretos a mano. OJO: copia SOLO `env[]`, NO `envFrom` — si tu
// Deployment monta un Secret entero por envFrom, tu envConfig debe eximir esas
// variables cuando MIGRATE_ONLY=true (migrar solo necesita DATABASE_URL;
// cicatriz: identity-mishi 2026-07-11).

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envOrThrow } from "./mkeConfig.js";
import type { AppSpec } from "./appSpec.js";
import { lintMigracionesRepo } from "./lintMigraciones.js";
import { dumpPreMigracion } from "./dumpPreMigracion.js";
import { verificarDrift } from "./driftDb.js";
import { run, ok, bad, info, dim } from "./sh.js";

/** Construye el manifiesto del Job de migrar a partir del env[] del Deployment. */
export function manifiestoJobMigrar(
  nombre: string,
  namespace: string,
  imagen: string,
  envDeployment: unknown[],
): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: nombre,
      namespace,
      labels: { "app.kubernetes.io/part-of": "mke", "mke/migracion": "true" },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 120,
      template: {
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "migrate",
              image: imagen,
              imagePullPolicy: "IfNotPresent",
              env: [...envDeployment, { name: "MIGRATE_ONLY", value: "true" }],
            },
          ],
        },
      },
    },
  };
}

/** Corre el Job de migrar y espera. true si migró bien. */
async function migrarConJob(spec: AppSpec, imagen: string, sha: string): Promise<boolean> {
  const env = envOrThrow(spec.env);
  const nombre = `${spec.app}-migrate-${sha}`;

  const envJson = await run("kubectl", [
    "--context", env.context, "-n", env.namespace,
    "get", `deploy/${spec.deployName}`,
    "-o", "jsonpath={.spec.template.spec.containers[0].env}",
  ]);
  if (envJson.code !== 0) {
    console.log(bad(`no pude leer el env del Deployment ${spec.deployName}: ${(envJson.stderr || envJson.stdout).split("\n")[0]}`));
    return false;
  }
  let envDeployment: unknown[] = [];
  try {
    envDeployment = envJson.stdout.trim() ? (JSON.parse(envJson.stdout) as unknown[]) : [];
  } catch {
    console.log(bad("el env[] del Deployment no es JSON válido — abortando antes de migrar"));
    return false;
  }

  const archivo = join(tmpdir(), `mke-migrate-${nombre}.json`);
  writeFileSync(archivo, JSON.stringify(manifiestoJobMigrar(nombre, env.namespace, imagen, envDeployment)));
  try {
    await run("kubectl", ["--context", env.context, "-n", env.namespace, "delete", "job", nombre, "--ignore-not-found"]);
    const apply = await run("kubectl", ["--context", env.context, "apply", "-f", archivo]);
    if (apply.code !== 0) {
      console.log(bad(`apply del Job de migrar falló: ${apply.stderr || apply.stdout}`));
      return false;
    }
    const espera = await run("kubectl", [
      "--context", env.context, "-n", env.namespace,
      "wait", "--for=condition=complete", `job/${nombre}`, "--timeout=120s",
    ]);
    const logs = await run("kubectl", ["--context", env.context, "-n", env.namespace, "logs", `job/${nombre}`, "--tail=200"]);
    if (logs.stdout.trim()) {
      for (const l of logs.stdout.split("\n").slice(-30)) console.log(dim(`  │ ${l}`));
    }
    if (espera.code !== 0) {
      console.log(bad(`migración de la BD FALLÓ en ${env.namespace} — abortando ANTES del rollout`));
      return false;
    }
    console.log(ok(`BD migrada ${dim(`(job/${nombre})`)}`));
    return true;
  } finally {
    try {
      unlinkSync(archivo);
    } catch {
      /* tmp ya no está */
    }
  }
}

/**
 * Parte 1 de la compuerta: el LINT. Va PRIMERO de todo (antes de gastar un
 * build) — el post-mortem #2 fue justamente que el lint solo corría en el job
 * `quality` de los PRs, y como el ecosistema no usa PRs, corría por primera vez
 * DENTRO del deploy a prod. Acá es lo primero que se evalúa.
 */
export function compuertaLint(spec: AppSpec): boolean {
  console.log(`\n  ${info(`compuerta de migraciones (lint) — ${spec.app} (${spec.env})`)}`);
  return lintMigracionesRepo(spec.dir, {
    drizzleDir: spec.drizzleDir,
    tablasSensiblesPath: spec.tablasSensiblesPath,
  });
}

/**
 * Parte 2 de la compuerta, DESPUÉS del build (el Job migra con la imagen :sha
 * recién importada) y ANTES del rollout: dump → Job de migrar → drift-check.
 * Devuelve true si es seguro seguir al rollout.
 */
export async function compuertaMigracionesPostBuild(spec: AppSpec, imagen: string, sha: string): Promise<boolean> {
  if (!spec.tieneDrizzle) {
    console.log(dim("  sin migraciones drizzle — no hay dump/Job/drift que correr."));
    return true;
  }
  console.log(`\n  ${info(`compuerta de migraciones (BD) — ${spec.db} @ ${spec.env}`)}`);

  // 1) respaldo antes de tocar la BD.
  if (!(await dumpPreMigracion(spec.app, spec.db, spec.env, sha))) return false;

  // 2) migrar como Job, ANTES de que el código nuevo sirva.
  if (!(await migrarConJob(spec, imagen, sha))) return false;

  // 3) drift-check: la BD quedó exactamente donde dicen las migraciones del repo.
  return verificarDrift(spec.db, spec.env, spec.drizzleDir);
}

/** Compuerta completa (lint + BD), para quien no necesita partirla en dos. */
export async function compuertaMigraciones(spec: AppSpec, imagen: string, sha: string): Promise<boolean> {
  if (!compuertaLint(spec)) return false;
  return compuertaMigracionesPostBuild(spec, imagen, sha);
}
