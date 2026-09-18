import yauzl from 'yauzl';

function stringAt(pool, index) {
    if (index === 0xffffffff || index >= pool.count) return null;
    const offset = pool.start + pool.offsets[index];
    const bytes = pool.bytes;
    if (offset < pool.start || offset >= pool.end) return null;
    if (pool.utf8) {
        let cursor = offset;
        const length = () => {
            if (cursor >= pool.end) return null;
            const first = bytes[cursor++];
            if (!(first & 0x80)) return first;
            if (cursor >= pool.end) return null;
            return ((first & 0x7f) << 8) | bytes[cursor++];
        };
        if (length() === null) return null; // UTF-16 length, unused
        const size = length();
        if (size === null || cursor + size > pool.end) return null;
        return bytes.toString('utf8', cursor, cursor + size);
    }
    let cursor = offset;
    if (cursor + 2 > pool.end) return null;
    let size = bytes.readUInt16LE(cursor);
    cursor += 2;
    if (size & 0x8000) {
        if (cursor + 2 > pool.end) return null;
        size = ((size & 0x7fff) << 16) | bytes.readUInt16LE(cursor);
        cursor += 2;
    }
    if (cursor + size * 2 > pool.end) return null;
    return bytes.toString('utf16le', cursor, cursor + size * 2);
}

/** Read the root manifest package attribute from Android binary XML or plain XML. */
export function packageNameFromManifest(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
    if (bytes.readUInt16LE(0) !== 0x0003) {
        const xml = bytes.toString('utf8');
        return /<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1] || null;
    }
    const limit = Math.min(bytes.readUInt32LE(4), bytes.length);
    let pool = null;
    for (let cursor = bytes.readUInt16LE(2); cursor + 8 <= limit;) {
        const type = bytes.readUInt16LE(cursor);
        const headerSize = bytes.readUInt16LE(cursor + 2);
        const size = bytes.readUInt32LE(cursor + 4);
        if (size < headerSize || cursor + size > limit) break;
        if (type === 0x0001 && headerSize >= 28) {
            const count = bytes.readUInt32LE(cursor + 8);
            const flags = bytes.readUInt32LE(cursor + 16);
            const stringsStart = bytes.readUInt32LE(cursor + 20);
            if (count <= 100000 && cursor + 28 + count * 4 <= cursor + size) {
                pool = {
                    bytes, count, utf8: Boolean(flags & 0x100),
                    offsets: Array.from({ length: count }, (_, i) => bytes.readUInt32LE(cursor + 28 + i * 4)),
                    start: cursor + stringsStart, end: cursor + size,
                };
            }
        } else if (type === 0x0102 && pool && headerSize >= 36) {
            const tag = stringAt(pool, bytes.readUInt32LE(cursor + 20));
            if (tag !== 'manifest') { cursor += size; continue; }
            const attrStart = bytes.readUInt16LE(cursor + 24);
            const attrSize = bytes.readUInt16LE(cursor + 26);
            const attrCount = bytes.readUInt16LE(cursor + 28);
            if (attrSize < 20 || cursor + 16 + attrStart + attrSize * attrCount > cursor + size) return null;
            for (let i = 0; i < attrCount; i++) {
                const attr = cursor + 16 + attrStart + i * attrSize;
                if (stringAt(pool, bytes.readUInt32LE(attr + 4)) !== 'package') continue;
                const raw = bytes.readUInt32LE(attr + 8);
                const typed = bytes.readUInt8(attr + 15) === 0x03 ? bytes.readUInt32LE(attr + 16) : 0xffffffff;
                return stringAt(pool, raw !== 0xffffffff ? raw : typed);
            }
            return null;
        }
        cursor += size;
    }
    return null;
}

/** Return null for malformed APKs so scanning can still show legacy artifacts. */
export function readApkPackageName(path) {
    return new Promise(resolve => {
        yauzl.open(path, { lazyEntries: true }, (error, zip) => {
            if (error || !zip) return resolve(null);
            let done = false;
            const finish = value => {
                if (done) return;
                done = true;
                zip.close();
                resolve(value);
            };
            zip.on('error', () => finish(null));
            zip.on('end', () => finish(null));
            zip.on('entry', entry => {
                if (entry.fileName !== 'AndroidManifest.xml') return zip.readEntry();
                if (entry.uncompressedSize > 2 * 1024 * 1024) return finish(null);
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) return finish(null);
                    const chunks = [];
                    let size = 0;
                    stream.on('data', chunk => {
                        size += chunk.length;
                        if (size > 2 * 1024 * 1024) return stream.destroy();
                        chunks.push(chunk);
                    });
                    stream.on('error', () => finish(null));
                    stream.on('end', () => finish(packageNameFromManifest(Buffer.concat(chunks))));
                });
            });
            zip.readEntry();
        });
    });
}

export function androidEnvFromPackageName(packageName) {
    return typeof packageName === 'string' && packageName.toLowerCase().endsWith('pre') ? 'pre' : 'test';
}
