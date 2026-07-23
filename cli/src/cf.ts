// Helper mínimo de la API de Cloudflare para el ciclo de vida del DNS de MKE.
//
// TODO el DNS va por la API REST (token `cloudflare-dns-api` en mishi-secret,
// GPG — nunca se imprime ni se pasa por argv). `cloudflared tunnel route dns`
// quedó descartado: enruta al túnel equivocado, no sabe REPUNTAR un record
// existente a otro túnel ni borrarlo. El upsert de acá sí hace las tres cosas.

import { PREVIEW } from "./mkeConfig.js";
import { previewPodHost } from "@mishicomco/dev-receta";
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

/** Resuelve el zoneId de Cloudflare para un fqdn: lista las zonas de la cuenta
 * (cacheado) y elige la de sufijo más largo que calce (multi-dominio:
 * mishi.com.co, llego.com.co, travelhabit.co, …). Fallback: la zona mishi. */
let zonasCache: Array<{ id: string; name: string }> | null = null;
export async function zoneIdParaHost(fqdn: string): Promise<string> {
  if (!zonasCache) {
    zonasCache = (await cf(`/zones?per_page=50`)) as Array<{ id: string; name: string }>;
  }
  const zona = zonasCache
    .filter((z) => fqdn === z.name || fqdn.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return zona?.id ?? PREVIEW.zoneId;
}

/** records DNS que coinciden EXACTO con `name` (fqdn), en SU zona. */
export async function findRecords(name: string): Promise<CfRecord[]> {
  const zone = await zoneIdParaHost(name);
  const result = (await cf(
    `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`,
  )) as CfRecord[];
  return result;
}

/** target CNAME de un túnel cloudflared. */
export function tunnelTarget(uuid: string): string {
  return `${uuid}.cfargotunnel.com`;
}

/**
 * Crea o REPUNTA el CNAME `name` → `target` (proxied). Idempotente:
 *  - ya apunta bien → no toca nada;
 *  - existe apuntando a otro lado (p.ej. al túnel equivocado) → PATCH;
 *  - no existe → POST.
 * Si hay records duplicados con el mismo nombre, corrige el primero y borra el resto.
 * Devuelve qué hizo, para narrar.
 */
export async function upsertCname(name: string, target: string): Promise<"ok" | "creado" | "repuntado"> {
  const zone = await zoneIdParaHost(name);
  const records = await findRecords(name);
  const body = JSON.stringify({ type: "CNAME", name, content: target, proxied: true, ttl: 1 });
  for (const extra of records.slice(1)) {
    await cf(`/zones/${zone}/dns_records/${extra.id}`, { method: "DELETE" });
  }
  const rec = records[0];
  if (!rec) {
    await cf(`/zones/${zone}/dns_records`, { method: "POST", body });
    return "creado";
  }
  if (rec.type === "CNAME" && rec.content === target) return "ok";
  await cf(`/zones/${zone}/dns_records/${rec.id}`, { method: "PATCH", body });
  return "repuntado";
}

/**
 * Borra TODOS los records cuyo nombre sea exactamente `name`. Idempotente:
 * si no hay ninguno, no hace nada. Guardarraíl: solo borra hosts efímeros que
 * terminen en `-pre.mishi.com.co` (previews viejos) o `-feat.mishi.com.co`
 * (dev/rama) — jamás toca prod ni otros hosts.
 *
 * `mke preview` (2026-07-11) usa un host BARE `<app>-<slug(rama)>.mishi.com.co`
 * sin sufijo fijo (un solo label DNS), así que no puede validarse por sufijo:
 * el guardarraíl acá es EXACTO — solo se permite si `name` es literalmente el
 * host que `previewPodHost(previewApp, previewRama)` calcularía (que SIEMPRE
 * lleva la rama en el nombre — no puede colisionar con un host bare de prod).
 */
const SUFIJOS_EFIMEROS = [`${PREVIEW.hostSuffix}.mishi.com.co`, "-feat.mishi.com.co"];

export async function deleteRecordsByName(
  name: string,
  opts: { previewApp?: string; previewRama?: string } = {},
): Promise<number> {
  const esPreviewExacto = Boolean(
    opts.previewApp && opts.previewRama && name === previewPodHost(opts.previewApp, opts.previewRama),
  );
  if (!SUFIJOS_EFIMEROS.some((s) => name.endsWith(s)) && !esPreviewExacto) {
    throw new Error(`rechazo borrar DNS de '${name}': solo hosts efímeros ${SUFIJOS_EFIMEROS.join(" / ")} o el host EXACTO de un preview-pod (app+rama)`);
  }
  const zone = await zoneIdParaHost(name);
  const records = await findRecords(name);
  for (const rec of records) {
    await cf(`/zones/${zone}/dns_records/${rec.id}`, { method: "DELETE" });
  }
  return records.length;
}
