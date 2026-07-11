import { existsSync } from "node:fs";
import { join } from "node:path";
import { appsRoot, envOrThrow, hostFor } from "./mkeConfig.js";
import { run, ok, bad, dim } from "./sh.js";
import { paso, pasoStreamCmd } from "./progresoVivo.js";
import { doctor } from "./doctor.js";

export interface DeployOpts {
  /** directorio del repo del app (default: <appsRoot>/<app>) */
  dir?: string;
  /** tag mutable de la imagen (default: dev — lo referencia el overlay) */
  tag?: string;
  /** nombre del Deployment si difiere del id del app (ej. travelhabitco→travelhabit-backend) */
  deploy?: string;
  /** override del host público para el doctor final */
  host?: string;
}

/**
 * build local → `k3d image import` (sin GHCR) → `kubectl apply -k overlays/<env>`
 * → `rollout status` → doctor. Mismo loop cerrado que corre el runner self-hosted.
 */
export async function deploy(app: string, env: string, opts: DeployOpts): Promise<void> {
  const spec = envOrThrow(env);
  const tag = opts.tag ?? "dev";
  const appDir = opts.dir ?? join(appsRoot(), app);
  const overlay = join(appDir, "k8s", "overlays", env);
  const image = `${app}:${tag}`;
  const deployName = opts.deploy ?? app;

  if (!existsSync(appDir)) throw new Error(`no existe el repo del app: ${appDir} (pasá --dir o exportá MKE_APPS_ROOT)`);
  if (!existsSync(overlay)) throw new Error(`no existe el overlay: ${overlay}`);

  // 1) build (docker en WSL puede pedir sudo; probamos directo, sin sudo) — el
  //    output del build en vivo (dimmed) es la narración: hueco mudo grande.
  const buildCode = await pasoStreamCmd(`build ${dim(image)} desde ${dim(appDir)}`, "docker", ["build", "-t", image, appDir]);
  if (buildCode !== 0) {
    console.log(bad("docker build falló"));
    return;
  }

  // 2) import directo al cluster k3d (sin pasar por GHCR)
  const imp = await paso(`k3d image import ${dim(image)} → ${spec.cluster}`, () => run("k3d", ["image", "import", image, "-c", spec.cluster]));
  if (imp.code !== 0) {
    console.log(bad(`k3d image import falló: ${imp.stderr || imp.stdout}`));
    return;
  }

  // 3) apply del overlay
  const apply = await paso(`kubectl apply -k ${dim(overlay)} (${spec.context}/${spec.namespace})`, () => run("kubectl", ["--context", spec.context, "apply", "-k", overlay]));
  if (apply.code !== 0) {
    console.log(bad(`apply falló: ${apply.stderr || apply.stdout}`));
    return;
  }
  console.log(dim(`  ${apply.stdout.split("\n").join(" · ")}`));

  // 4) si la imagen es un tag mutable, el apply no cambia el spec → forzá el restart
  await paso(`rollout restart deploy/${deployName}`, () => run("kubectl", ["--context", spec.context, "-n", spec.namespace, "rollout", "restart", `deploy/${deployName}`]));

  // 5) esperá el rollout — narrado en vivo (kubectl rollout status ya emite
  //    líneas de progreso solo mientras espera).
  const statusCode = await pasoStreamCmd(
    `rollout status deploy/${deployName}`,
    "kubectl",
    ["--context", spec.context, "-n", spec.namespace, "rollout", "status", `deploy/${deployName}`, "--timeout=120s"],
  );
  if (statusCode !== 0) {
    console.log(bad("rollout no convergió"));
    return;
  }

  // 6) verificá la cadena pública
  const host = opts.host ?? hostFor(app, env);
  await doctor(host, "/health");
}
