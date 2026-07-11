// Parseo PURO del manifiesto `mke.feature.yaml` (Contrato 2, CONGELADO
// 2026-07-09: /home/santi/.claude/jobs/a476b7a4/tmp/CONTRATO-2-manifiesto-app.md).
// La app DECLARA como código qué necesita (nombres de secretos → resueltos por
// lease del vault; config NO-sensible → literal al env). `mke feature` NUNCA
// más acepta `--env` para esto.
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

export interface FeatureManifest {
  app: string;
  secretos: string[];
  config: Record<string, string>;
}

/** manifiesto vacío (Contrato 2: "Archivo ausente ⇒ arranca sin secretos ni config extra"). */
export function manifiestoVacio(app: string): FeatureManifest {
  return { app, secretos: [], config: {} };
}

function despojarComentario(linea: string): string {
  // '#' fuera de comillas → comentario. No hay comillas en este formato chico,
  // así que basta con cortar en el primer '#'.
  const i = linea.indexOf("#");
  return i === -1 ? linea : linea.slice(0, i);
}

/**
 * Parsea el YAML restringido de `mke.feature.yaml`. Tolerante con líneas
 * vacías/comentarios; revienta con mensaje claro ante estructura inesperada
 * (mejor fallar ruidoso en `up` que arrancar un pod mal configurado).
 */
export function parseFeatureManifest(text: string): FeatureManifest {
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
      if (!m) throw new Error(`mke.feature.yaml: línea inválida (nivel raíz): "${cruda}"`);
      const [, clave, valor] = m;
      if (clave === "app") {
        if (!valor.trim()) throw new Error("mke.feature.yaml: 'app' vacío");
        app = valor.trim();
        seccion = null;
      } else if (clave === "secretos") {
        seccion = "secretos";
      } else if (clave === "config") {
        seccion = "config";
      } else {
        throw new Error(`mke.feature.yaml: clave de nivel raíz desconocida "${clave}" (esperado: app|secretos|config)`);
      }
      continue;
    }

    // línea indentada: pertenece a la sección abierta
    const linea = sinComentario.trim();
    if (seccion === "secretos") {
      const m = linea.match(/^-\s*(\S.*)$/);
      if (!m) throw new Error(`mke.feature.yaml: item de 'secretos' inválido: "${cruda}" (esperado "- NOMBRE")`);
      secretos.push(m[1].trim());
    } else if (seccion === "config") {
      const i = linea.indexOf(":");
      if (i <= 0) throw new Error(`mke.feature.yaml: entrada de 'config' inválida: "${cruda}" (esperado "CLAVE: valor")`);
      const clave = linea.slice(0, i).trim();
      const valor = linea.slice(i + 1).trim();
      if (!clave) throw new Error(`mke.feature.yaml: clave vacía en 'config': "${cruda}"`);
      config[clave] = valor;
    } else {
      throw new Error(`mke.feature.yaml: línea indentada fuera de sección: "${cruda}"`);
    }
  }

  if (!app) throw new Error("mke.feature.yaml: falta 'app'");
  return { app, secretos, config };
}
