import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revocarSiHayLease, leerManifiestoFeature } from "./feature.js";

// Protege dos costuras propias de `mke feature`:
//  1. revocarSiHayLease: el "buscar leaseId → revoke" IDEMPOTENTE que usa
//     `feature down` y que el workflow de teardown del Contrato 2 encapsula.
//  2. leerManifiestoFeature: lee mke.feature.yaml del checkout local de la app
//     (Contrato 2) y NO revienta si el archivo no existe (regla explícita del
//     contrato: "Archivo ausente ⇒ el feature-pod arranca sin secretos ni
//     config extra... No es error").

test("revocarSiHayLease: sin leaseId (bundle ya bajado) → no-op, NO llama a revocar", async () => {
  let llamadas = 0;
  const r = await revocarSiHayLease(null, async (id) => {
    llamadas++;
    return { leaseId: id, estado: "revocado" };
  });
  assert.deepEqual(r, { revocado: false, leaseId: null });
  assert.equal(llamadas, 0);
});

test("revocarSiHayLease: con leaseId → llama a revocar EXACTAMENTE una vez con ese id", async () => {
  const vistos: string[] = [];
  const r = await revocarSiHayLease("lease-1", async (id) => {
    vistos.push(id);
    return { leaseId: id, estado: "revocado" };
  });
  assert.deepEqual(r, { revocado: true, leaseId: "lease-1" });
  assert.deepEqual(vistos, ["lease-1"]);
});

test("revocarSiHayLease: idempotente — llamarlo dos veces con el mismo id no falla ni duplica efectos raros", async () => {
  let llamadas = 0;
  const revocar = async (id: string) => { llamadas++; return { leaseId: id, estado: "revocado" }; };
  await revocarSiHayLease("lease-1", revocar);
  await revocarSiHayLease("lease-1", revocar); // ya revocado del lado del vault: sigue siendo 200 (mock simple)
  assert.equal(llamadas, 2, "cada down llama revoke una vez; la idempotencia real la garantiza el vault");
});

test("leerManifiestoFeature: parsea mke.feature.yaml del checkout de la app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mke-feature-"));
  try {
    await writeFile(
      join(dir, "mke.feature.yaml"),
      "app: mishi-bank\nsecretos:\n  - MISHI_BANK_SESSION_SECRET\nconfig:\n  IDENTITY_URL: http://identity-preview.dev.svc:3000\n",
    );
    const m = await leerManifiestoFeature("mishi-bank", dir);
    assert.equal(m.app, "mishi-bank");
    assert.deepEqual(m.secretos, ["MISHI_BANK_SESSION_SECRET"]);
    assert.deepEqual(m.config, { IDENTITY_URL: "http://identity-preview.dev.svc:3000" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("leerManifiestoFeature: archivo AUSENTE → manifiesto vacío, no revienta (Contrato 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mke-feature-vacio-"));
  try {
    const m = await leerManifiestoFeature("polla", dir);
    assert.deepEqual(m, { app: "polla", secretos: [], config: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
