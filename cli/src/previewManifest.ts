// Parseo PURO del manifiesto `mke.preview.yaml` (Contrato 2). La app DECLARA
// como código qué necesita: nombres de secretos → resueltos por el lease del
// vault (Contrato 1); config NO-sensible → literal al env del pod. `mke preview`
// NUNCA acepta `--env` humano para esto.
//
// Formato soportado (subconjunto YAML deliberadamente chico — sin dependencia
// externa, en el estilo de `parseDotEnv` de @mishicomco/dev-receta):
//
//   app: mishi-bank
//   secretos:
//     - MISHI_BANK_SESSION_SECRET
//     - MISHI_BANK_GOOGLE_CLIENT
//   config:
//     IDENTITY_URL: http://identity-preview.dev.svc:3000

export interface PreviewManifest {
  app: string;
  secretos: string[];
  config: Record<string, string>;
}

/** manifiesto vacío (Contrato 2: "Archivo ausente ⇒ arranca sin secretos ni config extra"). */
export function manifiestoVacio(app: string): PreviewManifest {
  return { app, secretos: [], config: {} };
}

function despojarComentario(linea: string): string {
  // '#' fuera de comillas → comentario. No hay comillas en este formato chico,
  // así que basta con cortar en el primer '#'.
  const i = linea.indexOf("#");
  return i === -1 ? linea : linea.slice(0, i);
}

/**
 * Parsea el YAML restringido de `mke.preview.yaml`. Tolerante con líneas
 * vacías/comentarios; revienta con mensaje claro ante estructura inesperada
 * (mejor fallar ruidoso en `up` que arrancar un pod mal configurado).
 */
export function parsePreviewManifest(text: string, appEsperada?: string): PreviewManifest {
  const lineasCrudas = text.split(/\r?\n/);
  let app: string | undefined;
  const secretos: string[] = [];
  const config: Record<string, string> = {};
  let seccion: "secretos" | "config" | null = null;

  for (const cruda of lineasCrudas) {
    const sinComentario = despojarComentario(cruda).replace(/\s+$/, "");
    if (!sinComentario.trim()) continue;
    const indentado = /^\s/.test(sinComentario);

    if (!indentado) {
      // línea de nivel raíz: `clave:` o `clave: valor`
      const m = sinComentario.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) throw new Error(`mke.preview.yaml: línea inválida (nivel raíz): "${cruda}"`);
      const [, clave, valor] = m;
      if (clave === "app") {
        if (!valor.trim()) throw new Error("mke.preview.yaml: 'app' vacío");
        app = valor.trim();
        seccion = null;
      } else if (clave === "secretos") {
        seccion = "secretos";
      } else if (clave === "config") {
        seccion = "config";
      } else {
        throw new Error(`mke.preview.yaml: clave de nivel raíz desconocida "${clave}" (esperado: app|secretos|config)`);
      }
      continue;
    }

    // línea indentada: pertenece a la sección abierta
    const linea = sinComentario.trim();
    if (seccion === "secretos") {
      const m = linea.match(/^-\s*(\S.*)$/);
      if (!m) throw new Error(`mke.preview.yaml: item de 'secretos' inválido: "${cruda}" (esperado "- NOMBRE")`);
      secretos.push(m[1].trim());
    } else if (seccion === "config") {
      const i = linea.indexOf(":");
      if (i <= 0) throw new Error(`mke.preview.yaml: entrada de 'config' inválida: "${cruda}" (esperado "CLAVE: valor")`);
      const clave = linea.slice(0, i).trim();
      const valor = linea.slice(i + 1).trim();
      if (!clave) throw new Error(`mke.preview.yaml: clave vacía en 'config': "${cruda}"`);
      config[clave] = valor;
    } else {
      throw new Error(`mke.preview.yaml: línea indentada fuera de sección: "${cruda}"`);
    }
  }

  // `app:` es OPCIONAL (el CLI ya la sabe por el argumento; el template no lo
  // emite). Si está, actúa de sanity check contra la app esperada.
  if (app && appEsperada && app !== appEsperada) {
    throw new Error(`mke.preview.yaml: 'app: ${app}' no coincide con la app esperada '${appEsperada}'`);
  }
  const appFinal = app ?? appEsperada;
  if (!appFinal) throw new Error("mke.preview.yaml: falta 'app' (y no se pasó app esperada)");
  return { app: appFinal, secretos, config };
}
