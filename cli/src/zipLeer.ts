// Lector de ZIP mínimo y SIN dependencias — el CLI no puede asumir `unzip`
// instalado (el pc gamer no lo tiene: `mke ci logs` murió con "no pude extraer
// el ZIP" la primera vez que se probó). Node trae zlib pero no un unzip, así
// que se parsea el directorio central a mano.
//
// Alcance deliberadamente chico: lo que produce Forgejo para los logs de un run
// — entradas store (método 0) y deflate (método 8), sin cifrado ni ZIP64. Ante
// cualquier otra cosa, revienta con un mensaje claro en vez de devolver basura.

import { inflateRawSync } from "node:zlib";

const FIRMA_EOCD = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

export interface EntradaZip {
  nombre: string;
  contenido: Buffer;
}

/** Offset del End Of Central Directory (se busca desde el final; hay comentario opcional). */
function buscarEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === FIRMA_EOCD) return i;
  }
  throw new Error("no parece un ZIP (no encontré el End Of Central Directory)");
}

/** Extrae todas las entradas de archivo de un ZIP en memoria. Ignora directorios. */
export function leerZip(buf: Buffer): EntradaZip[] {
  const eocd = buscarEocd(buf);
  const cantidad = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entradas: EntradaZip[] = [];
  for (let i = 0; i < cantidad; i++) {
    if (buf.readUInt32LE(p) !== FIRMA_CENTRAL) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.subarray(p + 46, p + 46 + largoNombre).toString("utf8");
    p += 46 + largoNombre + largoExtra + largoComentario;

    if (nombre.endsWith("/")) continue; // directorio
    if (buf.readUInt32LE(offsetLocal) !== FIRMA_LOCAL) {
      throw new Error(`entrada corrupta en el ZIP: ${nombre}`);
    }
    const datos = offsetLocal + 30 + buf.readUInt16LE(offsetLocal + 26) + buf.readUInt16LE(offsetLocal + 28);
    const crudo = buf.subarray(datos, datos + comprimido);

    if (metodo === 0) entradas.push({ nombre, contenido: Buffer.from(crudo) });
    else if (metodo === 8) entradas.push({ nombre, contenido: inflateRawSync(crudo) });
    else throw new Error(`método de compresión no soportado (${metodo}) en ${nombre}`);
  }
  return entradas;
}
