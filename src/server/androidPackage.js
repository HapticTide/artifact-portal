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

/** Return the installed app label as a literal string or Android resource ID. */
export function appLabelFromManifest(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
    if (bytes.readUInt16LE(0) !== 0x0003) {
        const tag = /<application\b[^>]*>/i.exec(bytes.toString('utf8'))?.[0];
        return tag ? /(?:android:)?label\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || null : null;
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
                if (type === 0x01) return value;
                const raw = stringAt(pool, bytes.readUInt32LE(attr + 8));
                return raw || (type === 0x03 ? stringAt(pool, value) : null);
            }
            return null;
        }
        cursor = chunk.end;
    }
    return null;
}

/** Resolve a string resource, preferring the default locale. */
export function stringFromResources(bytes, resourceId) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12 || !Number.isInteger(resourceId)) return null;
    const table = chunkAt(bytes, 0);
    if (!table || table.type !== 0x0002 || table.header < 12) return null;
    let strings = null;
    let fallback = null;
    for (let cursor = table.header; cursor + 8 <= table.end;) {
        const chunk = chunkAt(bytes, cursor, table.end);
        if (!chunk) break;
        if (chunk.type === 0x0001) strings = stringPool(bytes, chunk);
        if (chunk.type === 0x0200 && chunk.header >= 12 && bytes.readUInt32LE(cursor + 8) === (resourceId >>> 24)) {
            for (let inner = cursor + chunk.header; inner + 8 <= chunk.end;) {
                const typeChunk = chunkAt(bytes, inner, chunk.end);
                if (!typeChunk) break;
                if (typeChunk.type === 0x0201 && typeChunk.header >= 24 &&
                    bytes.readUInt8(inner + 8) === ((resourceId >>> 16) & 0xff)) {
                    const index = resourceId & 0xffff;
                    const count = bytes.readUInt32LE(inner + 12);
                    const start = bytes.readUInt32LE(inner + 16);
                    const offsets = inner + typeChunk.header;
                    const flags = bytes.readUInt8(inner + 9);
                    if (count <= 100000 && offsets + count * (flags & 1 ? 4 : flags & 2 ? 2 : 4) <= typeChunk.end) {
                        let offset = 0xffffffff;
                        if (flags & 1) {
                            for (let i = 0; i < count; i++) {
                                if (bytes.readUInt16LE(offsets + i * 4) === index) {
                                    offset = bytes.readUInt16LE(offsets + i * 4 + 2) * 4;
                                    break;
                                }
                            }
                        } else if (index < count && flags & 2) {
                            const shortOffset = bytes.readUInt16LE(offsets + index * 2);
                            if (shortOffset !== 0xffff) offset = shortOffset * 4;
                        } else if (index < count) {
                            offset = bytes.readUInt32LE(offsets + index * 4);
                        }
                        const entry = inner + start + offset;
                        if (offset !== 0xffffffff && entry + 16 <= typeChunk.end) {
                            const entrySize = bytes.readUInt16LE(entry);
                            const flags = bytes.readUInt16LE(entry + 2);
                            const value = entry + entrySize;
                            if (!(flags & 1) && value + 8 <= typeChunk.end && bytes.readUInt8(value + 3) === 0x03) {
                                const label = stringAt(strings, bytes.readUInt32LE(value + 4));
                                if (label) {
                                    if (bytes.readUInt16LE(inner + 28) === 0) return label;
                                    fallback ||= label;
                                }
                            }
                        }
                    }
                }
                inner = typeChunk.end;
            }
        }
        cursor = chunk.end;
    }
    return fallback;
}

function readApkEntries(path) {
    return new Promise(resolve => {
        yauzl.open(path, { lazyEntries: true }, (error, zip) => {
            if (error || !zip) return resolve({});
            const found = {};
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                zip.close();
                resolve(found);
            };
            zip.on('error', finish);
            zip.on('end', finish);
            zip.on('entry', entry => {
                const limit = entry.fileName === 'AndroidManifest.xml' ? 2 * 1024 * 1024
                    : entry.fileName === 'resources.arsc' ? 32 * 1024 * 1024 : 0;
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
                        found[entry.fileName] = Buffer.concat(chunks);
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

export async function readApkAppName(path) {
    const entries = await readApkEntries(path);
    const label = appLabelFromManifest(entries['AndroidManifest.xml']);
    if (typeof label === 'string' && !label.startsWith('@')) return label;
    return stringFromResources(entries['resources.arsc'], label);
}

export function androidEnvFromAppName(appName) {
    return typeof appName === 'string' && appName.toLowerCase().includes('pre') ? 'pre' : 'test';
}
