// Parseo PURO del manifiesto `mke.iam.yaml` — la DECLARACIÓN COMO CÓDIGO del
// catálogo de autorización de una app (permisos + roles), hermano de
// `mke.preview.yaml`. `mke deploy` lo lee y lo publica en iam-mishi
// (`POST /v1/declarar`) con el token de app, ANTES del rollout.
//
// Sin archivo ⇒ no se declara nada (las apps que aún declaran en runtime desde
// su código —camino legacy— siguen funcionando igual).
//
// Formato soportado (mismo subconjunto YAML chico de previewManifest.ts: sin
// dependencia externa, '#' corta comentario, dos niveles de indentación):
//
//   app: llego                        # opcional (sanity check contra la app del deploy)
//   permisos:
//     - llego.ordenes.ver: Ver las órdenes del portal   # descripción opcional
//     - llego.ordenes.crear
//   roles:
//     admin:
//       - llego.*
//     proveedor:
//       - llego.ordenes.ver
//   actores:                          # bindings SEMILLA (opcional)
//     - santi@x.com: admin
//
// El nombre del permiso y los patrones de rol NO se validan acá con la regex de
// iam-mishi (dueño del modelo): el manifiesto solo transporta. iam-mishi valida
// y rechaza con 400 — fallar allá es fallar en el dueño de la verdad.

export interface PermisoManifiesto {
  nombre: string;
  descripcion?: string;
}

export interface RolManifiesto {
  nombre: string;
  permisos: string[];
}

/** binding SEMILLA: quién arranca con qué rol de ESTA app (ámbito = la app).
 * Es la única parte del manifiesto que habla de QUIÉN; es aditiva (nunca revoca)
 * y solo puede citar roles declarados en el mismo archivo. */
export interface ActorManifiesto {
  principal: string;
  rol: string;
}

export interface IamManifiesto {
  app: string;
  permisos: PermisoManifiesto[];
  roles: RolManifiesto[];
  actores: ActorManifiesto[];
}

/** manifiesto vacío: declarar esto BORRARÍA el catálogo, así que `mke deploy`
 * trata "sin permisos ni roles" como "no hay nada que declarar" (no llama). */
export function manifiestoIamVacio(app: string): IamManifiesto {
  return { app, permisos: [], roles: [], actores: [] };
}

/** ¿hay algo real que publicar? (un archivo con puros comentarios ⇒ no). */
export function iamManifiestoTieneCatalogo(m: IamManifiesto): boolean {
  return m.permisos.length > 0 || m.roles.length > 0;
}

function despojarComentario(linea: string): string {
  const i = linea.indexOf("#");
  return i === -1 ? linea : linea.slice(0, i);
}

function sangria(linea: string): number {
  return linea.length - linea.replace(/^\s+/, "").length;
}

/**
 * Parsea el YAML restringido de `mke.iam.yaml`. Tolerante con líneas vacías y
 * comentarios; revienta con mensaje claro ante estructura inesperada (mejor
 * abortar el deploy que publicar un catálogo mutilado: lo que no aparece en la
 * declaración se TOMBSTONEA en iam-mishi y deja de conceder).
 */
export function parseIamManifiesto(text: string, appEsperada?: string): IamManifiesto {
  let app: string | undefined;
  const permisos: PermisoManifiesto[] = [];
  const roles: RolManifiesto[] = [];
  const actores: ActorManifiesto[] = [];
  let seccion: "permisos" | "roles" | "actores" | null = null;
  let rolActual: RolManifiesto | null = null;
  let sangriaRol: number | null = null;

  for (const cruda of text.split(/\r?\n/)) {
    const sinComentario = despojarComentario(cruda).replace(/\s+$/, "");
    if (!sinComentario.trim()) continue;
    const indentado = /^\s/.test(sinComentario);

    if (!indentado) {
      const m = sinComentario.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) throw new Error(`mke.iam.yaml: línea inválida (nivel raíz): "${cruda}"`);
      const [, clave, valor] = m;
      rolActual = null;
      sangriaRol = null;
      if (clave === "app") {
        if (!valor.trim()) throw new Error("mke.iam.yaml: 'app' vacío");
        app = valor.trim();
        seccion = null;
      } else if (clave === "permisos") {
        seccion = "permisos";
      } else if (clave === "roles") {
        seccion = "roles";
      } else if (clave === "actores") {
        seccion = "actores";
      } else {
        throw new Error(`mke.iam.yaml: clave de nivel raíz desconocida "${clave}" (esperado: app|permisos|roles|actores)`);
      }
      continue;
    }

    const linea = sinComentario.trim();

    if (seccion === "permisos") {
      const m = linea.match(/^-\s*(\S.*)$/);
      if (!m) throw new Error(`mke.iam.yaml: item de 'permisos' inválido: "${cruda}" (esperado "- app.recurso.verbo")`);
      const item = m[1].trim();
      const i = item.indexOf(":");
      if (i === -1) {
        permisos.push({ nombre: item });
      } else {
        const nombre = item.slice(0, i).trim();
        const descripcion = item.slice(i + 1).trim();
        if (!nombre) throw new Error(`mke.iam.yaml: permiso sin nombre: "${cruda}"`);
        permisos.push(descripcion ? { nombre, descripcion } : { nombre });
      }
      continue;
    }

    if (seccion === "actores") {
      const m = linea.match(/^-\s*(\S.*)$/);
      if (!m) throw new Error(`mke.iam.yaml: item de 'actores' inválido: "${cruda}" (esperado "- correo@dominio: rol")`);
      const item = m[1].trim();
      const i = item.indexOf(":");
      if (i <= 0) throw new Error(`mke.iam.yaml: actor sin rol: "${cruda}" (esperado "- correo@dominio: rol")`);
      const principal = item.slice(0, i).trim().toLowerCase();
      const rol = item.slice(i + 1).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal)) {
        throw new Error(`mke.iam.yaml: actor "${principal}" no es un correo (el principal del IAM es el email de la sesión Google)`);
      }
      if (!/^[a-z0-9-]+$/.test(rol)) throw new Error(`mke.iam.yaml: rol "${rol}" inválido para el actor ${principal}`);
      actores.push({ principal, rol });
      continue;
    }

    if (seccion === "roles") {
      const esItem = /^-\s*\S/.test(linea);
      if (!esItem) {
        // cabecera de rol: `nombre:` (nada más en la línea)
        const m = linea.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!m) throw new Error(`mke.iam.yaml: entrada de 'roles' inválida: "${cruda}" (esperado "nombre:" y debajo "- patron")`);
        if (m[2].trim()) {
          throw new Error(`mke.iam.yaml: el rol "${m[1]}" debe listar sus permisos en líneas "- patron" debajo, no en la misma línea: "${cruda}"`);
        }
        if (roles.some((r) => r.nombre === m[1])) throw new Error(`mke.iam.yaml: rol duplicado "${m[1]}"`);
        rolActual = { nombre: m[1], permisos: [] };
        roles.push(rolActual);
        sangriaRol = sangria(sinComentario);
        continue;
      }
      if (!rolActual) throw new Error(`mke.iam.yaml: patrón de permiso sin rol dueño: "${cruda}"`);
      if (sangriaRol !== null && sangria(sinComentario) <= sangriaRol) {
        throw new Error(`mke.iam.yaml: el patrón "${linea}" debe ir MÁS indentado que su rol "${rolActual.nombre}"`);
      }
      rolActual.permisos.push(linea.replace(/^-\s*/, "").trim());
      continue;
    }

    throw new Error(`mke.iam.yaml: línea indentada fuera de sección: "${cruda}"`);
  }

  if (app && appEsperada && app !== appEsperada) {
    throw new Error(`mke.iam.yaml: 'app: ${app}' no coincide con la app esperada '${appEsperada}'`);
  }
  const appFinal = app ?? appEsperada;
  if (!appFinal) throw new Error("mke.iam.yaml: falta 'app' (y no se pasó app esperada)");

  const vacio = roles.find((r) => r.permisos.length === 0);
  if (vacio) throw new Error(`mke.iam.yaml: el rol "${vacio.nombre}" no lista ningún permiso (un rol vacío no concede nada)`);

  const dup = permisos.map((p) => p.nombre).find((n, i, xs) => xs.indexOf(n) !== i);
  if (dup) throw new Error(`mke.iam.yaml: permiso duplicado "${dup}"`);

  // Un actor solo puede citar un rol DECLARADO en este mismo archivo: el
  // manifiesto de una app jamás siembra roles de otra app ni de `ecosistema`
  // (eso sería escalada desde el repo de la app).
  const huerfano = actores.find((a) => !roles.some((r) => r.nombre === a.rol));
  if (huerfano) {
    throw new Error(
      `mke.iam.yaml: el actor ${huerfano.principal} cita el rol "${huerfano.rol}", que no está declarado en 'roles:' de esta app`,
    );
  }

  return { app: appFinal, permisos, roles, actores };
}
