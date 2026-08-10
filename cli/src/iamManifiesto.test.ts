import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIamManifiesto, iamManifiestoTieneCatalogo, manifiestoIamVacio } from "./iamManifiesto.js";

// Protege la FRONTERA de autorización: este parseo es lo único entre el archivo
// del repo y `POST /v1/declarar`. Lo que no aparece en la declaración se
// TOMBSTONEA en iam-mishi (deja de conceder), así que un parseo silenciosamente
// incompleto = accesos perdidos en producción. Todo lo raro debe REVENTAR.

test("parseIamManifiesto: el ejemplo canónico completo", () => {
  const texto = `# mke.iam.yaml — catálogo de autorización de esta app
app: llego

permisos:
  - llego.ordenes.ver: Ver las órdenes del portal
  - llego.ordenes.crear      # sin descripción
  - llego.admin.acceso: Entrar a administración

roles:
  admin:
    - llego.*
  proveedor:
    - llego.ordenes.ver
    - llego.ordenes.crear
`;
  const m = parseIamManifiesto(texto);
  assert.equal(m.app, "llego");
  assert.deepEqual(m.permisos, [
    { nombre: "llego.ordenes.ver", descripcion: "Ver las órdenes del portal" },
    { nombre: "llego.ordenes.crear" },
    { nombre: "llego.admin.acceso", descripcion: "Entrar a administración" },
  ]);
  assert.deepEqual(m.roles, [
    { nombre: "admin", permisos: ["llego.*"] },
    { nombre: "proveedor", permisos: ["llego.ordenes.ver", "llego.ordenes.crear"] },
  ]);
});

test("parseIamManifiesto: 'app' opcional (la pone el deploy) y sanity check si difiere", () => {
  const m = parseIamManifiesto("permisos:\n  - x.y.z\n", "mi-app");
  assert.equal(m.app, "mi-app");
  assert.throws(() => parseIamManifiesto("app: otra\n", "mi-app"), /no coincide/);
});

test("parseIamManifiesto: archivo de puros comentarios ⇒ catálogo vacío (no se declara)", () => {
  const m = parseIamManifiesto("# nada acá\n\n# ni acá\n", "mi-app");
  assert.equal(iamManifiestoTieneCatalogo(m), false);
  assert.equal(iamManifiestoTieneCatalogo(manifiestoIamVacio("mi-app")), false);
  assert.equal(iamManifiestoTieneCatalogo(parseIamManifiesto("permisos:\n  - a.b.c\n", "x")), true);
});

test("parseIamManifiesto: secciones declaradas pero vacías ⇒ vacío, sin reventar", () => {
  const m = parseIamManifiesto("permisos:\nroles:\n", "x");
  assert.deepEqual(m.permisos, []);
  assert.deepEqual(m.roles, []);
});

test("parseIamManifiesto: clave raíz desconocida → revienta", () => {
  assert.throws(() => parseIamManifiesto("permisoss:\n  - a.b.c\n", "x"), /clave de nivel raíz desconocida/);
});

test("parseIamManifiesto: item de permisos sin '-' → revienta (no se traga en silencio)", () => {
  assert.throws(() => parseIamManifiesto("permisos:\n  a.b.c\n", "x"), /item de 'permisos' inválido/);
});

test("parseIamManifiesto: rol sin permisos → revienta (un rol vacío no concede nada)", () => {
  assert.throws(() => parseIamManifiesto("roles:\n  admin:\n", "x"), /no lista ningún permiso/);
});

test("parseIamManifiesto: patrones en la misma línea del rol → revienta", () => {
  assert.throws(() => parseIamManifiesto("roles:\n  admin: x.*\n", "x"), /en líneas "- patron" debajo/);
});

test("parseIamManifiesto: patrón huérfano (sin rol dueño) → revienta", () => {
  assert.throws(() => parseIamManifiesto("roles:\n  - x.*\n", "x"), /sin rol dueño/);
});

test("parseIamManifiesto: duplicados (permiso o rol) → revientan", () => {
  assert.throws(() => parseIamManifiesto("permisos:\n  - a.b.c\n  - a.b.c\n", "x"), /permiso duplicado/);
  assert.throws(() => parseIamManifiesto("roles:\n  admin:\n    - a.*\n  admin:\n    - b.*\n", "x"), /rol duplicado/);
});

test("parseIamManifiesto: línea indentada fuera de sección → revienta", () => {
  assert.throws(() => parseIamManifiesto("app: x\n  - a.b.c\n", "x"), /fuera de sección/);
});

test("parseIamManifiesto: el patrón debe ir más indentado que su rol", () => {
  assert.throws(() => parseIamManifiesto("roles:\n    admin:\n  - a.*\n", "x"), /MÁS indentado/);
});
