// CATÁLOGO AL EDGE — empuja la vista PROD del catálogo al KV del worker
// status-mishi-edge (Cloudflare), clave `catalogo`. Es el amarre que hace que
// una app nueva en prod aparezca sola en status.mishi.com.co: mke ya sabe
// cuándo cambió el mundo (cada deploy/init), así que mke avisa.
//
// Contrato con status-mishi (apps/edge/worker.js):
//   KV `status-mishi-estado`, clave `catalogo` =
//     { ts, hosts: [{ host, nombre, ruta?, critico? }] }
//   Solo hosts de PROD (status es la cara pública; stage no le importa al
//   visitante). El worker cae a su SEMILLA si esta clave no existe.
//
// La PLATAFORMA (hosts que no salen de ingresses de apps: forge, mesh, vault,
// dominios externos) se declara UNA sola vez, aquí — el worker no declara
// hosts nunca más.
//
// Best-effort y NUNCA fatal, igual que el ConfigMap: un KV desactualizado no
// justifica tumbar un deploy que ya está sano.

import { entradaDeEnv, type EntradaCatalogo } from "./catalogo.js";
import { run, ok, warn, dim } from "./sh.js";
import { accesoDeploy, leerValor } from "./secretosDelVault.js";

const KV_TITLE = "status-mishi-estado";
const CLAVE = "catalogo";

export interface HostEdge {
  host: string;
  nombre: string;
  ruta?: string;
  critico?: boolean;
  /** true = app con backend; false = página estática (el tablero los separa). */
  api?: boolean;
}

/** Hosts que el catálogo derivado no puede ver (otros ns, dominios externos). */
export const PLATAFORMA: HostEdge[] = [
  { host: "mesh.mishi.com.co", nombre: "MeshCentral", critico: true, api: true },
  { host: "mishi.com.co", nombre: "mishi.com.co", api: false },
  { host: "git.mishi.com.co", nombre: "Forge (git)", api: true },
  { host: "vault.mishi.com.co", nombre: "Vault", ruta: "/salud", api: true },
  { host: "llego.com.co", nombre: "Llegó", api: true },
  { host: "travelhabit.co", nombre: "TravelHabit", api: true },
];

/** Vista prod del catálogo + plataforma, en el formato del worker. PURA. */
export function hostsParaEdge(catalogo: EntradaCatalogo[]): HostEdge[] {
  const derivados: HostEdge[] = catalogo
    .filter((e) => entradaDeEnv(e, "prod"))
    .filter((e) => e.host !== "status.mishi.com.co")
    .map((e) => ({ host: e.host, nombre: e.app, api: e.api, ...(e.api && e.ruta ? { ruta: e.ruta } : {}) }));
  // Si un host de PLATAFORMA ya salió derivado del cluster, sus atributos
  // (critico, ruta) se FUSIONAN en la entrada derivada — no se pierden.
  const porHost = new Map(derivados.map((h) => [h.host, h]));
  for (const p of PLATAFORMA) {
    const derivado = porHost.get(p.host);
    if (!derivado) porHost.set(p.host, p);
    else {
      if (p.critico) derivado.critico = true;
      if (p.ruta && !derivado.ruta) derivado.ruta = p.ruta;
    }
  }
  return [...porHost.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

let cachedToken: string | null = null;
async function token(): Promise<string> {
  if (cachedToken) return cachedToken;
  const delEntorno = process.env.CLOUDFLARE_WORKERS_API?.trim();
  if (delEntorno) return (cachedToken = delEntorno);
  // Camino del RUNNER (fábrica mke-ci, sin CLI vault-mishi): identidad de deploy
  // por HTTP, igual que MATERIALIZAR. El CLI humano queda como fallback del gamer.
  const acc = await accesoDeploy();
  if (acc) {
    try {
      return (cachedToken = await leerValor(acc, "santi", "cloudflare-workers-api"));
    } catch {
      /* cae al CLI humano */
    }
  }
  const r = await run("vault-mishi", ["get", "cloudflare-workers-api"]);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`no pude leer cloudflare-workers-api: ${r.stderr || "vacío"} (fallback: env CLOUDFLARE_WORKERS_API)`);
  }
  return (cachedToken = r.stdout.trim());
}

async function cf(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as { success: boolean; result: unknown; errors?: unknown };
  if (!body.success) throw new Error(`Cloudflare API ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

let kvRuta: string | null = null; // /accounts/<id>/storage/kv/namespaces/<nsId>
async function rutaDelKv(): Promise<string> {
  if (kvRuta) return kvRuta;
  const cuentas = (await cf("/accounts")) as Array<{ id: string }>;
  const account = cuentas[0]?.id;
  if (!account) throw new Error("el token no ve la cuenta de Cloudflare");
  const namespaces = (await cf(`/accounts/${account}/storage/kv/namespaces?per_page=100`)) as Array<{
    id: string;
    title: string;
  }>;
  const ns = namespaces.find((n) => n.title === KV_TITLE);
  if (!ns) throw new Error(`no existe el KV '${KV_TITLE}' (¿corrió deploy-edge.sh de status-mishi?)`);
  return (kvRuta = `/accounts/${account}/storage/kv/namespaces/${ns.id}`);
}

/** Publica la vista prod del catálogo en el KV del edge. Nunca lanza. */
export async function publicarCatalogoEdge(catalogo: EntradaCatalogo[]): Promise<void> {
  try {
    const hosts = hostsParaEdge(catalogo);
    const valor = JSON.stringify({ ts: new Date().toISOString(), hosts }, null, 2);
    await cf(`${await rutaDelKv()}/values/${CLAVE}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: valor,
    });
    console.log(ok(`catálogo ${dim("edge (KV status-mishi-estado)")} publicado — ${hosts.length} host(s) de prod`));
  } catch (e) {
    console.log(warn(`catálogo edge no se pudo publicar (sigo): ${e instanceof Error ? e.message : e}`));
  }
}
