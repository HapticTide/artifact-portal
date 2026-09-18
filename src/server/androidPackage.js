import yauzl from 'yauzl';

function chunkAt(bytes, offset, limit = bytes.length) {
    if (offset + 8 > limit) return null;
    const type = bytes.readUInt16LE(offset);
    const header = bytes.readUInt16LE(offset + 2);
    const size = bytes.readUInt32LE(offset + 4);
    return header >= 8 && size >= header && offset + size <= limit
        ? { type, offset, header, size, end: offset + size } : null;
}

function stringPool(bytes, chunk) {
    if (chunk.type !== 0x0001 || chunk.header < 28) return null;
    const count = bytes.readUInt32LE(chunk.offset + 8);
    if (count > 100000 || chunk.offset + 28 + count * 4 > chunk.end) return null;
    return {
        bytes, count, utf8: Boolean(bytes.readUInt32LE(chunk.offset + 16) & 0x100),
        offsets: Array.from({ length: count }, (_, i) => bytes.readUInt32LE(chunk.offset + 28 + i * 4)),
        start: chunk.offset + bytes.readUInt32LE(chunk.offset + 20), end: chunk.end,
    };
}

function stringAt(pool, index) {
    if (!pool || index === 0xffffffff || index >= pool.count) return null;
    const bytes = pool.bytes;
    const offset = pool.start + pool.offsets[index];
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
        if (length() === null) return null;
        const size = length();
        return size !== null && cursor + size <= pool.end ? bytes.toString('utf8', cursor, cursor + size) : null;
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
    return cursor + size * 2 <= pool.end ? bytes.toString('utf16le', cursor, cursor + size * 2) : null;
}

/** Return a literal application label from AndroidManifest.xml. */
export function appLabelFromManifest(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
    if (bytes.readUInt16LE(0) !== 0x0003) {
        const tag = /<application\b[^>]*>/i.exec(bytes.toString('utf8'))?.[0];
        const label = tag ? /(?:android:)?label\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] : null;
        return label && !label.startsWith('@') ? label : null;
    }
    const limit = Math.min(bytes.readUInt32LE(4), bytes.length);
    let pool = null;
    for (let cursor = bytes.readUInt16LE(2); cursor + 8 <= limit;) {
        const chunk = chunkAt(bytes, cursor, limit);
        if (!chunk) break;
        if (chunk.type === 0x0001) pool = stringPool(bytes, chunk);
        if (chunk.type === 0x0102 && pool && chunk.header >= 16 && chunk.size >= 36 &&
            stringAt(pool, bytes.readUInt32LE(cursor + 20)) === 'application') {
            const start = bytes.readUInt16LE(cursor + 24);
            const size = bytes.readUInt16LE(cursor + 26);
            const count = bytes.readUInt16LE(cursor + 28);
            if (size < 20 || cursor + 16 + start + size * count > chunk.end) return null;
            for (let i = 0; i < count; i++) {
                const attr = cursor + 16 + start + i * size;
                if (stringAt(pool, bytes.readUInt32LE(attr + 4)) !== 'label') continue;
                const type = bytes.readUInt8(attr + 15);
                const value = bytes.readUInt32LE(attr + 16);
                if (type === 0x01) return null;
                const raw = stringAt(pool, bytes.readUInt32LE(attr + 8));
                const label = raw || (type === 0x03 ? stringAt(pool, value) : null);
                return label && !label.startsWith('@') ? label : null;
            }
            return null;
        }
        cursor = chunk.end;
    }
    return null;
}

function readApkManifest(path) {
    return new Promise(resolve => {
        yauzl.open(path, { lazyEntries: true }, (error, zip) => {
            if (error || !zip) return resolve(null);
            let manifest = null;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                zip.close();
                resolve(manifest);
            };
            zip.on('error', finish);
            zip.on('end', finish);
            zip.on('entry', entry => {
                const limit = entry.fileName === 'AndroidManifest.xml' ? 2 * 1024 * 1024 : 0;
                if (!limit || entry.uncompressedSize > limit) return zip.readEntry();
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) return finish();
                    const chunks = [];
                    let size = 0;
                    stream.on('data', chunk => {
                        size += chunk.length;
                        if (size > limit) return stream.destroy(new Error('APK entry too large'));
                        chunks.push(chunk);
                    });
                    stream.on('error', finish);
                    stream.on('end', () => {
                        manifest = Buffer.concat(chunks);
                        finish();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

export async function readApkAppName(path) {
    return appLabelFromManifest(await readApkManifest(path));
}

export function androidEnvFromAppName(appName) {
    return typeof appName === 'string' && appName.toLowerCase().includes('pre') ? 'pre' : 'test';
}
