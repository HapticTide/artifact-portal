/**
 * 构建产物管理模块（重构版）
 * 
 * 支持的目录结构：
 *   builds/
 *     iOS/
 *       {branch}/
 *         {version}/
 *           {AppName}-{version}({build}).ipa
 *           manifest.plist (可选，不存在时动态生成)
 *     android/
 *       {branch}/
 *         {AppName}_v{version}.{build}_{date}_{time}_online-release.apk
 *         mapping/
 *           {apk 文件名去掉 .apk}.mapping.txt (可选，混淆映射文件)
 * 
 * 特性：
 * - iOS 和 Android 独立管理，不强制关联
 * - 支持从文件名解析版本和构建号
 * - 支持静态 manifest.plist 或动态生成
 * - Bundle ID 支持环境变量配置和从 IPA 解析
 * - 构建元数据持久化存储到 SQLite
 */

import { join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import config from './config.js';
import buildDatabase from './database.js';
import { readDirSafe, getFileSize, getDiskUsage } from './utils/fs.js';
import { formatFileSize } from './utils/format.js';
import { ANDROID_MAPPING_DIR, androidMappingCandidates } from './upload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 从 iOS IPA 文件名解析版本信息
 * 格式：{AppName}-{version}({build}).ipa
 * 示例：MyApp-0.6.0(388).ipa
 */
function parseIpaFilename(filename) {
    // 匹配格式：AppName-Version(Build).ipa
    const match = filename.match(/^(.+?)-?(\d+\.\d+\.\d+)\((\d+)\)\.ipa$/i);
    if (match) {
        return {
            appName: match[1],
            version: match[2],
            build: match[3],
        };
    }

    // 尝试更宽松的匹配
    const looseMatch = filename.match(/(\d+\.\d+\.\d+).*\((\d+)\)\.ipa$/i);
    if (looseMatch) {
        return {
            appName: filename.split('-')[0] || 'App',
            version: looseMatch[1],
            build: looseMatch[2],
        };
    }

    return null;
}

/**
 * 从 Android APK 文件名解析版本信息
 * 格式：{AppName}_v{version}.{build}_{date}_{time}_online-release.apk
 * 示例：MyApp_v0.6.0.14_01_12_15_31_online-release.apk
 */
function parseApkFilename(filename) {
    // 匹配格式：AppName_vVersion.Build_Date_Time_xxx.apk
    const match = filename.match(/^(.+?)_v?(\d+\.\d+\.\d+)\.(\d+)_(\d{2})_(\d{2})_(\d{2})_(\d{2}).*\.apk$/i);
    if (match) {
        const [, appName, version, build, month, day, hour, minute] = match;
        // 构造时间戳（假设当前年份）
        const now = new Date();
        const year = now.getFullYear();
        const time = new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));

        return {
            appName,
            version,
            build,
            time: time.toISOString(),
        };
    }

    // 尝试更宽松的匹配
    const looseMatch = filename.match(/v?(\d+\.\d+\.\d+)\.(\d+)/i);
    if (looseMatch) {
        return {
            appName: filename.split('_')[0] || 'App',
            version: looseMatch[1],
            build: looseMatch[2],
            time: null,
        };
    }

    return null;
}

/**
 * 从 IPA 文件解析 Info.plist 信息（Bundle ID 和 Display Name）
 * @param {string} ipaPath - IPA 文件路径
 * @returns {Promise<{bundleId: string|null, displayName: string|null}>}
 */
async function parseIpaInfoPlist(ipaPath) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const result = { bundleId: null, displayName: null };

    try {
        // 获取完整的 Info.plist 内容
        const cmd = `unzip -q -c "${ipaPath}" 'Payload/*.app/Info.plist' 2>/dev/null | plutil -p - 2>/dev/null`;
        const { stdout } = await execAsync(cmd, { timeout: 5000 });

        // 解析 CFBundleIdentifier
        const bundleIdMatch = stdout.match(/"CFBundleIdentifier"\s*=>\s*"([^"]+)"/);
        if (bundleIdMatch) {
            result.bundleId = bundleIdMatch[1];
        }

        // 解析 CFBundleDisplayName（优先）或 CFBundleName
        const displayNameMatch = stdout.match(/"CFBundleDisplayName"\s*=>\s*"([^"]+)"/);
        const bundleNameMatch = stdout.match(/"CFBundleName"\s*=>\s*"([^"]+)"/);

        if (displayNameMatch) {
            result.displayName = displayNameMatch[1];
        } else if (bundleNameMatch) {
            result.displayName = bundleNameMatch[1];
        }

        return result;
    } catch (err) {
        // 解析失败，返回空结果
        return result;
    }
}

/**
 * 构建管理器类（重构版）
 */
class ArtifactManager {
    constructor() {
        // 缓存
        this._iosCache = null;
        this._androidCache = null;
        this._cacheTime = 0;
        this._cacheTTL = config.cache.buildsTTL;
    }

    /**
     * 获取构建目录绝对路径
     */
    get buildsDir() {
        const dir = config.buildsDir;
        if (dir.startsWith('/')) {
            return dir;
        }
        return resolve(__dirname, '../..', dir);
    }

    /**
     * 使缓存失效
     */
    invalidateCache() {
        this._iosCache = null;
        this._androidCache = null;
        this._cacheTime = 0;
    }

    /**
     * 检查缓存是否有效
     */
    _isCacheValid() {
        return this._iosCache && this._androidCache &&
            (Date.now() - this._cacheTime) < this._cacheTTL;
    }

    /**
     * 扫描 iOS 构建
     * 目录结构：iOS/{branch}/{version}/xxx.ipa
     * @returns {Promise<Array>}
     */
    async _scanIosBuilds() {
        const iosDir = join(this.buildsDir, 'ios');
        if (!fs.existsSync(iosDir)) {
            return [];
        }

        const builds = [];
        const branches = await readDirSafe(iosDir);

        for (const branch of branches) {
            const branchPath = join(iosDir, branch);
            const stat = fs.statSync(branchPath);
            if (!stat.isDirectory()) continue;

            const versions = await readDirSafe(branchPath);

            for (const version of versions) {
                const versionPath = join(branchPath, version);
                const vstat = fs.statSync(versionPath);
                if (!vstat.isDirectory()) continue;

                // 使用 readdirSync 获取所有文件（readDirSafe 只返回目录）
                const files = fs.readdirSync(versionPath);
                const ipaFiles = files.filter(f => f.endsWith('.ipa'));

                for (const ipaFile of ipaFiles) {
                    const ipaPath = join(versionPath, ipaFile);
                    const parsed = parseIpaFilename(ipaFile);

                    if (!parsed) continue;

                    const fileStat = fs.statSync(ipaPath);
                    const fileSize = fileStat.size;
                    const mtime = fileStat.mtime;

                    // 检查是否有静态 manifest.plist
                    const manifestPath = join(versionPath, 'manifest.plist');
                    const hasStaticManifest = fs.existsSync(manifestPath);

                    // 从 IPA 的 Info.plist 解析 bundleId 和 displayName
                    let bundleId = null;
                    let displayName = null;
                    try {
                        const infoPlist = await parseIpaInfoPlist(ipaPath);
                        bundleId = infoPlist.bundleId;
                        displayName = infoPlist.displayName;
                    } catch (e) {
                        // 解析失败，使用配置中的默认值
                    }

                    builds.push({
                        platform: 'ios',
                        branch,
                        version: parsed.version,
                        build: parsed.build,
                        // 优先使用 Info.plist 解析的 displayName，其次是文件名解析的 appName
                        appName: displayName || parsed.appName,
                        bundleId: bundleId || config.iosBundleId,
                        filename: ipaFile,
                        // 相对路径（用于下载 URL）
                        relativePath: `ios/${branch}/${version}/${ipaFile}`,
                        absolutePath: ipaPath,
                        manifestPath: hasStaticManifest ? `ios/${branch}/${version}/manifest.plist` : null,
                        hasStaticManifest,
                        size: fileSize,
                        time: mtime.toISOString(),
                        // 唯一标识符
                        id: `ios_${branch}_${parsed.version}_${parsed.build}`,
                    });
                }
            }
        }

        // 按时间倒序排序
        builds.sort((a, b) => new Date(b.time) - new Date(a.time));
        return builds;
    }

    /**
     * 查找 APK 对应的 mapping 文件
     * @param {string} branch - 分支目录名
     * @param {string} apkFile - APK 文件名
     * @returns {{relativePath: string, size: number}|null}
     */
    _findAndroidMapping(branch, apkFile) {
        let candidates;
        try {
            candidates = androidMappingCandidates(apkFile);
        } catch {
            return null;
        }

        for (const name of candidates) {
            const fullPath = join(this.buildsDir, 'android', branch, ANDROID_MAPPING_DIR, name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    return {
                        relativePath: `android/${branch}/${ANDROID_MAPPING_DIR}/${name}`,
                        size: stat.size,
                    };
                }
            } catch {
                // 文件不存在，尝试下一个候选扩展名
            }
        }

        return null;
    }

    /**
     * 扫描 Android 构建
     * 目录结构：android/{branch}/xxx.apk
     * @returns {Promise<Array>}
     */
    async _scanAndroidBuilds() {
        const androidDir = join(this.buildsDir, 'android');
        if (!fs.existsSync(androidDir)) {
            return [];
        }

        const builds = [];
        const branches = await readDirSafe(androidDir);

        for (const branch of branches) {
            const branchPath = join(androidDir, branch);
            const stat = fs.statSync(branchPath);
            if (!stat.isDirectory()) continue;

            // 使用 readdirSync 获取所有文件
            const files = fs.readdirSync(branchPath);
            const apkFiles = files.filter(f => f.endsWith('.apk'));

            for (const apkFile of apkFiles) {
                const apkPath = join(branchPath, apkFile);
                const parsed = parseApkFilename(apkFile);

                if (!parsed) continue;

                const fileStat = fs.statSync(apkPath);
                const fileSize = fileStat.size;
                const mtime = fileStat.mtime;

                // 查找同名 mapping 文件（android/<branch>/mapping/<apkBase>.mapping.txt|zip）
                const mapping = this._findAndroidMapping(branch, apkFile);

                builds.push({
                    platform: 'android',
                    branch,
                    version: parsed.version,
                    build: parsed.build,
                    appName: parsed.appName,
                    filename: apkFile,
                    // 相对路径（用于下载 URL）
                    relativePath: `android/${branch}/${apkFile}`,
                    absolutePath: apkPath,
                    // mapping 相对路径与体积（无 mapping 时为 null）
                    mappingPath: mapping?.relativePath || null,
                    mappingSize: mapping?.size ?? null,
                    size: fileSize,
                    // 优先使用从文件名解析的时间，否则用文件修改时间
                    time: parsed.time || mtime.toISOString(),
                    // 唯一标识符
                    id: `android_${branch}_${parsed.version}_${parsed.build}`,
                });
            }
        }

        // 按时间倒序排序
        builds.sort((a, b) => new Date(b.time) - new Date(a.time));
        return builds;
    }

    /**
     * 确保缓存有效
     */
    async _ensureCache() {
        if (!this._isCacheValid()) {
            this._iosCache = await this._scanIosBuilds();
            this._androidCache = await this._scanAndroidBuilds();
            this._cacheTime = Date.now();

            // 同步数据到 SQLite
            this._syncToDatabase();
        }
    }

    /**
     * 同步构建数据到 SQLite 数据库
     */
    _syncToDatabase() {
        const allBuilds = [];
        const existingDirs = new Set();

        // 收集 iOS 构建
        for (const ios of this._iosCache) {
            const dir = `ios_${ios.branch}_${ios.version}_${ios.build}`;
            existingDirs.add(dir);
            allBuilds.push({
                dir,
                platform: 'ios',
                branch: ios.branch,
                version: ios.version,
                build: ios.build,
                size: ios.size,
                time: ios.time,
                filePath: ios.absolutePath || ios.relativePath || '',
            });
        }

        // 收集 Android 构建
        for (const android of this._androidCache) {
            const dir = `android_${android.branch}_${android.version}_${android.build}`;
            existingDirs.add(dir);
            allBuilds.push({
                dir,
                platform: 'android',
                branch: android.branch,
                version: android.version,
                build: android.build,
                size: android.size,
                time: android.time,
                filePath: android.absolutePath || android.relativePath || '',
            });
        }

        // 批量同步到数据库
        if (allBuilds.length > 0) {
            buildDatabase.upsertBuilds(allBuilds);
        }

        // 清理已删除的构建记录
        buildDatabase.cleanupMissing(existingDirs);
    }

    /**
     * 获取构建列表（按天数分页）
     * 返回格式与前端兼容，按日期分组加载
     * @param {object} options - 查询选项
     * @param {number} options.days - 每次加载的天数（默认 3 天）
     * @param {number} options.skipDays - 跳过的天数（用于分页）
     * @param {string} options.branch - 按分支过滤
     * @param {string} options.platform - 按平台过滤（ios/android）
     */
    async getBuilds(options = {}) {
        const { days = 3, skipDays = 0, branch = null, platform = null } = options;

        await this._ensureCache();

        // 构建"虚拟构建"列表 - 将 iOS 和 Android 按时间合并
        let allBuilds = [];

        // 添加 iOS 构建
        if (!platform || platform === 'ios') {
            for (const ios of this._iosCache) {
                if (branch && ios.branch !== branch) continue;
                allBuilds.push(this._formatIosBuild(ios));
            }
        }

        // 添加 Android 构建
        if (!platform || platform === 'android') {
            for (const android of this._androidCache) {
                if (branch && android.branch !== branch) continue;
                allBuilds.push(this._formatAndroidBuild(android));
            }
        }

        // 按时间倒序排序
        allBuilds.sort((a, b) => new Date(b.time) - new Date(a.time));

        // 按日期分组（只考虑日期部分，忽略时间）
        const buildsByDate = new Map();
        for (const build of allBuilds) {
            const dateKey = new Date(build.time).toISOString().split('T')[0]; // YYYY-MM-DD
            if (!buildsByDate.has(dateKey)) {
                buildsByDate.set(dateKey, []);
            }
            buildsByDate.get(dateKey).push(build);
        }

        // 获取所有有构建的日期，按时间倒序排列
        const sortedDates = Array.from(buildsByDate.keys()).sort((a, b) => b.localeCompare(a));

        // 跳过指定天数，获取接下来 days 天的构建
        const targetDates = sortedDates.slice(skipDays, skipDays + days);
        const resultBuilds = [];
        for (const date of targetDates) {
            resultBuilds.push(...buildsByDate.get(date));
        }

        // 计算总天数和是否还有更多
        const totalDays = sortedDates.length;
        const hasMore = skipDays + days < totalDays;

        return {
            builds: resultBuilds,
            total: allBuilds.length,
            totalDays,
            loadedDays: targetDates.length,
            hasMore,
        };
    }

    /**
     * 获取最新构建
     */
    async getLatestBuild(options = {}) {
        const result = await this.getBuilds({
            ...options,
            limit: 1,
        });

        return result.builds[0] || null;
    }

    /**
     * 获取每个平台的最新构建
     * @param {object} options - 过滤选项
     * @param {string} options.branch - 按分支过滤
     * @returns {Promise<{ios: object|null, android: object|null}>}
     */
    async getLatestByPlatform(options = {}) {
        const { branch = null } = options;

        await this._ensureCache();

        // 过滤并获取 iOS 最新
        let iosBuilds = this._iosCache;
        if (branch) {
            iosBuilds = iosBuilds.filter(b => b.branch === branch);
        }
        const latestIos = iosBuilds.length > 0 ? this._formatIosBuild(iosBuilds[0]) : null;

        // 过滤并获取 Android 最新
        let androidBuilds = this._androidCache;
        if (branch) {
            androidBuilds = androidBuilds.filter(b => b.branch === branch);
        }
        const latestAndroid = androidBuilds.length > 0 ? this._formatAndroidBuild(androidBuilds[0]) : null;

        return {
            ios: latestIos,
            android: latestAndroid,
        };
    }

    /**
     * 获取单个构建
     */
    async getBuild(buildId) {
        await this._ensureCache();

        // 查找 iOS
        const ios = this._iosCache.find(b => b.id === buildId);
        if (ios) return this._formatIosBuild(ios);

        // 查找 Android
        const android = this._androidCache.find(b => b.id === buildId);
        if (android) return this._formatAndroidBuild(android);

        return null;
    }

    /**
     * 根据相对路径获取构建信息
     * @param {string} relativePath - 如 "iOS/dev/0.6.0/MyApp-0.6.0(388).ipa"
     */
    async getBuildByPath(relativePath) {
        await this._ensureCache();

        // 查找 iOS
        const ios = this._iosCache.find(b => b.relativePath === relativePath);
        if (ios) return ios;

        // 查找 Android
        const android = this._androidCache.find(b => b.relativePath === relativePath);
        if (android) return android;

        return null;
    }

    /**
     * 获取所有分支（直接从文件系统读取目录）
     */
    async getBranches() {
        const iosDir = join(this.buildsDir, 'iOS');
        const androidDir = join(this.buildsDir, 'android');

        // 直接读取文件系统中的分支目录
        const iosDirs = await readDirSafe(iosDir);
        const androidDirs = await readDirSafe(androidDir);

        // 过滤出目录（排除文件）
        const iosBranches = [];
        for (const name of iosDirs) {
            const fullPath = join(iosDir, name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    iosBranches.push(name);
                }
            } catch {
                // 忽略无法访问的目录
            }
        }

        const androidBranches = [];
        for (const name of androidDirs) {
            const fullPath = join(androidDir, name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    androidBranches.push(name);
                }
            } catch {
                // 忽略无法访问的目录
            }
        }

        const allBranches = new Set([...iosBranches, ...androidBranches]);

        return {
            all: Array.from(allBranches).sort(),
            ios: iosBranches.sort(),
            android: androidBranches.sort(),
        };
    }

    /**
     * 获取磁盘使用统计
     */
    async getDiskStats() {
        const usage = await getDiskUsage(this.buildsDir);
        const usageGB = usage / (1024 * 1024 * 1024);

        return {
            usage,
            usageFormatted: formatFileSize(usage),
            thresholdGB: config.diskThresholdGB,
            warning: usageGB >= config.diskThresholdGB,
        };
    }

    /**
     * 格式化 iOS 构建（兼容前端）
     */
    _formatIosBuild(ios) {
        return {
            dir: ios.id,
            id: ios.id,
            time: ios.time,
            platforms: {
                ios: {
                    available: true,
                    version: ios.version,
                    build: ios.build,
                    branch: ios.branch,
                    bundleId: ios.bundleId || config.iosBundleId || '',
                    appName: ios.appName || '', // 从 IPA 解析的应用名称
                    // 下载路径
                    ipa: ios.relativePath,
                    // manifest 路径（静态或动态）
                    manifest: ios.hasStaticManifest
                        ? ios.manifestPath
                        : `api/manifest/${ios.id}`,
                    hasStaticManifest: ios.hasStaticManifest,
                    size: formatFileSize(ios.size),
                    sizeBytes: ios.size,
                },
            },
        };
    }

    /**
     * 格式化 Android 构建（兼容前端）
     */
    _formatAndroidBuild(android) {
        return {
            dir: android.id,
            id: android.id,
            time: android.time,
            platforms: {
                android: {
                    available: true,
                    version: android.version,
                    build: android.build,
                    branch: android.branch,
                    packageName: config.androidPackageName || '',
                    apk: android.relativePath,
                    // mapping 下载路径（无 mapping 时为 null）
                    mapping: android.mappingPath || null,
                    mappingSize: android.mappingSize != null ? formatFileSize(android.mappingSize) : null,
                    size: formatFileSize(android.size),
                    sizeBytes: android.size,
                },
            },
        };
    }

    /**
     * 获取 iOS 构建的原始信息（用于生成 manifest）
     */
    async getIosBuildInfo(buildId) {
        await this._ensureCache();
        return this._iosCache.find(b => b.id === buildId) || null;
    }

    /**
     * 获取包体积统计数据
     * 优先从 SQLite 数据库读取历史数据，确保数据持久化
     * @param {Object} options
     * @param {number} options.limit - 最多返回的构建数量
     * @param {string} options.platform - 平台筛选 (ios/android/all)
     * @returns {Object} 包体积统计数据
     */
    async getSizeStats({ limit = 30, platform = 'all' } = {}) {
        // 先确保缓存有效（会触发数据同步到数据库）
        await this._ensureCache();

        // 从数据库获取统计数据
        return buildDatabase.getSizeStats({ limit, platform });
    }
}

// 导出单例
export const artifactManager = new ArtifactManager();
export default artifactManager;
