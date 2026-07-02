// Helper mínimo de la API de Cloudflare para el ciclo de vida del DNS de previews.
//
// El CNAME lo CREA `cloudflared tunnel route dns` (usa el cert.pem, ver dns.ts),
// pero cloudflared NO sabe BORRAR records. Por eso `mke preview down` limpia el
// CNAME vía la API REST, autenticándose con el token `cloudflare-dns-api`
// (mishi-secret, GPG) — nunca se imprime ni se pasa por argv.

import { PREVIEW } from "./mkeConfig.js";
import { run } from "./sh.js";

let cachedToken: string | null = null;

async function token(): Promise<string> {
  if (cachedToken) return cachedToken;
  const r = await run("mishi-secret", ["get", "cloudflare-dns-api"]);
  if (r.code !== 0 || !r.stdout) {
    throw new Error(`no pude leer el secreto cloudflare-dns-api: ${r.stderr || "vacío"}`);
  }
  cachedToken = r.stdout.trim();
  return cachedToken;
}

interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

async function cf(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as { success: boolean; result: unknown; errors?: unknown };
  if (!body.success) {
    throw new Error(`Cloudflare API ${path}: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

/** records DNS que coinciden EXACTO con `name` (fqdn) en la zona mishi.com.co. */
export async function findRecords(name: string): Promise<CfRecord[]> {
  const result = (await cf(
    `/zones/${PREVIEW.zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  )) as CfRecord[];
  return result;
}

/**
 * Borra TODOS los records cuyo nombre sea exactamente `name`. Idempotente:
 * si no hay ninguno, no hace nada. Guardarraíl: solo borra hosts que terminen
 * en `-pre.mishi.com.co` — jamás toca prod ni otros hosts.
 */
export async function deleteRecordsByName(name: string): Promise<number> {
  if (!name.endsWith(`${PREVIEW.hostSuffix}.mishi.com.co`)) {
    throw new Error(`rechazo borrar DNS de '${name}': solo hosts *${PREVIEW.hostSuffix}.mishi.com.co`);
  }
  const records = await findRecords(name);
  for (const rec of records) {
    await cf(`/zones/${PREVIEW.zoneId}/dns_records/${rec.id}`, { method: "DELETE" });
  }
  return records.length;
}
