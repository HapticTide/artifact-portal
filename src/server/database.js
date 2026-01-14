/**
 * SQLite 数据库模块
 * 用于持久化存储构建历史记录
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import config from './config.js';

// 数据库文件路径
const DB_DIR = join(config.buildsDir, '.data');
const DB_PATH = join(DB_DIR, 'builds.db');

// 确保数据目录存在
if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
}

// 创建数据库连接
const db = new Database(DB_PATH);

// 启用 WAL 模式以提升性能
db.pragma('journal_mode = WAL');

// 数据库迁移：为旧表添加 deleted 字段（在初始化表结构之前执行）
try {
    // 检查表是否存在
    const tableExists = db.prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='builds'"
    ).get().cnt > 0;

    if (tableExists) {
        // 检查是否已有 deleted 列
        const hasDeletedColumn = db.prepare(
            "SELECT COUNT(*) as cnt FROM pragma_table_info('builds') WHERE name='deleted'"
        ).get().cnt > 0;

        if (!hasDeletedColumn) {
            db.exec('ALTER TABLE builds ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
            console.log('[Database] 迁移: 已添加 deleted 字段用于保留历史统计数据');
        }
    }
} catch (e) {
    console.error('[Database] 迁移检查失败:', e.message);
}

// 初始化表结构（新安装时创建完整表）
db.exec(`
    -- 构建历史记录表
    CREATE TABLE IF NOT EXISTS builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir TEXT NOT NULL UNIQUE,           -- 构建目录标识 (如 ios_dev_0.7.0_390)
        platform TEXT NOT NULL,             -- 平台 (ios/android)
        branch TEXT NOT NULL,               -- 分支
        version TEXT NOT NULL,              -- 版本号
        build TEXT NOT NULL,                -- 构建号
        size INTEGER NOT NULL DEFAULT 0,    -- 包大小 (bytes)
        time TEXT NOT NULL,                 -- 构建时间 (ISO 字符串)
        file_path TEXT NOT NULL,            -- 文件完整路径
        deleted INTEGER NOT NULL DEFAULT 0, -- 是否已删除 (0=存在, 1=已删除)
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 索引优化查询性能
    CREATE INDEX IF NOT EXISTS idx_builds_platform ON builds(platform);
    CREATE INDEX IF NOT EXISTS idx_builds_branch ON builds(branch);
    CREATE INDEX IF NOT EXISTS idx_builds_time ON builds(time DESC);
    CREATE INDEX IF NOT EXISTS idx_builds_platform_time ON builds(platform, time DESC);
    CREATE INDEX IF NOT EXISTS idx_builds_deleted ON builds(deleted);
`);

console.log('[Database] SQLite 数据库已初始化:', DB_PATH);

/**
 * 数据库操作类
 */
class BuildDatabase {
    /**
     * 插入或更新构建记录
     * @param {Object} build - 构建信息
     */
    upsertBuild(build) {
        const stmt = db.prepare(`
            INSERT INTO builds (dir, platform, branch, version, build, size, time, file_path, deleted, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(dir) DO UPDATE SET
                size = excluded.size,
                time = excluded.time,
                file_path = excluded.file_path,
                deleted = 0,
                updated_at = CURRENT_TIMESTAMP
        `);

        return stmt.run(
            build.dir,
            build.platform,
            build.branch,
            build.version,
            build.build,
            build.size,
            build.time,
            build.filePath
        );
    }

    /**
     * 批量插入或更新构建记录
     * @param {Array} builds - 构建列表
     */
    upsertBuilds(builds) {
        const upsert = db.prepare(`
            INSERT INTO builds (dir, platform, branch, version, build, size, time, file_path, deleted, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(dir) DO UPDATE SET
                size = excluded.size,
                time = excluded.time,
                file_path = excluded.file_path,
                deleted = 0,
                updated_at = CURRENT_TIMESTAMP
        `);

        const transaction = db.transaction((items) => {
            for (const b of items) {
                upsert.run(
                    b.dir,
                    b.platform,
                    b.branch,
                    b.version,
                    b.build,
                    b.size,
                    b.time,
                    b.filePath
                );
            }
        });

        transaction(builds);
        console.log(`[Database] 已同步 ${builds.length} 条构建记录`);
    }

    /**
     * 获取包体积统计数据
     * @param {Object} options - 查询选项
     * @param {number} options.limit - 返回数量限制
     * @param {string} options.platform - 平台筛选 (ios/android/all)
     * @returns {Object} 统计数据
     */
    getSizeStats({ limit = 30, platform = 'all' } = {}) {
        const result = {
            ios: null,
            android: null,
        };

        const query = db.prepare(`
            SELECT 
                dir,
                version,
                build,
                size,
                time,
                branch
            FROM builds
            WHERE platform = ? AND size > 0
            ORDER BY time ASC
            LIMIT ?
        `);

        // iOS 统计
        if (platform === 'all' || platform === 'ios') {
            const iosBuilds = query.all('ios', limit);
            if (iosBuilds.length > 0) {
                result.ios = this._calculateStats(iosBuilds);
            }
        }

        // Android 统计
        if (platform === 'all' || platform === 'android') {
            const androidBuilds = query.all('android', limit);
            if (androidBuilds.length > 0) {
                result.android = this._calculateStats(androidBuilds);
            }
        }

        return result;
    }

    /**
     * 计算统计数据
     * @private
     */
    _calculateStats(builds) {
        const sizes = builds.map(b => b.size);
        const latest = builds[builds.length - 1];
        const oldest = builds[0];

        const formatSize = (bytes) => {
            if (bytes >= 1024 * 1024 * 1024) {
                return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
            } else if (bytes >= 1024 * 1024) {
                return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
            } else if (bytes >= 1024) {
                return `${(bytes / 1024).toFixed(1)} KB`;
            }
            return `${bytes} B`;
        };

        return {
            data: builds.map(b => ({
                version: `${b.version}(${b.build})`,
                time: b.time,
                size: b.size,
                sizeFormatted: formatSize(b.size),
                branch: b.branch,
            })),
            summary: {
                count: builds.length,
                latest: {
                    size: latest.size,
                    sizeFormatted: formatSize(latest.size),
                    version: `${latest.version}(${latest.build})`,
                },
                min: {
                    size: Math.min(...sizes),
                    sizeFormatted: formatSize(Math.min(...sizes)),
                },
                max: {
                    size: Math.max(...sizes),
                    sizeFormatted: formatSize(Math.max(...sizes)),
                },
                avg: {
                    size: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
                    sizeFormatted: formatSize(Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)),
                },
                trend: builds.length >= 2 ? {
                    change: latest.size - oldest.size,
                    changeFormatted: formatSize(Math.abs(latest.size - oldest.size)),
                    changePercent: (Math.abs(latest.size - oldest.size) / oldest.size * 100).toFixed(1),
                    direction: latest.size > oldest.size ? 'increase' : (latest.size < oldest.size ? 'decrease' : 'stable'),
                } : null,
            },
        };
    }

    /**
     * 获取所有构建记录（仅返回未删除的）
     * @param {Object} options - 查询选项
     */
    getBuilds({ limit = 100, offset = 0, platform = null, branch = null } = {}) {
        let sql = 'SELECT * FROM builds WHERE deleted = 0';
        const params = [];

        if (platform) {
            sql += ' AND platform = ?';
            params.push(platform);
        }
        if (branch) {
            sql += ' AND branch = ?';
            params.push(branch);
        }

        sql += ' ORDER BY time DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return db.prepare(sql).all(...params);
    }

    /**
     * 获取记录总数（仅统计未删除的）
     */
    getCount({ platform = null, branch = null } = {}) {
        let sql = 'SELECT COUNT(*) as count FROM builds WHERE deleted = 0';
        const params = [];

        if (platform) {
            sql += ' AND platform = ?';
            params.push(platform);
        }
        if (branch) {
            sql += ' AND branch = ?';
            params.push(branch);
        }

        return db.prepare(sql).get(...params).count;
    }

    /**
     * 检查构建是否存在
     * @param {string} dir - 构建目录标识
     */
    exists(dir) {
        const stmt = db.prepare('SELECT 1 FROM builds WHERE dir = ?');
        return !!stmt.get(dir);
    }

    /**
     * 删除构建记录（物理删除）
     * @param {string} dir - 构建目录标识
     */
    deleteBuild(dir) {
        return db.prepare('DELETE FROM builds WHERE dir = ?').run(dir);
    }

    /**
     * 标记构建为已删除（软删除）
     * 保留包体积统计数据
     * @param {string} dir - 构建目录标识
     */
    markAsDeleted(dir) {
        return db.prepare('UPDATE builds SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE dir = ?').run(dir);
    }

    /**
     * 清理不存在的构建记录
     * 改为软删除：标记 deleted=1，保留包体积统计数据
     * @param {Set<string>} existingDirs - 当前存在的构建目录集合
     */
    cleanupMissing(existingDirs) {
        // 只查找未删除的记录
        const allDirs = db.prepare('SELECT dir FROM builds WHERE deleted = 0').all().map(r => r.dir);
        const toMark = allDirs.filter(dir => !existingDirs.has(dir));

        if (toMark.length > 0) {
            const markStmt = db.prepare('UPDATE builds SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE dir = ?');
            const transaction = db.transaction((dirs) => {
                for (const dir of dirs) {
                    markStmt.run(dir);
                }
            });
            transaction(toMark);
            console.log(`[Database] 已标记 ${toMark.length} 条构建为已删除（保留统计数据）`);
        }
    }

    /**
     * 获取统计数据中的记录数量（包含已删除的）
     */
    getTotalHistoryCount() {
        return db.prepare('SELECT COUNT(*) as count FROM builds').get().count;
    }

    /**
     * 关闭数据库连接
     */
    close() {
        db.close();
    }
}

// 导出单例
const buildDatabase = new BuildDatabase();
export default buildDatabase;
