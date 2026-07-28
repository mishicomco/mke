import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appsRoot, envOrThrow, hostFor } from "./mkeConfig.js";
import { run, ok, bad, info, dim } from "./sh.js";
import { doctor } from "./doctor.js";

export interface PublishOpts {
  /** directorio del repo del front (default: <appsRoot>/<front>) */
  dir?: string;
  /** tag mutable de la imagen de contenido (default: dev) */
  tag?: string;
  /** override del host público para el doctor final */
  host?: string;
}

/**
 * Publica un front ESTÁTICO al PVC compartido `static-www` de static-mishi.
 * El front no es un pod propio: un solo nginx sirve todos los fronts por
 * hostname. Se construye una imagen de "contenido" (su /dist) y un Job la
 * copia al PVC bajo subPath=<front>. Solo aplica a stage|prod.
 *
 * build local → `k3d image import` → Job (apply + wait) → doctor.
 */
export async function publish(front: string, env: string, opts: PublishOpts): Promise<void> {
  const spec = envOrThrow(env);

  if (env === "local") {
    console.log(bad("publish es solo para stage|prod — static-mishi no vive en local"));
    return;
  }

  const tag = opts.tag ?? "dev";
  const dir = opts.dir ?? join(appsRoot(), front);
  const image = `${front}-content:${tag}`;
  const ns = spec.namespace;

  if (!existsSync(dir)) {
    console.log(bad(`no existe el repo del front: ${dir} (pasá --dir o exportá MKE_APPS_ROOT)`));
    return;
  }

  // 1) build de la imagen de contenido
  console.log(info(`build ${dim(image)} desde ${dim(dir)}`));
  const build = await run("docker", ["build", "-t", image, dir]);
  if (build.code !== 0) {
    console.log(bad(`docker build falló: ${build.stderr || build.stdout}`));
    return;
  }
  console.log(ok("imagen construida"));

  // 2) import directo al cluster k3d (sin GHCR)
  console.log(info(`k3d image import ${dim(image)} → ${spec.cluster}`));
  const imp = await run("k3d", ["image", "import", image, "-c", spec.cluster]);
  if (imp.code !== 0) {
    console.log(bad(`k3d image import falló: ${imp.stderr || imp.stdout}`));
    return;
  }
  console.log(ok("imagen importada"));

  // 3) Job que copia /dist → PVC static-www (subPath=<front>)
  if (!(await publicarFrontAlPvc(front, env, image))) return;

  // 4) verificá la cadena pública
  await doctor(opts.host ?? hostFor(front, env));
}

/**
 * Job que copia el `/dist` de una imagen de contenido al PVC compartido
 * `static-www` bajo `subPath=<front>`. Extraído para que `mke deploy` publique
 * el frontend de una app con backend SIN duplicar el manifiesto (era el paso
 * "Publicar frontend al PVC" del ci-cd.yml de cada app).
 *
 * OJO (footgun de plataforma): `front` = el SUBDOMINIO público, no el id
 * interno del app — nginx deduce el root del host.
 */
export async function publicarFrontAlPvc(front: string, env: string, image: string): Promise<boolean> {
  const spec = envOrThrow(env);
  const ns = spec.namespace;
  const runId = Date.now().toString(36);
  const jobName = `publish-${front}-${runId}`;
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: ns,
      labels: { "app.kubernetes.io/part-of": "mke", "static-mishi/front": front },
    },
    spec: {
      ttlSecondsAfterFinished: 120,
      backoffLimit: 1,
      template: {
        metadata: { labels: { "static-mishi/front": front } },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "publish",
              image,
              imagePullPolicy: "IfNotPresent",
              volumeMounts: [{ name: "www", mountPath: "/out", subPath: front }],
            },
          ],
          volumes: [
            { name: "www", persistentVolumeClaim: { claimName: "static-www" } },
          ],
        },
      },
    },
  };

  // Jobs viejos del mismo front estorban el `wait` por label: se limpian antes.
  await run("kubectl", [
    "--context", spec.context, "-n", ns,
    "delete", "job", "-l", `static-mishi/front=${front}`, "--ignore-not-found",
  ]);

  const tmpFile = join(tmpdir(), `mke-publish-${jobName}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(job));

    console.log(info(`kubectl apply job/${jobName} (${spec.context}/${ns})`));
    const apply = await run("kubectl", ["--context", spec.context, "apply", "-f", tmpFile]);
    if (apply.code !== 0) {
      console.log(bad(`apply del Job falló: ${apply.stderr || apply.stdout}`));
      return false;
    }
    console.log(ok(apply.stdout.split("\n").join(" · ")));

    console.log(info(`esperando job/${jobName} (timeout 180s)`));
    const wait = await run("kubectl", [
      "--context", spec.context, "-n", ns,
      "wait", "--for=condition=complete", `job/${jobName}`, "--timeout=180s",
    ]);
    if (wait.code !== 0) {
      console.log(bad(`el Job no completó: ${wait.stderr || wait.stdout}`));
      return false;
    }
    console.log(ok(`front publicado al PVC static-www (subPath=${front})`));
    return true;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* tmp ya no existe */
    }
  }
}
