import { test } from "node:test";
import assert from "node:assert/strict";
import { crearLease, revocarLease, renovarLease, obtenerLease, type FetchLike } from "./vaultLease.js";

// Protege: la COMPOSICIÓN del request de lease contra el Contrato 1 CONGELADO
// (método, path, headers Bearer, body exacto) — sin red real (el vault puede no
// estar arriba). Un método/path/body mal armado rompe la integración en Ola 2
// en silencio si no está cubierto acá.

function mockFetch(respuesta: { status: number; body: unknown }): { calls: { url: string; init?: RequestInit }[]; fetchImpl: FetchLike } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: respuesta.status >= 200 && respuesta.status < 300,
      status: respuesta.status,
      json: async () => respuesta.body,
      text: async () => JSON.stringify(respuesta.body),
    };
  };
  return { calls, fetchImpl };
}

test("crearLease: POST /v1/lease con ns/rama/secretos/ttlSegundos y Bearer del emisor", async () => {
  const { calls, fetchImpl } = mockFetch({
    status: 200,
    body: { leaseId: "l1", token: "tok", ns: "mishi-bank", rama: "feat-x", expiraEn: "2026-07-11T00:00:00Z" },
  });
  const r = await crearLease(
    { vaultUrl: "https://vault.internal", emisorToken: "emisor-tok", fetchImpl },
    { ns: "mishi-bank", rama: "feat-x", secretos: ["MISHI_BANK_SESSION_SECRET"], ttlSegundos: 3600 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://vault.internal/v1/lease");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer emisor-tok");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { ns: "mishi-bank", rama: "feat-x", secretos: ["MISHI_BANK_SESSION_SECRET"], ttlSegundos: 3600 });
  assert.deepEqual(r, { leaseId: "l1", token: "tok", ns: "mishi-bank", rama: "feat-x", expiraEn: "2026-07-11T00:00:00Z" });
});

test("crearLease: secretos SIEMPRE viaja (fail-closed): lista vacía → body con secretos:[]", async () => {
  const { calls, fetchImpl } = mockFetch({ status: 200, body: { leaseId: "l1", token: "t", ns: "a", rama: "b", expiraEn: "x" } });
  await crearLease({ vaultUrl: "https://v", emisorToken: "e", fetchImpl }, { ns: "a", rama: "b", secretos: [] });
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { ns: "a", rama: "b", secretos: [] });
});

test("crearLease: HTTP no-2xx revienta con el status y el cuerpo", async () => {
  const { fetchImpl } = mockFetch({ status: 403, body: { error: "prohibido" } });
  await assert.rejects(
    crearLease({ vaultUrl: "https://v", emisorToken: "e", fetchImpl }, { ns: "a", rama: "b", secretos: [] }),
    /HTTP 403/,
  );
});

test("revocarLease: POST /v1/lease/:id/revoke (path-encoded) con Bearer, sin body", async () => {
  const { calls, fetchImpl } = mockFetch({ status: 200, body: { leaseId: "l1", estado: "revocado" } });
  const r = await revocarLease({ vaultUrl: "https://v", emisorToken: "e", fetchImpl }, "lease/con espacio");
  assert.equal(calls[0].url, "https://v/v1/lease/lease%2Fcon%20espacio/revoke");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, undefined);
  assert.deepEqual(r, { leaseId: "l1", estado: "revocado" });
});

test("revocarLease: idempotente — revocar de nuevo sigue devolviendo 200", async () => {
  const { fetchImpl } = mockFetch({ status: 200, body: { leaseId: "l1", estado: "revocado" } });
  const opts = { vaultUrl: "https://v", emisorToken: "e", fetchImpl };
  const r1 = await revocarLease(opts, "l1");
  const r2 = await revocarLease(opts, "l1");
  assert.deepEqual(r1, r2);
});

test("renovarLease: POST /v1/lease/:id/renovar con ttlSegundos opcional en el body", async () => {
  const { calls, fetchImpl } = mockFetch({ status: 200, body: { leaseId: "l1", expiraEn: "2026-07-12T00:00:00Z" } });
  await renovarLease({ vaultUrl: "https://v", emisorToken: "e", fetchImpl }, "l1", 7200);
  assert.equal(calls[0].url, "https://v/v1/lease/l1/renovar");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { ttlSegundos: 7200 });
});

test("obtenerLease: GET /v1/lease/:id con Bearer", async () => {
  const { calls, fetchImpl } = mockFetch({ status: 200, body: { leaseId: "l1", estado: "activo", ns: "a", rama: "b", expiraEn: "x" } });
  const r = await obtenerLease({ vaultUrl: "https://v", emisorToken: "e", fetchImpl }, "l1");
  assert.equal(calls[0].url, "https://v/v1/lease/l1");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(r.estado, "activo");
});
