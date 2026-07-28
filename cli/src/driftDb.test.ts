// Qué protege: el drift-check es lo único que detecta una BD tocada por fuera
// de las migraciones (el migrador de drizzle usa una marca de agua y puede tapar
// migraciones sin aplicar EN SILENCIO). Los dos riesgos reales que se testean:
// (1) el hash debe IGNORAR las anotaciones del lint agregadas después, y
// (2) un mismatch/hueco debe reportarse, no pasar de largo.

import test from "node:test";
import assert from "node:assert/strict";

import { compararDrift, parsearFilasDb, quitarAnotaciones, sha256 } from "./driftDb.js";

test("quitarAnotaciones borra `-- contract:` y `-- espejo:` y nada más", () => {
  const sql = "CREATE TABLE a ();\n-- contract: razón\n  -- espejo: ok\n-- comentario normal\n";
  assert.equal(quitarAnotaciones(sql), "CREATE TABLE a ();\n-- comentario normal\n");
});

test("quitarAnotaciones respeta la ausencia de salto final (como `sed`)", () => {
  assert.equal(quitarAnotaciones("SELECT 1;"), "SELECT 1;");
  assert.equal(quitarAnotaciones("SELECT 1;\n"), "SELECT 1;\n");
});

test("una anotación agregada DESPUÉS no cuenta como drift", () => {
  const original = "DROP TABLE a;\n";
  const anotado = "DROP TABLE a; -- contract: ya nadie la usa\n";
  // la anotación va en la MISMA línea del statement: ese caso sí cambia el hash
  // sin-anotaciones, y por eso se acepta también el hash del archivo COMPLETO.
  const repo = [{ when: "1", tag: "0001", hash: sha256(quitarAnotaciones(anotado)), hashFull: sha256(anotado) }];
  assert.deepEqual(compararDrift(repo, [{ createdAt: "1", hash: sha256(anotado) }]), []);
  // y con la anotación en línea propia, el hash sin-anotaciones es el original:
  const enLineaPropia = `${original}-- contract: ya nadie la usa\n`;
  const repo2 = [{ when: "1", tag: "0001", hash: sha256(quitarAnotaciones(enLineaPropia)), hashFull: sha256(enLineaPropia) }];
  assert.deepEqual(compararDrift(repo2, [{ createdAt: "1", hash: sha256(original) }]), []);
});

test("conteo distinto y hash distinto son drift", () => {
  const repo = [{ when: "1", tag: "0001", hash: "aaa", hashFull: "AAA" }];
  assert.equal(compararDrift(repo, []).length, 1);
  assert.equal(compararDrift(repo, [{ createdAt: "1", hash: "zzz" }]).length, 1);
  assert.equal(compararDrift(repo, [{ createdAt: "9", hash: "aaa" }]).length, 1);
  assert.deepEqual(compararDrift(repo, [{ createdAt: "1", hash: "AAA" }]), []);
});

test("parsearFilasDb parte por el PRIMER pipe (el hash no lo lleva)", () => {
  assert.deepEqual(parsearFilasDb("1753000000000|abc123\n\n1753000000001|def456\n"), [
    { createdAt: "1753000000000", hash: "abc123" },
    { createdAt: "1753000000001", hash: "def456" },
  ]);
});
