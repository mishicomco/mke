import { envOrThrow } from "./mkeConfig.js";
import { run, ok, bad, info } from "./sh.js";

/**
 * Crea/repara el CNAME del host hacia el tunnel correcto del entorno.
 * Usa SIEMPRE el UUID (no el nombre: `route dns mke-stage` enrutó a lmstudio)
 * y `--overwrite-dns` para reparar un record que ya exista mal apuntado.
 */
export async function ensureDns(host: string, env: string): Promise<boolean> {
  const spec = envOrThrow(env);
  console.log(info(`DNS: ${host} → tunnel ${spec.tunnelUuid} (${env})`));
  const r = await run("cloudflared", [
    "tunnel",
    "route",
    "dns",
    "--overwrite-dns",
    spec.tunnelUuid,
    host,
  ]);
  if (r.code === 0) {
    console.log(ok(`CNAME listo para ${host}`));
    return true;
  }
  console.log(bad(`cloudflared falló: ${r.stderr || r.stdout}`));
  return false;
}
