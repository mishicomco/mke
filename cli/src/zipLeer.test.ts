// Qué protege: `zipLeer` es un parser de formato binario escrito a mano (Node
// no trae unzip y el pc gamer no tiene el binario). Si se equivoca en un offset
// devuelve basura silenciosa en vez de fallar, y `mke ci logs` — la herramienta
// que uno usa JUSTO cuando algo ya salió mal — mentiría.

import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { leerZip } from "./zipLeer.js";

/** Arma un ZIP mínimo (sin ZIP64, sin cifrado) con las entradas dadas. */
function armarZip(entradas: Array<{ nombre: string; datos: Buffer; deflate?: boolean }>): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, "utf8");
    const cuerpo = e.deflate ? deflateRawSync(e.datos) : e.datos;
    const metodo = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(cuerpo.length, 18);
    local.writeUInt32LE(e.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    locales.push(local, nombre, cuerpo);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(cuerpo.length, 20);
    central.writeUInt32LE(e.datos.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre);

    offset += 30 + nombre.length + cuerpo.length;
  }

  const cd = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entradas.length, 8);
  eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, cd, eocd]);
}

test("lee entradas store (método 0) y deflate (método 8)", () => {
  const zip = armarZip([
    { nombre: "Deploy-1.log", datos: Buffer.from("línea uno\nlínea dos\n", "utf8"), deflate: true },
    { nombre: "Quality-1.MISSING", datos: Buffer.from("job has not been executed yet", "utf8") },
  ]);
  const entradas = leerZip(zip);
  assert.deepEqual(entradas.map((e) => e.nombre), ["Deploy-1.log", "Quality-1.MISSING"]);
  assert.equal(entradas[0].contenido.toString("utf8"), "línea uno\nlínea dos\n");
  assert.equal(entradas[1].contenido.toString("utf8"), "job has not been executed yet");
});

test("ignora las entradas de directorio", () => {
  const zip = armarZip([
    { nombre: "carpeta/", datos: Buffer.alloc(0) },
    { nombre: "carpeta/a.log", datos: Buffer.from("x") },
  ]);
  assert.deepEqual(leerZip(zip).map((e) => e.nombre), ["carpeta/a.log"]);
});

test("un buffer que no es ZIP revienta con un mensaje claro, no con basura", () => {
  assert.throws(() => leerZip(Buffer.from("esto no es un zip para nada nada")), /no parece un ZIP/);
});
