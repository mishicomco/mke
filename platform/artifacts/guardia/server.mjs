// artifact-guardia — la puerta de TODOS los artifacts (AI_ARTIFACTS.md §Privacidad).
//
// Los artifacts son PRIVADOS por defecto: Traefik consulta este servicio por
// ForwardAuth antes de servir cualquier respuesta de *-artifact.mishi.com.co.
// Valida la cookie `mishi_sesion` (JWT ES256 del IdP identity-mishi) contra el
// JWKS de AMBOS emisores vivos (prod y stage — la cookie es de dominio
// .mishi.com.co y Santi puede traer sesion de cualquiera de los dos); sin
// sesion valida, 302 al login ALOJADO del IdP con volver= al artifact.
//
// No toca identity-mishi: es pieza de plataforma de mke. Un solo archivo, sin
// framework — la unica dependencia es jose (verificacion JWKS).

import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const IDPS = (process.env.IDPS ?? "https://identity.mishi.com.co,https://identity-stage.mishi.com.co")
  .split(",");
// login alojado: prod por defecto (los artifacts son hosts bare); acepta
// sesiones de ambos, asi que una sesion stage ya puesta nunca re-loguea.
const ENTRAR = process.env.ENTRAR_URL ?? "https://identity.mishi.com.co/entrar";
const EMISOR = "identity-mishi";
const COOKIE = "mishi_sesion";
// AUTORIZACION propia (ley rbac-por-app: el IdP es permisivo y SOLO firma; la
// puerta real es de cada app). El DUEÑO de la verdad es la tabla `accesos` de
// artifact-mishi, consultada por su endpoint interno: dar acceso a alguien es
// `mke artifact acceso ...`, no editar codigo y redeployar.
//
// ALLOWED_EMAILS queda como RESPALDO ANTI-LOCKOUT: si artifact-mishi no
// responde (caido, migrando, red), la puerta cae a esa lista del env en vez de
// dejar a todo el mundo afuera. Fail-closed igual: lista vacia = nadie entra.
const ACCESO_URL = process.env.ACCESO_URL
  ?? "http://artifact-mishi.prod.svc.cluster.local/api/interno/acceso";
// verificar = la ruta que AUTO-PROVISIONA al usuario (le da su fila+rol) antes
// de decidir; sin esto el acceso por `rol:` no funciona (usuarios nunca se
// puebla para artifacts). Le mandamos el usuario COMPLETO del JWT.
const VERIFICAR_URL = process.env.VERIFICAR_URL ?? `${ACCESO_URL}/verificar`;
const PERMITIDOS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const enRespaldo = (email) => PERMITIDOS.includes(email);

/** nombre del artifact desde el host publico (<nombre>-artifact.mishi.com.co). */
const artifactDeHost = (host) =>
  /^([a-z0-9][a-z0-9-]*)-artifact\.mishi\.com\.co$/.exec(
    String(host ?? "").toLowerCase().split(":")[0],
  )?.[1] ?? null;

// Veredicto cacheado 60 s por email|artifact: la ForwardAuth corre en CADA
// request (incluidos assets), y una consulta HTTP por asset seria absurda.
const CACHE_MS = 60_000;
const cache = new Map();

async function autorizado(usuario, host) {
  const email = (usuario?.email ?? "").toLowerCase();
  if (!email) return false;
  const artifact = artifactDeHost(host);
  if (!artifact) return false; // host que no es artifact: no se adivina
  const llave = `${email}|${artifact}`;
  const hit = cache.get(llave);
  if (hit && hit.hasta > Date.now()) return hit.valor;
  let valor;
  try {
    // POST con el usuario COMPLETO: artifact-mishi lo auto-provisiona (fila +
    // rol default) y decide — así el acceso por `rol:` funciona.
    const r = await fetch(VERIFICAR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario, artifact }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    valor = (await r.json()).autorizado === true;
  } catch {
    // respaldo anti-lockout (ver arriba): NO se cachea, para volver a la
    // verdad en cuanto artifact-mishi reviva.
    return enRespaldo(email);
  }
  cache.set(llave, { valor, hasta: Date.now() + CACHE_MS });
  return valor;
}

const jwksSets = IDPS.map((u) => createRemoteJWKSet(new URL(`${u}/v1/llaves`)));

async function usuarioDe(cookieHeader) {
  const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? "")?.[1];
  if (!token) return null;
  for (const jwks of jwksSets) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: EMISOR });
      return payload.usuario ?? null;
    } catch {
      // firma de otro emisor o vencida: prueba el siguiente JWKS
    }
  }
  return null;
}

// ── SSE: pestañas abiertas escuchando "hay nueva version" ──────────────────
// El cliente (mishi.js) abre /_mishi/eventos y queda en silencio; cuando
// `mke artifact publicar` termina el cp, avisa por /avisar (SOLO interno) y
// aca se empuja el evento a las pestañas de ESE artifact, que se recargan.
// Estado en memoria de un solo pod: si la guardia se reinicia, EventSource
// reconecta solo. Sin Redis, sin polling del cliente.
const canales = new Map(); // host -> Set<res>

function suscribir(host, res) {
  if (!canales.has(host)) canales.set(host, new Set());
  canales.get(host).add(res);
  res.on("close", () => {
    canales.get(host)?.delete(res);
    if (canales.get(host)?.size === 0) canales.delete(host);
  });
}

// keepalive: 4 bytes (":ka") por conexion YA abierta — no es polling (sin
// request, sin handshake; con cero pestañas no se escribe nada). Existe solo
// porque los proxies (Cloudflare ~100 s) matan conexiones idle; sin latido el
// navegador reconectaria cada ~100 s y CADA reconexion es una request
// completa — mas cara que el latido. 45 s = margen bajo ese limite.
setInterval(() => {
  for (const conjunto of canales.values()) {
    for (const res of conjunto) res.write(":ka\n\n");
  }
}, 45_000).unref();

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  // el mismo handler sirve /x (ForwardAuth llama directo) y /_mishi/x (la
  // pagina llama por su propio origen via la IngressRoute de /_mishi)
  const ruta = new URL(req.url, "http://x").pathname.replace(/^\/_mishi/, "");

  if (ruta === "/healthz" || ruta === "/readyz") return json(res, 200, { ok: true });

  if (ruta === "/guardia") {
    const usuario = await usuarioDe(req.headers.cookie);
    if (usuario) {
      if (await autorizado(usuario, req.headers["x-forwarded-host"])) {
        res.writeHead(204);
        return res.end();
      }
      // autenticado pero NO autorizado: 403 plano (redirigir al login seria
      // un loop — ya tiene sesion valida, solo que no tiene acceso)
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("403 — esta cuenta no tiene acceso a este artifact");
    }
    // SIEMPRE https: el TLS termina en Cloudflare y el tunel habla http, asi
    // que X-Forwarded-Proto llega "http" — pero el `volverPermitido` del IdP
    // (con razon) solo acepta https, y todo lo publico del ecosistema lo es.
    const host = req.headers["x-forwarded-host"] ?? "";
    const uri = req.headers["x-forwarded-uri"] ?? "/";
    const volver = encodeURIComponent(`https://${host}${uri}`);
    res.writeHead(302, { location: `${ENTRAR}?volver=${volver}` });
    return res.end();
  }

  if (ruta === "/sesion") {
    const usuario = await usuarioDe(req.headers.cookie);
    return json(res, 200, usuario
      ? { autenticado: true, autorizado: await autorizado(usuario, req.headers["x-forwarded-host"]), usuario }
      : { autenticado: false });
  }

  if (ruta === "/eventos") {
    // el host del artifact viene del ingress; la ruta /_mishi va SIN puerta,
    // pero un stream de "hubo publicacion" no filtra ningun dato
    const host = req.headers["x-forwarded-host"];
    if (!host) return json(res, 400, { error: "sin host" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    suscribir(host, res);
    return;
  }

  if (ruta === "/avisar" && req.method === "POST") {
    // SOLO interno (publicar lo llama desde dentro del cluster): lo que vino
    // por Traefik trae X-Forwarded-Host — se rechaza para que nadie pueda
    // recargar pestañas ajenas desde afuera.
    if (req.headers["x-forwarded-host"]) return json(res, 403, { error: "solo interno" });
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      try {
        const { host, version = "" } = JSON.parse(cuerpo);
        const pestanas = canales.get(host)?.size ?? 0;
        for (const s of canales.get(host) ?? []) {
          s.write(`event: publicacion\ndata: ${JSON.stringify({ version })}\n\n`);
        }
        json(res, 200, { avisadas: pestanas });
      } catch {
        json(res, 400, { error: "cuerpo invalido" });
      }
    });
    return;
  }

  if (ruta === "/salir" && req.method === "POST") {
    // el host del artifact esta bajo .mishi.com.co: puede borrar la cookie de
    // dominio. Mismos atributos con los que la planta el IdP.
    res.writeHead(204, {
      "set-cookie": `${COOKIE}=; Domain=.mishi.com.co; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    });
    return res.end();
  }

  json(res, 404, { error: "ruta desconocida" });
}).listen(3000, () => console.log("artifact-guardia :3000"));
