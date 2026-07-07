// `mke rama up/down/ls` — FACHADA DEPRECADA sobre `mke dev` (unificación FIRMADA
// por Santi, 2026-07-06). Ya NO existen dos mecanismos de pods de rama: el ÚNICO
// es el "pod de ITERACIÓN" DURADERO de `mke dev` (vite dev HMR + tsx watch sobre
// un clone del repo; cambiar de rama = git dentro del pod). El viejo "pod de rama"
// EFÍMERO (front estático + caddy, una FOTO) MURIÓ como concepto.
//
//   mke rama up   <app> <rama>  →  mke dev up <app> <rama> --live
//   mke rama down <app> [<rama>] →  mke dev down <app>
//   mke rama ls   [<app>]        →  mke dev ls [<app>]
//
// Se conserva el verbo para no romper a quien lo tenga en el dedo; cada llamada
// imprime una línea de deprecación (a stderr, para no ensuciar el --json de
// Studio) y delega en `dev`. La receta estática `@mishicomco/rama-receta` NO se
// borra (Mishi Studio la vendoriza hasta migrar): ver su DEPRECATED.md.

import { devUp, devDown, devLs } from "./dev.js";
import type { DevUpOpts } from "./dev.js";
import { warn } from "./sh.js";

export interface RamaUpOpts {
  json?: boolean;
  dryRun?: boolean;
  sinDns?: boolean;
  repoUrl?: string;
}

export interface RamaDownOpts {
  json?: boolean;
  sinDns?: boolean;
}

export interface RamaLsOpts {
  json?: boolean;
}

/** una sola vez por invocación: avisa (a stderr) que `rama` es fachada de `dev`. */
function avisoDeprecacion(equivalente: string): void {
  console.error(warn(`\`mke rama\` está DEPRECADO — es una fachada de \`mke dev\`. Usá: ${equivalente}`));
}

/** `mke rama up` → `mke dev up <app> <rama> --live` (mismo pod de iteración). */
export async function ramaUp(app: string, rama: string, imagesDir: string, opts: RamaUpOpts): Promise<void> {
  avisoDeprecacion(`mke dev up ${app} ${rama} --live`);
  const devOpts: DevUpOpts = {
    json: opts.json,
    dryRun: opts.dryRun,
    sinDns: opts.sinDns,
    repoUrl: opts.repoUrl,
    live: true,
  };
  await devUp(app, rama, imagesDir, devOpts);
}

/** `mke rama down` → `mke dev down <app>` (el pod es por-app, no por-rama). */
export async function ramaDown(app: string, _rama: string, opts: RamaDownOpts): Promise<void> {
  avisoDeprecacion(`mke dev down ${app}`);
  await devDown(app, { json: opts.json, sinDns: opts.sinDns });
}

/** `mke rama ls` → `mke dev ls`. */
export async function ramaLs(app: string | undefined, opts: RamaLsOpts): Promise<void> {
  avisoDeprecacion(`mke dev ls${app ? ` ${app}` : ""}`);
  await devLs(app, { json: opts.json });
}

// ─── helper conservado (lo importa rama.test.ts) ─────────────────────────────

export function edadDesde(ts: string | undefined, ahora = Date.now()): string {
  if (!ts) return "?";
  const ms = ahora - new Date(ts).getTime();
  if (Number.isNaN(ms) || ms < 0) return "?";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
