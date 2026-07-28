// Qué protege: la ley expand-contract, que ahora es la ÚNICA compuerta entre
// una migración destructiva y prod (no hay PRs en el ecosistema). Si estas
// aserciones se rompen, un DROP sin `-- contract:` puede llegar a la BD real.

import test from "node:test";
import assert from "node:assert/strict";

import { cargarTablasSensibles, dividirStatements, lintArchivo, revisarStatement } from "./lintMigraciones.js";

const SIN_SENSIBLES = new Set<string>();

test("divide por el statement-breakpoint de drizzle", () => {
  const sql = "CREATE TABLE a ();\n--> statement-breakpoint\nCREATE TABLE b ();";
  assert.equal(dividirStatements(sql).length, 2);
});

test("DROP TABLE sin escape hatch es issue", () => {
  const { issues, avisos } = revisarStatement("0001.sql", "DROP TABLE usuarios;", SIN_SENSIBLES);
  assert.equal(issues.length, 1);
  assert.equal(avisos.length, 0);
  assert.match(issues[0].mensaje, /DROP TABLE/);
});

test("DROP TABLE con `-- contract:` pasa como aviso, no como issue", () => {
  const { issues, avisos } = revisarStatement(
    "0001.sql",
    "DROP TABLE usuarios; -- contract: nadie la usa desde v3",
    SIN_SENSIBLES,
  );
  assert.equal(issues.length, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].razon, /nadie la usa desde v3/);
});

test("RENAME, TRUNCATE y cambio de tipo también son destructivos", () => {
  for (const sql of [
    'ALTER TABLE "a" RENAME TO "b";',
    "TRUNCATE tabla;",
    'ALTER TABLE "a" ALTER COLUMN "x" SET DATA TYPE integer;',
  ]) {
    assert.equal(revisarStatement("0002.sql", sql, SIN_SENSIBLES).issues.length, 1, sql);
  }
});

test("SET NOT NULL sin DEFAULT es issue; con DEFAULT pasa", () => {
  assert.equal(
    revisarStatement("0003.sql", 'ALTER TABLE "a" ALTER COLUMN "x" SET NOT NULL;', SIN_SENSIBLES).issues.length,
    1,
  );
  assert.equal(
    revisarStatement("0003.sql", 'ALTER TABLE "a" ALTER COLUMN "x" SET NOT NULL DEFAULT 0;', SIN_SENSIBLES).issues.length,
    0,
  );
});

test("CREATE TABLE nueva exige decisión de espejo (lista o `-- espejo: ok`)", () => {
  const sql = 'CREATE TABLE "secretos" ("id" text);';
  assert.equal(revisarStatement("0004.sql", sql, SIN_SENSIBLES).issues.length, 1);
  assert.equal(revisarStatement("0004.sql", sql, new Set(["secretos"])).issues.length, 0);
  assert.equal(
    revisarStatement("0004.sql", `${sql} -- espejo: ok`, SIN_SENSIBLES).issues.length,
    0,
  );
});

test("tablas-sensibles.txt ignora comentarios y líneas vacías", () => {
  const set = cargarTablasSensibles("# comentario\n\n usuarios \ntokens\n");
  assert.deepEqual([...set].sort(), ["tokens", "usuarios"]);
});

test("lintArchivo acumula issues de todos los statements", () => {
  const sql = 'DROP TABLE a;\n--> statement-breakpoint\nCREATE TABLE "b" ("id" text);';
  assert.equal(lintArchivo("0005.sql", sql, SIN_SENSIBLES).issues.length, 2);
});
