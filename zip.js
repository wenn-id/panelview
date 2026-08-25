/* PanelView — ZIP reader module. MIT. */

export const MAX_INFLATED_ENTRY_BYTES = 512 * 1024 * 1024;
export const ZIP64_UNSUPPORTED = "ZIP64 archives are not supported yet";

export async function readZip(blob, maxInflatedBytes = MAX_INFLATED_ENTRY_BYTES) {
  const tailSize = Math.min(blob.size, 65558);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory)");
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) throw new Error(ZIP64_UNSUPPORTED);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error(ZIP64_UNSUPPORTED);
  }
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  const nameDecoder = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const uncompSize = cd.getUint32(p + 24, true);
    const crc = cd.getUint32(p + 16, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(ZIP64_UNSUPPORTED);
    }
    const name = nameDecoder.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    if (!name.endsWith("/")) entries.push({ name, method, compSize, uncompSize, crc, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  async function extract(entry) {
    const lh = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("Bad local header: " + entry.name);
    if (lh.getUint32(18, true) === 0xffffffff || lh.getUint32(22, true) === 0xffffffff) {
      throw new Error(ZIP64_UNSUPPORTED);
    }
    const overLimit = "ZIP entry exceeds the " + maxInflatedBytes + "-byte inflation limit: " + entry.name;
    if (entry.uncompSize > maxInflatedBytes || lh.getUint32(22, true) > maxInflatedBytes) throw new Error(overLimit);
    const dataStart = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const comp = blob.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      let inflated = 0;
      let limitError = null;
      const limiter = new TransformStream({
        transform(chunk, controller) {
          inflated += chunk.byteLength;
          if (inflated > maxInflatedBytes) {
            limitError = new Error(overLimit);
            throw limitError;
          }
          controller.enqueue(chunk);
        },
      });
      try {
        return await new Response(comp.stream().pipeThrough(ds).pipeThrough(limiter)).blob();
      } catch (error) {
        if (limitError) throw limitError;
        throw error;
      }
    }
    throw new Error("Unsupported compression method " + entry.method + " for " + entry.name);
  }
  return { entries, extract };
}
