// Carga de imágenes al cluster de un entorno — ÚNICA vía (deploy, publish,
// artifact guardia). Local: `k3d image import`. Remoto (prod en el laptop
// desde 2026-08-06): `docker save | ssh docker exec ctr images import` — el
// `k3d image import` de un tar remoto reportó verde SIN importar (post-mortem
// de la migración); `ctr` directo al containerd del nodo es la vía verificada.
import { run } from "./sh.js";
import type { EnvSpec } from "./mkeConfig.js";

export async function cargarImagenes(
  envSpec: Pick<EnvSpec, "cluster" | "remote" | "registry">,
  imagenes: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Fase 1: registry local. `docker push` (~1-2 s) reemplaza `k3d image import`
  // (~30 s). El tag local se re-taguea al host `push` y se pushea; el cluster
  // jala por el host `ref` (registries.yaml). El path del repo es idéntico, así
  // que push-host y ref-host apuntan al mismo blob.
  if (envSpec.registry) {
    const { push } = envSpec.registry;
    const cmd = imagenes
      .map((img) => `docker tag ${img} ${push}/${img} && docker push ${push}/${img}`)
      .join(" && ");
    return run("bash", ["-c", cmd]);
  }
  if (envSpec.remote) {
    const { ssh, sshKey, nodo } = envSpec.remote;
    return run("bash", [
      "-c",
      `docker save ${imagenes.join(" ")} | ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new ${ssh} 'docker exec -i ${nodo} ctr -n k8s.io images import -'`,
    ]);
  }
  return run("k3d", ["image", "import", ...imagenes, "-c", envSpec.cluster]);
}

/** Etiqueta humana del paso, para logs. */
export function describeCarga(envSpec: Pick<EnvSpec, "cluster" | "remote" | "registry">, imagenes: string[]): string {
  if (envSpec.registry) {
    return `docker push ${imagenes.map((i) => `${envSpec.registry!.push}/${i}`).join(" + ")} (registry local → pull ${envSpec.registry.ref})`;
  }
  return envSpec.remote
    ? `docker save ${imagenes.join(" + ")} | ssh ${envSpec.remote.ssh} → ctr import (${envSpec.remote.nodo})`
    : `k3d image import ${imagenes.join(" + ")} → ${envSpec.cluster}`;
}
