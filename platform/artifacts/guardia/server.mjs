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
      res.writeHead(204);
      return res.end();
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
    return json(res, 200, usuario ? { autenticado: true, usuario } : { autenticado: false });
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
