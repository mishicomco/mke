// Ciclo de vida del repo en git-mishi (Forgejo) — el forge es LA casa de los
// repos del ecosistema; GitHub baja a mirror de backup (ver git-mishi/AI_REPO_STATE).
//
// Decisión Santi 2026-07-20: `mke` debe poder crear el repo en git-mishi por sí
// mismo (nada de `gh repo create` ni curl a mano). Este módulo es el helper de la
// API de Forgejo para el nacimiento del repo, idempotente check-before-create,
// espejando el estilo de cf.ts (secreto por mishi-secret, nunca por argv/stdout).
//
// Token: `git-mishi-api-token` en mishi-secret (scopes write:organization +
// write:repository). Distinto del `git-mishi-token` (solo push, sin scope de API).

import { run } from "./sh.js";

const FORGE = "https://git.mishi.com.co";
const ORG = "mishicomco";

let cachedToken: string | null = null;

async function token(): Promise<string> {
  if (cachedToken) return cachedToken;
  const r = await run("mishi-secret", ["get", "git-mishi-api-token"]);
  if (r.code !== 0 || !r.stdout) {
    throw new Error(
      "no pude leer el secreto git-mishi-api-token (scopes write:organization+write:repository). " +
        "Créalo una vez en el forge y guárdalo con `mishi-secret set git-mishi-api-token`.",
    );
  }
  cachedToken = r.stdout.trim();
  return cachedToken;
}

async function forge(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${FORGE}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `token ${await token()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** URL HTTPS de clonado del repo en el forge (origin primario de la app). */
export function forgeCloneUrl(app: string): string {
  return `${FORGE}/${ORG}/${app}.git`;
}

/** true si el repo ya existe en el forge. */
export async function forgeRepoExists(app: string): Promise<boolean> {
  const res = await forge(`/repos/${ORG}/${app}`);
  return res.status === 200;
}

export interface EnsureForgeRepoResult {
  already: boolean;
  cloneUrl: string;
}

/**
 * Asegura el repo `mishicomco/<app>` en git-mishi (privado). Idempotente:
 * si ya existe reporta already=true sin tocar nada. Devuelve la URL de clonado
 * para usar como `origin` primario.
 */
export async function ensureForgeRepo(app: string): Promise<EnsureForgeRepoResult> {
  const cloneUrl = forgeCloneUrl(app);
  if (await forgeRepoExists(app)) return { already: true, cloneUrl };

  const res = await forge(`/orgs/${ORG}/repos`, {
    method: "POST",
    body: JSON.stringify({ name: app, private: true, auto_init: false }),
  });
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`crear repo en el forge falló (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return { already: false, cloneUrl };
}

/**
 * Asegura un push-mirror del repo del forge → GitHub (backup off-site). El
 * patrón del ecosistema: primary en git-mishi, GitHub como mirror sync_on_commit.
 * Best-effort: necesita un PAT de GitHub con push (`github-mirror-pat`); si no
 * está o el mirror ya existe, no falla el nacimiento. Devuelve un mensaje de
 * estado para que el llamador lo reporte.
 */
export async function ensureGithubMirror(app: string): Promise<string> {
  // ¿ya hay algún push-mirror configurado?
  const list = await forge(`/repos/${ORG}/${app}/push_mirrors`);
  if (list.status === 200) {
    const mirrors = (await list.json()) as unknown[];
    if (Array.isArray(mirrors) && mirrors.length > 0) return "mirror a GitHub ya configurado";
  }

  const pat = await run("mishi-secret", ["get", "github-mirror-pat"]);
  if (pat.code !== 0 || !pat.stdout) {
    return "mirror a GitHub omitido (falta secreto github-mirror-pat; configúralo luego con push_mirrors)";
  }

  const res = await forge(`/repos/${ORG}/${app}/push_mirrors`, {
    method: "POST",
    body: JSON.stringify({
      remote_address: `https://github.com/${ORG}/${app}.git`,
      remote_username: ORG,
      remote_password: pat.stdout.trim(),
      interval: "8h0m0s",
      sync_on_commit: true,
    }),
  });
  if (res.status === 200 || res.status === 201) return "mirror a GitHub creado (sync_on_commit)";
  const body = await res.text();
  return `mirror a GitHub no quedó (HTTP ${res.status}): ${body.slice(0, 200)}`;
}
