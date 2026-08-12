// pgrst-puerta — cookie mishi_sesion → Authorization: Bearer, para PostgREST.
//
// Pieza de plataforma mke (hermana de artifact-guardia): Traefik la consulta
// por ForwardAuth antes de cada request a un PostgREST; valida la cookie
// (JWT ES256 del IdP, AMBOS emisores — la cookie es de dominio .mishi.com.co)
// y devuelve el MISMO token como header Authorization, que el middleware copia
// al request upstream (authResponseHeaders). PostgREST re-valida la firma (dos
// candados) y el `sub` alimenta las políticas RLS.
//
// Sin sesión: 401 JSON — el cliente es un fetch de SPA, no una navegación;
// redirigir al login es trabajo del front (patrón distinto a la guardia).

import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const IDPS = (process.env.IDPS ?? "https://identity.mishi.com.co,https://identity-stage.mishi.com.co").split(",");
const EMISOR = "identity-mishi";
const COOKIE = "mishi_sesion";
const jwksSets = IDPS.map((u) => createRemoteJWKSet(new URL(`${u}/v1/llaves`)));

async function tokenValido(cookieHeader) {
  const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? "")?.[1];
  if (!token) return null;
  for (const jwks of jwksSets) {
    try {
      await jwtVerify(token, jwks, { issuer: EMISOR });
      return token;
    } catch {
      // firma de otro emisor o vencida: prueba el siguiente JWKS
    }
  }
  return null;
}

createServer(async (req, res) => {
  const ruta = new URL(req.url, "http://x").pathname;
  if (ruta === "/healthz" || ruta === "/readyz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }
  const token = await tokenValido(req.headers.cookie);
  if (token) {
    res.writeHead(204, { authorization: `Bearer ${token}` });
    return res.end();
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end('{"error":"sin sesión"}');
}).listen(3000, () => console.log("pgrst-puerta :3000"));
