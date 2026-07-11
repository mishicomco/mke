import { envOrThrow } from "./mkeConfig.js";
import { run, bad } from "./sh.js";
import { paso, pasoStreamCmd } from "./progresoVivo.js";

/**
 * `rollout restart` + `status` para un Deployment ya desplegado. Útil cuando la
 * imagen es un tag mutable (`:dev`) y querés reiniciar sin rebuild, o reciclar
 * pods tras cambiar un Secret/ConfigMap.
 */
export async function rollout(app: string, env: string, deployName?: string): Promise<void> {
  const spec = envOrThrow(env);
  const name = deployName ?? app;

  const r = await paso(`rollout restart deploy/${name} (${spec.context}/${spec.namespace})`, () => run("kubectl", [
    "--context", spec.context, "-n", spec.namespace,
    "rollout", "restart", `deploy/${name}`,
  ]));
  if (r.code !== 0) {
    console.log(bad(`rollout restart falló: ${r.stderr || r.stdout}`));
    return;
  }

  const statusCode = await pasoStreamCmd(
    `rollout status deploy/${name}`,
    "kubectl",
    ["--context", spec.context, "-n", spec.namespace, "rollout", "status", `deploy/${name}`, "--timeout=120s"],
  );
  if (statusCode !== 0) {
    console.log(bad("rollout no convergió"));
    return;
  }
}
