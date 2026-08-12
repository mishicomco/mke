// Motor COMPARTIDO de "publicar estático a un volumen de plataforma vía
// kubectl cp" — pensado para converger `mke artifact publicar` y `mke preview
// push --v2` en UN dueño (hoy solo lo usa preview v2; ver `AI_PREVIEW_V2.md
// §Norte` para el plan de migrar `artifact.ts` sin cambiar su comportamiento).
//
// Dos piezas puras-de-efecto, sin saber nada de artifacts ni de previews:
//   - copiarArbolAPod: `kubectl cp` de un directorio local a un path DENTRO
//     de un contenedor de un pod/deploy ya vivo.
//   - escribirVersionJson: el contrato del actualizador silencioso del molde
//     (`/version.json` `{version}`) — la semilla que hace que las pestañas
//     abiertas se pongan al día solas (ver `apps/frontend/src/actualizador.ts`
//     del template).
import { run } from "./sh.js";

export interface DestinoPod {
  context: string;
  namespace: string;
  /** nombre de pod O `deploy/<nombre>` (kubectl cp acepta ambos como target). */
  recurso: string;
  contenedor: string;
}

/** `kubectl cp <origenLocal>/. <recurso>:<destino>` — reemplaza el árbol entero. */
export async function copiarArbolAPod(
  destino: DestinoPod,
  origenLocal: string,
  destinoPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("kubectl", [
    "--context", destino.context, "-n", destino.namespace,
    "cp", `${origenLocal}/.`, `${destino.recurso}:${destinoPath}`,
    "-c", destino.contenedor,
  ]);
}

/** escribe `<destinoPath>/version.json` `{"version":"<version>"}` DENTRO del pod. */
export async function escribirVersionJson(
  destino: DestinoPod,
  destinoPath: string,
  version: string,
): Promise<boolean> {
  const r = await run("kubectl", [
    "--context", destino.context, "-n", destino.namespace,
    "exec", destino.recurso, "-c", destino.contenedor, "--",
    "sh", "-c", `printf '{"version":"%s"}' '${version}' > ${destinoPath}/version.json`,
  ]);
  return r.code === 0;
}
