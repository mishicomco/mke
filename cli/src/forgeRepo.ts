// Forgejo (git-mishi) — creación de repo de app en la org `mishicomco` vía la
// API HTTP del forge, y configuración best-effort del push-mirror a GitHub como
// BACKUP off-site (mecanismo nativo de Forgejo, sync_on_commit).
//
// Ley (../CLAUDE.md §Standard app structure + git-mishi/AI_REPO_STATE.md): el
// repo PRIMARIO de cada app nace en git-mishi (git.mishi.com.co/mishicomco/<app>),
// NO en GitHub; GitHub baja a mirror de respaldo. Este módulo NO toca disco ni
// git local — solo la API del forge. El `git init/commit/push` lo hace appNacer.
//
// Tokens SIEMPRE por mishi-secret, NUNCA impresos:
//   - git-mishi-api-token   → API del forge (crear repo, configurar mirror)
//   - github-mirror-pat     → PAT de GitHub con write, credencial del push-mirror

import { run } from "./sh.js";

export const FORGE = {
  base: "https://git.mishi.com.co",
  org: "mishicomco",
  apiTokenSecret: "git-mishi-api-token",
  /** PAT de GitHub para el push-mirror de respaldo. */
  mirrorPatSecret: "github-mirror-pat",
} as const;

/** URL git HTTPS del repo primario en el forge (lo que será `origin`). */
export function forgeRepoUrl(app: string): string {
  return `${FORGE.base}/${FORGE.org}/${app}.git`;
}

/** Lee un secreto por mishi-secret. Devuelve null si no existe/vacío. Nunca lo imprime. */
export async function secretGet(name: string): Promise<string | null> {
  const r = await run("mishi-secret", ["get", name]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

interface ForgeCall {
  status: number;
  ok: boolean;
  body: string;
}

/** Llamada a la API del forge con el token de API. `path` es relativo a /api/v1. */
async function forgeApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ForgeCall> {
  const res = await fetch(`${FORGE.base}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

/** true si el repo ya existe en la org del forge. */
export async function forgeRepoExists(app: string, token: string): Promise<boolean> {
  const r = await forgeApi(token, "GET", `/repos/${FORGE.org}/${encodeURIComponent(app)}`);
  return r.status === 200;
}

/**
 * Crea el repo `mishicomco/<app>` en el forge (privado, sin auto_init — el
 * primer commit lo empuja appNacer desde el cascarón). Idempotente: si ya
 * existe, no falla. Devuelve {creado} o lanza con el detalle de la API.
 */
export async function forgeCreateRepo(
  app: string,
  token: string,
): Promise<{ creado: boolean }> {
  if (await forgeRepoExists(app, token)) return { creado: false };
  const r = await forgeApi(token, "POST", `/orgs/${FORGE.org}/repos`, {
    name: app,
    private: true,
    auto_init: false,
    default_branch: "main",
  });
  if (r.status === 201) return { creado: true };
  if (r.status === 409) return { creado: false }; // carrera: alguien lo creó
  throw new Error(`forge POST /orgs/${FORGE.org}/repos → ${r.status}: ${r.body.slice(0, 300)}`);
}

/** true si el repo ya tiene un push-mirror configurado en el forge. */
export async function forgePushMirrorExists(app: string, token: string): Promise<boolean> {
  const r = await forgeApi(
    token,
    "GET",
    `/repos/${FORGE.org}/${encodeURIComponent(app)}/push_mirrors`,
  );
  if (r.status !== 200) return false;
  try {
    const arr = JSON.parse(r.body) as unknown[];
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/**
 * Configura el push-mirror del forge → GitHub (respaldo, sync_on_commit).
 * Mecanismo nativo de Forgejo (git-mishi/AI_REPO_STATE.md). Requiere que el
 * repo espejo exista en GitHub y un PAT con write (github-mirror-pat).
 * Idempotente (no duplica si ya hay uno). Lanza con detalle si la API falla.
 */
export async function forgeAddPushMirror(
  app: string,
  token: string,
  mirrorPat: string,
): Promise<{ configurado: boolean }> {
  if (await forgePushMirrorExists(app, token)) return { configurado: false };
  const r = await forgeApi(
    token,
    "POST",
    `/repos/${FORGE.org}/${encodeURIComponent(app)}/push_mirrors`,
    {
      remote_address: `https://github.com/${FORGE.org}/${app}.git`,
      remote_username: "git",
      remote_password: mirrorPat,
      interval: "8h0m0s",
      sync_on_commit: true,
    },
  );
  if (r.status === 200 || r.status === 201) return { configurado: true };
  throw new Error(
    `forge POST push_mirrors → ${r.status}: ${r.body.slice(0, 300)}`,
  );
}
