// Cliente del vault-mishi para LEASES efímeros de preview-pods (Contrato 1).
// Un lease = credencial efímera app×rama con TTL corto, ACOTADA a los NOMBRES de
// secretos que la rama declara en `mke.preview.yaml` (fail-closed: el token solo
// puede leer esos; lista vacía = ninguno). Su token es lo único que `mke preview
// up` inyecta al pod (nunca los secretos en claro — eso lo materializa el vault).
// El token EMISOR viene de `mishi-secret get vault-mishi-emisor-token` (identidad
// emisora DEDICADA, no root). PURO en el sentido de "sin globals": el `fetch` es
// inyectable para unit-testear la composición del request sin red (el vault puede
// NO estar arriba mientras se codea esto — la integración en vivo es posterior).

export interface LeaseCreado {
  leaseId: string;
  token: string;
  ns: string;
  rama: string;
  expiraEn: string;
}

export interface LeaseEstado {
  leaseId: string;
  estado: "activo" | "revocado" | "expirado";
  ns: string;
  rama: string;
  expiraEn: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface VaultClienteOpts {
  /** URL base del vault, ej `https://vault-mishi.internal:8443`. */
  vaultUrl: string;
  /** token Bearer de la identidad EMISORA (root en MVP). */
  emisorToken: string;
  fetchImpl?: FetchLike;
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function leerJson(r: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }, contexto: string): Promise<any> {
  if (!r.ok) {
    let detalle = "";
    try { detalle = await r.text(); } catch { /* sin cuerpo */ }
    throw new Error(`vault ${contexto}: HTTP ${r.status}${detalle ? ` — ${detalle}` : ""}`);
  }
  return r.json();
}

export interface CrearLeaseParams {
  /** ns del lease = la app (ej `mishi-bank`). */
  ns: string;
  /** rama git de la que se saca el preview. */
  rama: string;
  /** NOMBRES de secretos declarados en `mke.preview.yaml` de la rama. El vault
   * ACOTA el token a SOLO estos nombres (fail-closed; lista vacía = el pod no
   * lee ningún secreto). OBLIGATORIO en el payload (siempre viaja, aun vacío). */
  secretos: string[];
  /** TTL en segundos (backstop de vida); omitir deja el default del vault. */
  ttlSegundos?: number;
}

/** `POST /v1/lease` — crea un lease app×rama acotado a `secretos`. */
export async function crearLease(opts: VaultClienteOpts, params: CrearLeaseParams): Promise<LeaseCreado> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const body: Record<string, unknown> = { ns: params.ns, rama: params.rama, secretos: params.secretos };
  if (params.ttlSegundos !== undefined) body.ttlSegundos = params.ttlSegundos;
  const r = await f(`${opts.vaultUrl}/v1/lease`, {
    method: "POST",
    headers: headers(opts.emisorToken),
    body: JSON.stringify(body),
  });
  return leerJson(r, "crear lease") as Promise<LeaseCreado>;
}

/** `POST /v1/lease/:leaseId/revoke` — idempotente (200 aunque ya esté revocado/expirado/inexistente). */
export async function revocarLease(opts: VaultClienteOpts, leaseId: string): Promise<{ leaseId: string; estado: string }> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const r = await f(`${opts.vaultUrl}/v1/lease/${encodeURIComponent(leaseId)}/revoke`, {
    method: "POST",
    headers: headers(opts.emisorToken),
  });
  return leerJson(r, "revocar lease");
}

/** `POST /v1/lease/:leaseId/renovar` — extiende `expiraEn`. */
export async function renovarLease(
  opts: VaultClienteOpts,
  leaseId: string,
  ttlSegundos?: number,
): Promise<{ leaseId: string; expiraEn: string }> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const body: Record<string, unknown> = {};
  if (ttlSegundos !== undefined) body.ttlSegundos = ttlSegundos;
  const r = await f(`${opts.vaultUrl}/v1/lease/${encodeURIComponent(leaseId)}/renovar`, {
    method: "POST",
    headers: headers(opts.emisorToken),
    body: JSON.stringify(body),
  });
  return leerJson(r, "renovar lease");
}

/** `GET /v1/lease/:leaseId` — estado actual. */
export async function obtenerLease(opts: VaultClienteOpts, leaseId: string): Promise<LeaseEstado> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const r = await f(`${opts.vaultUrl}/v1/lease/${encodeURIComponent(leaseId)}`, {
    method: "GET",
    headers: headers(opts.emisorToken),
  });
  return leerJson(r, "obtener lease");
}
