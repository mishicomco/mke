import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revocarSiHayLease, leerManifiestoPreview } from "./preview.js";

// Protege dos costuras propias de `mke preview`:
//  1. revocarSiHayLease: el "buscar leaseId → revoke" IDEMPOTENTE de `preview
//     down` / `limpiar`. Sin lease (o modo degradado `sin-lease`) es no-op.
//  2. leerManifiestoPreview: lee mke.preview.yaml del WORKTREE de la rama
//     (Contrato 2) y NO revienta si el archivo no existe (lista vacía).

test("revocarSiHayLease: sin leaseId (bundle ya bajado) → no-op, NO llama a revocar", async () => {
  let llamadas = 0;
  const r = await revocarSiHayLease(null, async (id) => {
    llamadas++;
    return { leaseId: id, estado: "revocado" };
  });
  assert.deepEqual(r, { revocado: false, leaseId: null });
  assert.equal(llamadas, 0);
});

test("revocarSiHayLease: leaseId 'sin-lease' (modo degradado) → no-op", async () => {
  let llamadas = 0;
  const r = await revocarSiHayLease("sin-lease", async (id) => {
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

test("leerManifiestoPreview: parsea mke.preview.yaml del checkout de la rama", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mke-preview-"));
  try {
    await writeFile(
      join(dir, "mke.preview.yaml"),
      "app: mishi-bank\nsecretos:\n  - MISHI_BANK_SESSION_SECRET\nconfig:\n  IDENTITY_URL: http://identity-preview.dev.svc:3000\n",
    );
    const m = await leerManifiestoPreview("mishi-bank", dir);
    assert.equal(m.app, "mishi-bank");
    assert.deepEqual(m.secretos, ["MISHI_BANK_SESSION_SECRET"]);
    assert.deepEqual(m.config, { IDENTITY_URL: "http://identity-preview.dev.svc:3000" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("leerManifiestoPreview: archivo AUSENTE → manifiesto vacío, no revienta (Contrato 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mke-preview-vacio-"));
  try {
    const m = await leerManifiestoPreview("polla", dir);
    assert.deepEqual(m, { app: "polla", secretos: [], config: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
