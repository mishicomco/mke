// postgrest-flota — supervisor de procesos PostgREST por inquilino (AI_GRADUACION.md).
//
// UN pod sirve a N inquilinos (artifacts y apps): rutea por Host; si el
// inquilino tiene proceso PostgREST vivo, le pasa el request (localhost);
// si no, lo LANZA (<1s, binario intacto apuntando a SU base) y mata los que
// llevan IDLE_MS sin tráfico. Scale-to-zero a nivel de PROCESO: la RAM y las
// conexiones las pagan solo los inquilinos activos a la vez.
//
// Config = /config/inquilinos.json (Secret montado, lo escribe mke):
//   { "block-stage.mishi.com.co": { "dbUri": "postgres://...", "schemas": "public" }, ... }
// Se relee en caliente ante cambio de mtime (los Secrets montados rotan solos).
// El JWT (JWKS de ambos emisores) es COMPARTIDO: /config/jwks.json.
//
// La sesión la exige pgrst-puerta (ForwardAuth) ANTES de llegar acá; cada
// proceso PostgREST re-valida la firma igual (dos candados).

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const CONFIG = process.env.CONFIG_PATH ?? "/config/inquilinos.json";
const JWKS_PATH = process.env.JWKS_PATH ?? "/config/jwks.json";
const POSTGREST = process.env.POSTGREST_BIN ?? "postgrest";
const IDLE_MS = Number(process.env.IDLE_MS ?? 10 * 60_000);
const BASE_PORT = 4000;

let inquilinos = {};
let configMtime = 0;
function cargarConfig() {
  try {
    const m = statSync(CONFIG).mtimeMs;
    if (m === configMtime) return;
    configMtime = m;
    inquilinos = JSON.parse(readFileSync(CONFIG, "utf8"));
    console.log(`config: ${Object.keys(inquilinos).length} inquilinos`);
    // un inquilino borrado de la config muere de una (no espera el idle)
    for (const host of procesos.keys()) if (!inquilinos[host]) matar(host, "fuera de config");
  } catch (e) {
    console.error(`config ilegible (sigo con la anterior): ${e.message}`);
  }
}

const jwks = readFileSync(JWKS_PATH, "utf8");

// ── Autorización iam-mishi (opcional por inquilino) ─────────────────────────
// Ley del ecosistema: las apps chequean PERMISOS, nunca roles. Si el inquilino
// declara `iam: { app, token, permisos: [...] }` en su config, cada request
// consulta POST /v1/check (token DE ESE inquilino — token-por-app, sin
// súper-token compartido; cache 60 s por email|app) y se inyecta
// `X-Mishi-Permisos: <concedidos separados por coma>` al request upstream —
// las políticas RLS lo leen vía request.headers de PostgREST. Fail-closed:
// iam caído o token malo = CERO permisos (la sesión y el RLS por sub siguen).
// El header entrante SIEMPRE se pisa: el cliente jamás puede traer el suyo.
const IAM_URL = process.env.IAM_URL ?? "http://iam-mishi.stage.svc.cluster.local";
const iamCache = new Map(); // email|app -> { permisos, hasta }

function emailDelJwt(auth) {
  try {
    const payload = JSON.parse(Buffer.from(String(auth).split(" ")[1].split(".")[1], "base64url").toString());
    return payload?.usuario?.email ?? payload?.email ?? null;
  } catch {
    return null;
  }
}

async function permisosDe(cfgIam, auth) {
  const email = emailDelJwt(auth);
  if (!email) return "";
  const llave = `${email}|${cfgIam.app}`;
  const hit = iamCache.get(llave);
  if (hit && hit.hasta > Date.now()) return hit.permisos;
  let permisos = "";
  try {
    const r = await fetch(`${IAM_URL}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfgIam.token}` },
      body: JSON.stringify({ principal: email, app: cfgIam.app, permisos: cfgIam.permisos }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`iam ${r.status}`);
    const { resultados } = await r.json();
    permisos = cfgIam.permisos.filter((p) => resultados?.[p] === true).join(",");
    iamCache.set(llave, { permisos, hasta: Date.now() + 60_000 });
  } catch (e) {
    console.error(`iam check falló para ${cfgIam.app} (fail-closed, sin cache): ${e.message}`);
  }
  return permisos;
}

// host -> { port, child, listo: Promise, ultimoUso }
const procesos = new Map();
let siguientePuerto = BASE_PORT;

function matar(host, motivo) {
  const p = procesos.get(host);
  if (!p) return;
  procesos.delete(host);
  p.child.kill("SIGTERM");
  console.log(`↓ ${host} (${motivo})`);
}

setInterval(() => {
  cargarConfig();
  const ahora = Date.now();
  for (const [host, p] of procesos) {
    if (ahora - p.ultimoUso > IDLE_MS) matar(host, `idle ${Math.round(IDLE_MS / 60000)}m`);
  }
}, 30_000).unref();

function lanzar(host) {
  const cfg = inquilinos[host];
  const port = siguientePuerto++;
  const child = spawn(POSTGREST, [], {
    env: {
      PATH: process.env.PATH,
      PGRST_DB_URI: cfg.dbUri,
      PGRST_DB_SCHEMAS: cfg.schemas ?? "public",
      PGRST_DB_ANON_ROLE: cfg.anonRole ?? "",
      PGRST_JWT_SECRET: jwks,
      PGRST_SERVER_PORT: String(port),
      PGRST_ADMIN_SERVER_PORT: String(port + 10_000),
      PGRST_DB_POOL: String(cfg.pool ?? 3), // pocos usuarios constantes: sobra
      PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => {
    // muerte inesperada (OOM, DB caída): fuera del mapa; el próximo request relanza
    if (procesos.get(host)?.child === child) {
      procesos.delete(host);
      console.log(`✗ ${host} salió (code ${code})`);
    }
  });
  // listo = el admin server responde /ready (readiness real de PostgREST)
  const listo = (async () => {
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      try {
        const ok = await new Promise((res) => {
          httpRequest({ host: "127.0.0.1", port: port + 10_000, path: "/ready", timeout: 300 },
            (r) => res(r.statusCode === 200)).on("error", () => res(false)).end();
        });
        if (ok) { console.log(`↑ ${host} :${port} en ${Date.now() - t0}ms`); return; }
      } catch { /* aún no */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("PostgREST no llegó a ready en 10s");
  })();
  const p = { port, child, listo, ultimoUso: Date.now() };
  procesos.set(host, p);
  return p;
}

createServer(async (req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, vivos: [...procesos.keys()] }));
  }
  cargarConfig();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0];
  if (!inquilinos[host]) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `inquilino desconocido: ${host}` }));
  }
  let p = procesos.get(host) ?? lanzar(host);
  p.ultimoUso = Date.now();
  try {
    await p.listo;
  } catch (e) {
    matar(host, `no arrancó: ${e.message}`);
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "el motor de datos no arrancó; reintenta" }));
  }
  const headers = { ...req.headers, host: "127.0.0.1" };
  delete headers["x-mishi-permisos"]; // jamás se acepta del cliente
  const cfgIam = inquilinos[host].iam;
  if (cfgIam?.app && cfgIam?.token && cfgIam?.permisos?.length) {
    headers["x-mishi-permisos"] = await permisosDe(cfgIam, headers.authorization);
  }
  const upstream = httpRequest(
    { host: "127.0.0.1", port: p.port, path: req.url, method: req.method, headers },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proceso del inquilino no respondió" }));
  });
  req.pipe(upstream);
}).listen(3000, () => {
  cargarConfig();
  console.log("postgrest-flota :3000");
});
