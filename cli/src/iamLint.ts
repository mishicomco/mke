// `mke iam lint` — valida `mke.iam.yaml` en el DEV LOOP, sin cluster ni red.
// Antes el formato `<app>.<recurso>.<verbo>` solo se ejercía al correr el test
// (examenEscalada) o al deployar (iam-mishi rechaza con 422 y aborta). Este verbo
// da la misma señal AL TIRO, local. REUSA el parser dueño de la sintaxis
// (`iamManifiesto.ts`) — no duplica la regex: los mensajes son los mismos que ve
// el deploy (parseo estructural + advertencias de escalada).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseIamManifiesto, advertenciasIam, iamManifiestoTieneCatalogo } from "./iamManifiesto.js";
import { IAM_MANIFIESTO } from "./declararIam.js";
import { ok, bad, warn, dim } from "./sh.js";

export interface IamLintOpts {
  /** raíz del repo de la app (default: cwd). */
  dir?: string;
}

/**
 * Lintea el `mke.iam.yaml` de un repo. Exit 0 = limpio (o sin catálogo que
 * publicar); exit 1 = el deploy abortaría (parseo inválido o escalada). No toca
 * cluster ni red — es puro dev-loop.
 */
export async function iamLint(opts: IamLintOpts = {}): Promise<void> {
  const dir = opts.dir ?? process.cwd();
  const ruta = join(dir, IAM_MANIFIESTO);

  let texto: string;
  try {
    texto = await readFile(ruta, "utf8");
  } catch {
    // Sin `mke.iam.yaml` no estás parado en un repo de app mishicomco (o lo
    // corriste desde el cwd equivocado — p.ej. la raíz del monorepo o mke/cli).
    // Antes esto era un WARN silencioso que corría contra el cwd por accidente;
    // ahora es error accionable (exit 1) para no dar un verde engañoso.
    console.log(bad(`no estás en un repo de app mishicomco: no encontré ${IAM_MANIFIESTO} en ${dir}`));
    console.log(dim(`  corré \`mke iam lint\` desde la raíz del repo de la app, o pasá \`--dir <repo>\``));
    process.exitCode = 1;
    return;
  }

  let manifiesto;
  try {
    manifiesto = parseIamManifiesto(texto);
  } catch (e) {
    // El parser lanza con mensaje accionable ya prefijado "mke.iam.yaml: …"
    // (incluye la línea cruda y qué se esperaba). Mismo mensaje que el deploy.
    console.log(bad(e instanceof Error ? e.message : String(e)));
    console.log(dim(`  (el deploy abortaría acá: un catálogo mutilado tombstonea permisos vivos)`));
    process.exitCode = 1;
    return;
  }

  if (!iamManifiestoTieneCatalogo(manifiesto)) {
    console.log(warn(`${IAM_MANIFIESTO}: sin permisos ni roles — no se declara nada (¿es a propósito?)`));
    return;
  }

  // Advertencias de escalada: iam-mishi las rechaza con 422 y ABORTA el deploy,
  // así que para el dev loop son errores duros (exit 1), no ruido.
  const avisos = advertenciasIam(manifiesto);
  if (avisos.length) {
    console.log(bad(`${IAM_MANIFIESTO}: ${avisos.length} problema(s) que abortarían el deploy:`));
    for (const a of avisos) console.log(`  ${bad("✗")} ${a}`);
    process.exitCode = 1;
    return;
  }

  console.log(ok(`${IAM_MANIFIESTO} válido: ${manifiesto.permisos.length} permiso(s), ${manifiesto.roles.length} rol(es) para "${manifiesto.app}"`));
  console.log(dim("  (los QUIÉN-tiene-qué se otorgan con `iam-mishi grant`, no acá)"));
}
