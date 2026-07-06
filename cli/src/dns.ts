import { envOrThrow, PREVIEW } from "./mkeConfig.js";
import { tunnelTarget, upsertCname } from "./cf.js";
import { run, ok, bad, info, dim } from "./sh.js";

/**
 * UUID del túnel de previews/ramas (`mke-preview`). Se resuelve en runtime
 * (`cloudflared tunnel list`, lectura pura) para no hornearlo en config.
 */
export async function previewTunnelUuid(): Promise<string> {
  const r = await run("cloudflared", ["tunnel", "list"]);
  if (r.code !== 0) throw new Error(`cloudflared tunnel list falló: ${r.stderr}`);
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === PREVIEW.tunnelName) return cols[0];
  }
  throw new Error(`no existe el túnel '${PREVIEW.tunnelName}'. Corré primero: scripts/bootstrap-preview.sh`);
}

/**
 * Crea/repara el CNAME del host hacia el tunnel correcto del entorno, vía la
 * API de Cloudflare (token `cloudflare-dns-api` en mishi-secret). Acepta
 * también `preview` como entorno (túnel mke-preview, para previews y ramas).
 * NO se usa `cloudflared tunnel route dns`: enruta mal y no repunta records.
 */
export async function ensureDns(host: string, env: string): Promise<boolean> {
  const uuid = env === "preview" ? await previewTunnelUuid() : envOrThrow(env).tunnelUuid;
  console.log(info(`DNS: ${host} → tunnel ${uuid} (${env})`));
  try {
    const que = await upsertCname(host, tunnelTarget(uuid));
    console.log(ok(que === "ok" ? `CNAME ya apuntaba bien (${host})` : `CNAME ${que} para ${host}`));
    return true;
  } catch (e) {
    console.log(bad(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
    console.log(dim("  (¿existe el secreto cloudflare-dns-api? mishi-secret get cloudflare-dns-api)"));
    return false;
  }
}
