// `mke feature up|pull|down|estado|ls` — el "feature-pod" (2026-07-10),
// SUCESOR de `mke dev`. Misma anatomía de pod (init clona+instala, vite dev
// HMR + tsx watch, caddy un-solo-origen, postgres efímero) pero secretos/config
// resueltos por LEASE del vault (Contrato 1) leyendo lo que la app DECLARA en
// `mke.feature.yaml` (Contrato 2) — CERO `--env` humano para eso.
//
// Contratos CONGELADOS que este archivo codea EXACTO:
//   Contrato 1 (lease del vault): /home/santi/.claude/jobs/a476b7a4/tmp/CONTRATO-1-lease-vault.md
//   Contrato 2 (manifiesto app):  /home/santi/.claude/jobs/a476b7a4/tmp/CONTRATO-2-manifiesto-app.md
//
// La receta PURA (manifiestos) vive en @mishicomco/dev-receta (manifiestosFeature,
// dueño ÚNICO, compartido con Studio); acá se orquestan los efectos (lease del
// vault, git local, imagen, DNS, kubectl). Cluster mke-preview, ns `feature`;
// JAMÁS mke-prod. Integración en vivo contra el vault = Ola 2 (el vault puede
// no estar arriba mientras se codea esto).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FEATURE, VAULT, appsRoot } from "./mkeConfig.js";
import { manifiestosFeature, featureName, featureHost, selectorDeFeature } from "@mishicomco/dev-receta";
import { deleteRecordsByName, tunnelTarget, upsertCname } from "./cf.js";
import { previewTunnelUuid } from "./dns.js";
import { run, ok, bad, warn, info, dim } from "./sh.js";
import { parseFeatureManifest, manifiestoVacio, type FeatureManifest } from "./featureManifest.js";
import { crearLease, revocarLease, renovarLease, type VaultClienteOpts } from "./vaultLease.js";

const CTX = FEATURE.context;
const NS = FEATURE.namespace;

export interface FeatureUpOpts {
  json?: boolean;
  dryRun?: boolean;
  sinDns?: boolean;
  repoUrl?: string;
  poll?: number;
  seed?: string;
  live?: boolean;
  /** TTL del lease en segundos (default del vault: sugerido 24h). */
  ttlSegundos?: number;
}

export interface FeatureMutOpts {
  json?: boolean;
}

export interface FeatureDownOpts {
  json?: boolean;
  sinDns?: boolean;
}

export interface FeatureLsOpts {
  json?: boolean;
}

// ─── credenciales (mishi-secret; NUNCA en claro) ─────────────────────────────

/** token de la identidad EMISORA del vault (root en MVP). FAIL-LOUD: sin él no
 * se puede pedir/revocar un lease — a diferencia del NODE_AUTH_TOKEN de GitHub
 * Packages (fail-soft), acá no hay fallback razonable. */
async function resolveEmisorToken(dryRun: boolean): Promise<string> {
  if (dryRun) return "dry-run-token"; // nunca se imprime ni se usa de verdad
  const t = await run("mishi-secret", ["get", VAULT.emisorTokenSecret]);
  const token = t.stdout.trim();
  if (t.code !== 0 || !token) {
    throw new Error(`no pude leer el token emisor del vault (mishi-secret get ${VAULT.emisorTokenSecret})`);
  }
  return token;
}

async function resolveRepoUrl(app: string, override: string | undefined, dryRun: boolean): Promise<string> {
  if (override) return override;
  const base = `https://github.com/mishicomco/${app}.git`;
  if (dryRun) return base;
  const t = await run("mishi-secret", ["get", "mishi-studio-gh-read-pat"]);
  if (t.code === 0 && t.stdout.trim()) {
    return `https://x-access-token:${t.stdout.trim()}@github.com/mishicomco/${app}.git`;
  }
  return base;
}

async function resolveNpmToken(dryRun: boolean): Promise<string | undefined> {
  if (dryRun) return undefined;
  const t = await run("mishi-secret", ["get", "mishi-gh-read-packages-pat"]);
  const token = t.stdout.trim();
  return t.code === 0 && token ? token : undefined;
}

function vaultCliente(emisorToken: string): VaultClienteOpts {
  return { vaultUrl: VAULT.url, emisorToken };
}

// ─── manifiesto de la app (Contrato 2) ───────────────────────────────────────

/**
 * Lee `mke.feature.yaml` del checkout LOCAL de la app (repo hermano en
 * `~/mishicomco/<app>`, convención del workspace). NO clona: asume que el repo
 * ya existe como hermano (igual que el resto de `mke`, que corre desde el
 * workspace). Archivo ausente ⇒ manifiesto vacío (Contrato 2, no es error).
 */
export async function leerManifiestoFeature(app: string, dir?: string): Promise<FeatureManifest> {
  const repoDir = dir ?? join(appsRoot(), app);
  try {
    const text = await readFile(join(repoDir, "mke.feature.yaml"), "utf8");
    return parseFeatureManifest(text);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return manifiestoVacio(app);
    throw e;
  }
}

// ─── serialización de la receta ──────────────────────────────────────────────

function manifiestosParaKubectl(
  opts: FeatureUpOpts,
  app: string,
  rama: string,
  repoUrl: string,
  leaseId: string,
  leaseToken: string,
  config: Record<string, string>,
  npmToken?: string,
): string {
  const items = manifiestosFeature({
    app,
    rama,
    repoUrl,
    leaseId,
    leaseToken,
    config,
    imagen: FEATURE.runnerImage,
    pollSeconds: opts.poll,
    seedCmd: opts.seed,
    live: opts.live,
    npmToken,
  });
  return JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 2);
}

async function ensureRunnerImage(imagesDir: string): Promise<void> {
  const img = FEATURE.runnerImage;
  const has = await run("docker", ["image", "inspect", img]);
  if (has.code !== 0) {
    console.log(info(`construyo la imagen del runner ${dim(img)} (primera vez)`));
    const build = await run("docker", ["build", "-t", img, imagesDir]);
    if (build.code !== 0) throw new Error(`docker build del runner falló: ${build.stderr || build.stdout}`);
  }
  console.log(info(`k3d image import ${dim(img)} → ${FEATURE.cluster}`));
  const imp = await run("k3d", ["image", "import", img, "-c", FEATURE.cluster]);
  if (imp.code !== 0) throw new Error(`k3d image import del runner falló: ${imp.stderr || imp.stdout}`);
}

// ─── up ──────────────────────────────────────────────────────────────────────

export async function featureUp(app: string, rama: string, imagesDir: string, opts: FeatureUpOpts): Promise<void> {
  const name = featureName(app, rama);
  const host = featureHost(app, rama);
  const url = `https://${host}`;

  const manifiesto = await leerManifiestoFeature(app);
  const repoUrl = await resolveRepoUrl(app, opts.repoUrl, opts.dryRun === true);
  const npmToken = await resolveNpmToken(opts.dryRun === true);
  const emisorToken = await resolveEmisorToken(opts.dryRun === true);

  if (opts.dryRun) {
    // en dry-run no pedimos lease real (no tocamos el vault); mostramos el bundle
    // con un lease/token de mentira, nunca imprimimos tokens reales.
    const manifiestos = manifiestosParaKubectl(opts, app, rama, repoUrl, "dry-run-lease", "dry-run-token", manifiesto.config, npmToken);
    console.log(manifiestos);
    return;
  }

  const emit = (estado: string, leaseId: string | null): void => {
    if (opts.json) console.log(JSON.stringify({ app, rama, name, host, url, leaseId, estado }));
  };

  if (!opts.json) console.log(info(`feature ${dim(app)} · rama ${dim(rama)} → ${dim(host)}`));

  // 1) lease del vault (Contrato 1): secretos declarados en el manifiesto se
  //    resuelven SOLOS por el token del lease — mke nunca los ve en claro.
  if (!opts.json) console.log(info(`pidiendo lease al vault (${manifiesto.secretos.length} secreto(s) declarados)…`));
  const lease = await crearLease(vaultCliente(emisorToken), app, rama, opts.ttlSegundos);
  if (!opts.json) console.log(ok(`lease ${dim(lease.leaseId)} · expira ${dim(lease.expiraEn)}`));

  const manifiestos = manifiestosParaKubectl(opts, app, rama, repoUrl, lease.leaseId, lease.token, manifiesto.config, npmToken);

  // 2) túnel + imagen + apply
  const uuid = opts.sinDns ? null : await previewTunnelUuid();
  await ensureRunnerImage(imagesDir);
  const apply = await run("kubectl", ["--context", CTX, "apply", "-f", "-"], manifiestos);
  if (apply.code !== 0) throw new Error(`apply falló: ${apply.stderr || apply.stdout}`);
  if (!opts.json) console.log(ok(apply.stdout.split("\n").join(" · ")));

  // 3) rollout
  if (!opts.json) console.log(info("esperando el pod (clone + npm install)…"));
  const rollout = await run("kubectl", ["--context", CTX, "-n", NS, "rollout", "status", `deploy/${name}`, "--timeout=600s"]);
  const listo = rollout.code === 0;
  if (!opts.json) console.log(listo ? ok(rollout.stdout.split("\n").pop() ?? "pod listo") : warn(`el pod no convergió aún: ${rollout.stderr || rollout.stdout}`));

  // 4) DNS
  if (!opts.sinDns && uuid) {
    try {
      const que = await upsertCname(host, tunnelTarget(uuid));
      if (!opts.json) console.log(ok(que === "ok" ? "CNAME ya apuntaba bien" : `CNAME ${que}`));
    } catch (e) {
      if (!opts.json) console.log(warn(`Cloudflare API: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  const estado = listo ? "aplicado" : "pendiente";
  emit(estado, lease.leaseId);
  if (!opts.json) console.log(listo ? ok(`feature aplicado → ${url}`) : warn(`aplicado pero el pod no convergió: revisá con kubectl`));
}

// ─── pull (git en el pod + renovar el lease) ─────────────────────────────────

export async function featurePull(app: string, rama: string, opts: FeatureMutOpts): Promise<void> {
  const name = featureName(app, rama);
  if (!opts.json) console.log(info(`feature ${dim(name)}: pull de la rama activa`));
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "exec", `deploy/${name}`, "-c", "dev", "--", "sh", "/mke/pull.sh"]);
  if (!opts.json) {
    for (const l of (r.stdout || r.stderr).split("\n")) if (l.trim()) console.log(dim(`  │ ${l}`));
  }
  if (r.code !== 0) {
    if (!opts.json) console.log(bad(`pull falló: ${r.stderr || r.stdout}`));
    if (opts.json) console.log(JSON.stringify({ app, rama, name, estado: "error" }));
    return;
  }

  // renovar el lease (mantiene vivo el pod mientras se sigue trabajando)
  const leaseId = await leaseIdDe(app, rama);
  let renovado: string | null = null;
  if (leaseId) {
    try {
      const emisorToken = await resolveEmisorToken(false);
      const r2 = await renovarLease(vaultCliente(emisorToken), leaseId);
      renovado = r2.expiraEn;
    } catch (e) {
      if (!opts.json) console.log(warn(`no pude renovar el lease: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  if (!opts.json) console.log(ok(`al día${renovado ? ` · lease renovado hasta ${renovado}` : ""}`));
  else console.log(JSON.stringify({ app, rama, name, leaseId, expiraEn: renovado, estado: "al-dia" }));
}

// ─── down: busca el lease de esa app×rama → revoke (idempotente) ────────────

/** lee el label `mke.feature/lease` del Deployment del bundle app×rama, si
 * existe. Es el "lookup leaseId por app×rama" que el Contrato 2 pide encapsular
 * (mke lo escribió él mismo al hacer `up`, vía la convención de labels del
 * Contrato 1). `null` si no hay bundle vivo (down ya aplicado = no-op). */
export async function leaseIdDe(app: string, rama: string): Promise<string | null> {
  const sel = selectorDeFeature(app, rama);
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "jsonpath={.items[0].metadata.labels.mke\\.feature/lease}"]);
  const leaseId = r.stdout.trim();
  return r.code === 0 && leaseId ? leaseId : null;
}

/**
 * Compone el "buscar leaseId → revoke" de forma IDEMPOTENTE y testeable sin red
 * ni kubectl: sin lease encontrado (bundle ya bajado / nunca existió) es un
 * no-op (200 conceptual, igual que el `revoke` del vault); con lease, delega en
 * el `revocar` inyectado exactamente una vez. Es el corazón de `mke feature down`
 * y del helper que el workflow de teardown del Contrato 2 invoca.
 */
export async function revocarSiHayLease(
  leaseId: string | null,
  revocar: (leaseId: string) => Promise<{ leaseId: string; estado: string }>,
): Promise<{ revocado: boolean; leaseId: string | null }> {
  if (!leaseId) return { revocado: false, leaseId: null };
  await revocar(leaseId);
  return { revocado: true, leaseId };
}

/**
 * `mke feature down <app> <rama>`: busca el leaseId de esa app×rama y revoca
 * (Contrato 1, idempotente — revocar sin lease vivo es 200 no-op). Además borra
 * el bundle k8s DIRECTO (por label) para feedback inmediato; el reconciliador
 * del vault lo haría igual por la revocación (outcome garantizado por el vault),
 * pero no hace daño adelantarlo — es idempotente. Es el helper que el workflow
 * de teardown del template (Contrato 2) invoca en `on: delete` / merge a main.
 */
export async function featureDown(app: string, rama: string, opts: FeatureDownOpts): Promise<void> {
  const name = featureName(app, rama);
  const host = featureHost(app, rama);
  if (!opts.json) console.log(info(`bajando feature-pod ${dim(name)} (${host})`));

  const leaseId = await leaseIdDe(app, rama);
  let revocado = false;
  if (leaseId) {
    try {
      const emisorToken = await resolveEmisorToken(false);
      const r = await revocarSiHayLease(leaseId, (id) => revocarLease(vaultCliente(emisorToken), id));
      revocado = r.revocado;
      if (!opts.json) console.log(ok(`lease ${dim(leaseId)} revocado`));
    } catch (e) {
      if (!opts.json) console.log(warn(`no pude revocar el lease (¿vault caído? el TTL igual lo limpia): ${e instanceof Error ? e.message : String(e)}`));
    }
  } else if (!opts.json) {
    console.log(dim("  sin lease vivo para esta app×rama (no-op)"));
  }

  const del = await run("kubectl", [
    "--context", CTX, "-n", NS,
    "delete", "deployment,service,ingress,configmap,secret",
    "-l", selectorDeFeature(app, rama),
    "--ignore-not-found", "--wait=false",
  ]);
  if (!opts.json) {
    if (del.code === 0) console.log(ok(del.stdout || `recursos de ${name} borrándose`));
    else console.log(warn(`no pude borrar recursos: ${del.stderr || del.stdout}`));
  }

  let dnsBorrado = false;
  if (!opts.sinDns) {
    try {
      const n = await deleteRecordsByName(host);
      dnsBorrado = n > 0;
      if (!opts.json) console.log(ok(n ? `CNAME ${host} borrado` : `no había CNAME ${host}`));
    } catch (e) {
      if (!opts.json) console.log(bad(`DNS: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (opts.json) console.log(JSON.stringify({ app, rama, name, host, leaseId, revocado, dnsBorrado, estado: "apagado" }));
}

// ─── estado / ls ──────────────────────────────────────────────────────────────

export async function featureEstado(app: string, rama: string, opts: FeatureMutOpts): Promise<void> {
  const name = featureName(app, rama);
  const host = featureHost(app, rama);
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", name, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log(JSON.stringify({ app, rama, name, host, estado: "apagado" }));
    else console.log(warn(`no hay feature-pod ${dim(name)} encendido`));
    return;
  }
  let d: any = {};
  try { d = JSON.parse(r.stdout); } catch { /* vacío */ }
  const labels = d.metadata?.labels ?? {};
  const ann = d.metadata?.annotations ?? {};
  const avail = d.status?.availableReplicas ?? 0;
  const total = d.status?.replicas ?? 0;
  const estadoPod = avail > 0 ? "vivo" : total > 0 ? "arrancando" : "detenido";
  const leaseId = labels["mke.feature/lease"] ?? null;

  if (opts.json) {
    console.log(JSON.stringify({ app, rama, name, host, leaseId, sha: ann["mke.feature/sha"] ?? null, estado: estadoPod }));
    return;
  }
  console.log(`\n  feature-pod ${info(name)} ${dim(`[${estadoPod}]`)}`);
  console.log(`    lease: ${info(leaseId ?? "?")}`);
  console.log(`    → https://${host}\n`);
}

interface FeatureRow {
  app: string;
  rama: string;
  name: string;
  host: string;
  leaseId: string;
  estado: string;
}

export async function featureLs(app: string | undefined, opts: FeatureLsOpts): Promise<void> {
  const sel = app ? `mke.feature/app=${app}` : "mke.feature/app";
  const r = await run("kubectl", ["--context", CTX, "-n", NS, "get", "deploy", "-l", sel, "-o", "json"]);
  if (r.code !== 0) {
    if (opts.json) console.log("[]");
    else console.log(bad(`no pude listar (¿existe el clúster/namespace ${NS}?): ${r.stderr.split("\n")[0]}`));
    return;
  }
  let items: unknown[] = [];
  try { items = (JSON.parse(r.stdout) as { items?: unknown[] }).items ?? []; } catch { /* namespace vacío */ }

  const rows: FeatureRow[] = items.map((it) => {
    const d = it as { metadata?: { labels?: Record<string, string> } };
    const labels = d.metadata?.labels ?? {};
    const appL = labels["mke.feature/app"] ?? "?";
    const ramaL = labels["mke.feature/rama"] ?? "?";
    return {
      app: appL,
      rama: ramaL,
      name: labels["mke.feature/lease"] ? `${appL}-${ramaL}` : "?",
      host: `${appL}-${ramaL}${FEATURE.hostSuffix}.mishi.com.co`,
      leaseId: labels["mke.feature/lease"] ?? "?",
      estado: "vivo",
    };
  });

  if (opts.json) { console.log(JSON.stringify(rows)); return; }
  console.log(`\n  feature-pods ${dim(`(${CTX} · ns ${NS})`)}`);
  if (!rows.length) { console.log(`    ${dim("(ninguno)")}\n`); return; }
  for (const row of rows) {
    console.log(`    ${info(row.name)} ${dim(`[lease ${row.leaseId}]`)} → https://${row.host}`);
  }
  console.log("");
}
