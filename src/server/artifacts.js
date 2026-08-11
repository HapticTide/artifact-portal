/**
 * 构建产物管理模块（重构版）
 * 
 * 支持的目录结构：
 *   builds/
 *     ios/
 *       {branch}/
 *         {env}/
 *           {version}/
 *             {AppName}-{version}({build}).ipa
 *             manifest.plist (可选，不存在时动态生成)
 *     android/
 *       {branch}/
 *         {version}.{build}/
 *           {AppName}_v{version}.{build}_{date}_{time}_online-release.apk
 *           {apk 文件名去掉 .apk}.mapping.zip (可选，混淆映射文件，与 APK 同目录)
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
import { androidMappingCandidates, parseApkFilename, androidVersionDirForApk } from './androidMapping.js';
import { buildIosArtifactId, resolveIosEnv } from './upload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 已知 iOS 身份 env 目录名（白名单；其余视为旧布局 version 目录） */
const IOS_ENV_WHITELIST = new Set(['pre', 'production', 'sandbox']);

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
 * 从 IPA 文件解析 Info.plist 信息（Bundle ID 和 Display Name）。
 *
 * 优先 python3+plistlib：Linux 部署机通常无 plutil，且 Xcode 产物 Info.plist 多为 bplist。
 * 旧路径依赖 `unzip | plutil -p`，在 VPS 上会静默失败并回退到 com.example.app，
 * 导致 OTA manifest 的 bundle-identifier 错误、手机安装报 Unable to Install。
 *
 * @param {string} ipaPath - IPA 文件路径
 * @returns {Promise<{bundleId: string|null, displayName: string|null}>}
 */
async function parseIpaInfoPlist(ipaPath) {
    const { exec, execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const execFileAsync = promisify(execFile);

    const result = { bundleId: null, displayName: null };

    // python3 读取 ZIP 内二进制/XML Info.plist（macOS / Linux 均可用）
    const py = `
import json, sys, zipfile, plistlib
ipa = sys.argv[1]
with zipfile.ZipFile(ipa) as z:
    name = next(
        n for n in z.namelist()
        if n.startswith("Payload/") and n.endswith(".app/Info.plist") and n.count("/") == 2
    )
    p = plistlib.loads(z.read(name))
print(json.dumps({
    "bundleId": p.get("CFBundleIdentifier"),
    "displayName": p.get("CFBundleDisplayName") or p.get("CFBundleName"),
}, ensure_ascii=False))
`.trim();

    try {
        const { stdout } = await execFileAsync('python3', ['-c', py, ipaPath], {
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
        });
        const parsed = JSON.parse(String(stdout || '').trim());
        if (parsed.bundleId) {
            result.bundleId = parsed.bundleId;
        }
        if (parsed.displayName) {
            result.displayName = parsed.displayName;
        }
        if (result.bundleId) {
            return result;
        }
    } catch {
        // fall through to plutil
    }

    try {
        // 兼容：本机 macOS 有 plutil 时的旧路径
        const cmd = `unzip -q -c ${JSON.stringify(ipaPath)} 'Payload/*.app/Info.plist' 2>/dev/null | plutil -p - 2>/dev/null`;
        const { stdout } = await execAsync(cmd, { timeout: 10000 });

        const bundleIdMatch = stdout.match(/"CFBundleIdentifier"\s*=>\s*"([^"]+)"/);
        if (bundleIdMatch) {
            result.bundleId = bundleIdMatch[1];
        }

        const displayNameMatch = stdout.match(/"CFBundleDisplayName"\s*=>\s*"([^"]+)"/);
        const bundleNameMatch = stdout.match(/"CFBundleName"\s*=>\s*"([^"]+)"/);

        if (displayNameMatch) {
            result.displayName = displayNameMatch[1];
        } else if (bundleNameMatch) {
            result.displayName = bundleNameMatch[1];
        }

        return result;
    } catch {
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
     * 扫描单个 version 目录下的 IPA，写入 builds。
     * @param {object} opts
     * @param {string} opts.branch
     * @param {string|null} opts.env pre|production|sandbox；旧布局传 null
     * @param {string|null} opts.storageEnv 物理目录身份，用于兼容目录去重
     * @param {string} opts.versionDir 目录名（版本号）
     * @param {string} opts.versionPath 绝对路径
     * @param {string} opts.relativeVersionPrefix 相对路径前缀（含 env 或不含）
     */
    async _collectIosVersionDir({
        branch,
        env,
        storageEnv,
        versionDir,
        versionPath,
        relativeVersionPrefix,
        builds,
    }) {
        const files = fs.readdirSync(versionPath);
        const ipaFiles = files.filter(f => f.endsWith('.ipa'));

        for (const ipaFile of ipaFiles) {
            const ipaPath = join(versionPath, ipaFile);
            const parsed = parseIpaFilename(ipaFile);
            if (!parsed) continue;

            const fileStat = fs.statSync(ipaPath);
            const fileSize = fileStat.size;
            const mtime = fileStat.mtime;

            const manifestPath = join(versionPath, 'manifest.plist');
            const hasStaticManifest = fs.existsSync(manifestPath);

            let bundleId = null;
            let displayName = null;
            try {
                const infoPlist = await parseIpaInfoPlist(ipaPath);
                bundleId = infoPlist.bundleId;
                displayName = infoPlist.displayName;
            } catch (e) {
                // 解析失败，使用配置中的默认值
            }

            // 解析失败时：按目录 env / 文件名推断，禁止落到 com.example.app 这种占位 Bundle ID
            // （否则 iOS OTA manifest 与 IPA 不一致 → Unable to Install）
            let fallbackBundleId = config.iosBundleId;
            const envHint = (env || storageEnv || '').toLowerCase();
            const nameHint = `${parsed.appName || ''} ${ipaFile}`.toLowerCase();
            if (envHint === 'pre' || envHint === 'sandbox' || nameHint.includes('imwe-pre') || nameHint.includes('.pre')) {
                fallbackBundleId = 'com.imwe.app.pre';
            } else if (envHint === 'production' || envHint === 'prod' || nameHint.includes('imwe')) {
                // 正式包默认；若项目另有 Bundle ID，仍以 IPA 解析为准
                fallbackBundleId = config.iosBundleId && config.iosBundleId !== 'com.example.app'
                    ? config.iosBundleId
                    : 'com.imwe.app';
            }

            const resolvedBundleId = bundleId || fallbackBundleId;
            const resolvedEnv = resolveIosEnv(env, resolvedBundleId);
            const id = buildIosArtifactId(branch, resolvedEnv, parsed.version, parsed.build);
            builds.push({
                platform: 'ios',
                branch,
                // 优先目录 env；若旧布局缺 env，用 bundleId 推断 pre
                env: resolvedEnv,
                storageEnv,
                hasLegacySource: storageEnv === null,
                version: parsed.version,
                build: parsed.build,
                appName: displayName || parsed.appName,
                bundleId: resolvedBundleId,
                filename: ipaFile,
                relativePath: `${relativeVersionPrefix}/${ipaFile}`,
                absolutePath: ipaPath,
                manifestPath: hasStaticManifest ? `${relativeVersionPrefix}/manifest.plist` : null,
                hasStaticManifest,
                size: fileSize,
                time: mtime.toISOString(),
                id,
            });
        }
    }

    /**
     * 扫描 iOS 构建。
     * 新目录：ios/{branch}/{env}/{version}/xxx.ipa（env ∈ pre|production；兼容 sandbox）
     * 旧目录：ios/{branch}/{version}/xxx.ipa → 优先按 Bundle ID 推断身份
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

            const children = await readDirSafe(branchPath);

            for (const child of children) {
                const childPath = join(branchPath, child);
                const cstat = fs.statSync(childPath);
                if (!cstat.isDirectory()) continue;

                if (IOS_ENV_WHITELIST.has(child)) {
                    // 新布局：磁盘目录名 child 可能是 sandbox 历史别名。
                    const versions = await readDirSafe(childPath);
                    for (const version of versions) {
                        const versionPath = join(childPath, version);
                        const vstat = fs.statSync(versionPath);
                        if (!vstat.isDirectory()) continue;
                        await this._collectIosVersionDir({
                            branch,
                            env: child,
                            storageEnv: child,
                            versionDir: version,
                            versionPath,
                            // 下载路径必须与真实磁盘目录一致（sandbox 目录不能改写成 pre）
                            relativeVersionPrefix: `ios/${branch}/${child}/${version}`,
                            builds,
                        });
                    }
                } else {
                    // 旧布局：child 即 version；env 由 bundleId 再归一（缺省 production）
                    await this._collectIosVersionDir({
                        branch,
                        env: null,
                        storageEnv: null,
                        versionDir: child,
                        versionPath: childPath,
                        relativeVersionPrefix: `ios/${branch}/${child}`,
                        builds,
                    });
                }
            }
        }

        // sandbox 是 pre 的历史物理目录别名。迁移期两者可能短暂并存，
        // 同一 branch/env/version/build 只保留 canonical pre 目录，避免详情 ID 冲突。
        const storagePriority = { pre: 3, production: 3, sandbox: 2 };
        const uniqueBuilds = new Map();
        for (const build of builds) {
            const existing = uniqueBuilds.get(build.id);
            const priority = storagePriority[build.storageEnv] || 1;
            const existingPriority = storagePriority[existing?.storageEnv] || 1;
            if (!existing || priority > existingPriority) {
                if (existing?.hasLegacySource) {
                    build.hasLegacySource = true;
                }
                uniqueBuilds.set(build.id, build);
            } else if (build.hasLegacySource) {
                existing.hasLegacySource = true;
            }
        }

        return Array.from(uniqueBuilds.values())
            .sort((a, b) => new Date(b.time) - new Date(a.time));
    }

    /**
     * 查找 APK 对应的 mapping 文件
     * @param {string} branch - 分支目录名
     * @param {string} version - 版本目录名
     * @param {string} apkFile - APK 文件名
     * @returns {{relativePath: string, size: number}|null}
     */
    _findAndroidMapping(branch, version, apkFile) {
        let candidates;
        try {
            candidates = androidMappingCandidates(apkFile);
        } catch {
            return null;
        }

        for (const name of candidates) {
            const fullPath = join(this.buildsDir, 'android', branch, version, name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    return {
                        relativePath: `android/${branch}/${version}/${name}`,
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
     * 迁移旧扁平结构的 APK 文件到版本子目录
     * 旧结构：android/<branch>/xxx.apk（直接放在分支目录下）
     * 新结构：android/<branch>/<version>.<build>/xxx.apk
     *
     * 同时迁移旧结构的 mapping 文件：
     * 旧结构：android/<branch>/mapping/xxx.mapping.txt
     * 新结构：android/<branch>/<version>.<build>/xxx.mapping.zip（不做格式转换，仅移动为 .mapping.zip）
     *
     * @param {string} branchPath 分支目录绝对路径
     */
    async _migrateLegacyFlatApks(branchPath) {
        let entries;
        try {
            entries = fs.readdirSync(branchPath);
        } catch {
            return;
        }
        const apkFiles = entries.filter(f => f.endsWith('.apk'));

        if (apkFiles.length === 0) return;

        for (const apkFile of apkFiles) {
            const apkPath = join(branchPath, apkFile);
            try {
                const fileStat = fs.statSync(apkPath);
                if (!fileStat.isFile()) continue;
            } catch {
                continue;
            }

            const versionDir = androidVersionDirForApk(apkFile);
            if (versionDir === 'unknown') {
                // 文件名无法解析出版本号，跳过迁移但记录日志
                console.warn(`[migration] 无法解析版本号，跳过迁移: ${apkFile}`);
                continue;
            }

            const targetDir = join(branchPath, versionDir);
            const targetPath = join(targetDir, apkFile);

            // 目标已存在则跳过（避免覆盖）
            if (fs.existsSync(targetPath)) continue;

            fs.mkdirSync(targetDir, { recursive: true });
            fs.renameSync(apkPath, targetPath);
            console.log(`[migration] 已迁移 APK: ${apkFile} -> ${versionDir}/${apkFile}`);

            // 尝试迁移旧 mapping 目录下的对应文件
            const apkBase = apkFile.slice(0, -'.apk'.length);
            const legacyMappingPath = join(branchPath, 'mapping', `${apkBase}.mapping.txt`);
            if (fs.existsSync(legacyMappingPath)) {
                const targetMappingPath = join(targetDir, `${apkBase}.mapping.zip`);
                if (!fs.existsSync(targetMappingPath)) {
                    fs.renameSync(legacyMappingPath, targetMappingPath);
                    console.log(`[migration] 已迁移 mapping: mapping/${apkBase}.mapping.txt -> ${versionDir}/${apkBase}.mapping.zip`);
                }
            }
        }
    }

    /**
     * 扫描 Android 构建
     * 目录结构：android/{branch}/{version}/xxx.apk
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

            // --- 旧扁平结构迁移 ---
            // 线上可能残留 android/<branch>/*.apk（无版本子目录），
            // 自动迁移到 android/<branch>/<version>.<build>/ 下，避免静默丢失。
            await this._migrateLegacyFlatApks(branchPath);

            const versions = await readDirSafe(branchPath);

            for (const version of versions) {
                const versionPath = join(branchPath, version);
                const vstat = fs.statSync(versionPath);
                if (!vstat.isDirectory()) continue;

                // 使用 readdirSync 获取所有文件
                const files = fs.readdirSync(versionPath);
                const apkFiles = files.filter(f => f.endsWith('.apk'));

                for (const apkFile of apkFiles) {
                    const apkPath = join(versionPath, apkFile);
                    const parsed = parseApkFilename(apkFile);

                    if (!parsed) continue;

                    const fileStat = fs.statSync(apkPath);
                    const fileSize = fileStat.size;
                    const mtime = fileStat.mtime;

                    // 查找同名 mapping 文件（android/<branch>/<version>/<apkBase>.mapping.zip）
                    const mapping = this._findAndroidMapping(branch, version, apkFile);

                    builds.push({
                        platform: 'android',
                        branch,
                        version: parsed.version,
                        build: parsed.build,
                        appName: parsed.appName,
                        filename: apkFile,
                        // 相对路径（用于下载 URL）
                        relativePath: `android/${branch}/${version}/${apkFile}`,
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

        // 旧 ID 不含 env。同一 version/build 同时出现双身份时，只迁移一次：
        // 磁盘旧布局的实际身份优先；无旧布局可判断时沿用历史默认 production。
        const legacyMigrationTargets = new Map();
        for (const ios of this._iosCache) {
            const key = `${ios.branch}\0${ios.version}\0${ios.build}`;
            const priority = ios.hasLegacySource ? 3 : (ios.env === 'production' ? 2 : 1);
            const existing = legacyMigrationTargets.get(key);
            if (!existing || priority > existing.priority) {
                legacyMigrationTargets.set(key, { ios, priority });
            }
        }
        for (const { ios } of legacyMigrationTargets.values()) {
            const env = ios.env || 'production';
            // 旧 ID 历史默认属于 production。仅有新布局 pre 时无法证明旧行身份，
            // 保留旧行并让 cleanupMissing 软删除，避免把 production 历史改写成 pre。
            if (!ios.hasLegacySource && env !== 'production') continue;
            buildDatabase.migrateLegacyIosBuild({
                branch: ios.branch,
                env,
                version: ios.version,
                build: ios.build,
                dir: buildIosArtifactId(ios.branch, env, ios.version, ios.build),
            });
        }

        // 收集 iOS 构建（dir/id 同源，必须带 env）
        for (const ios of this._iosCache) {
            const env = ios.env || 'production';
            const dir = buildIosArtifactId(ios.branch, env, ios.version, ios.build);
            existingDirs.add(dir);
            allBuilds.push({
                dir,
                platform: 'ios',
                branch: ios.branch,
                env,
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
                env: 'production',
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
        const { days = 3, skipDays = 0, branch = null, platform = null, env = null } = options;

        await this._ensureCache();

        // 构建"虚拟构建"列表 - 将 iOS 和 Android 按时间合并
        let allBuilds = [];

        // 添加 iOS 构建
        if (!platform || platform === 'ios') {
            for (const ios of this._iosCache) {
                if (branch && ios.branch !== branch) continue;
                if (env && ios.env !== env) continue;
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
        const { branch = null, env = 'production' } = options;

        await this._ensureCache();

        // 过滤并获取 iOS 最新
        let iosBuilds = this._iosCache;
        if (branch) {
            iosBuilds = iosBuilds.filter(b => b.branch === branch);
        }
        iosBuilds = iosBuilds.filter(b => b.env === env);
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
        const ios = this._findIosBuild(buildId);
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
        const iosDir = join(this.buildsDir, 'ios');
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
        const bundleId = ios.bundleId || config.iosBundleId || '';
        const env = resolveIosEnv(ios.env, bundleId);
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
                    env,
                    bundleId,
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
        return this._findIosBuild(buildId);
    }

    /**
     * 解析 canonical 或升级前不带 env 的 iOS 构建 ID。
     * 旧 ID 同时命中双身份时，优先真实旧布局来源，否则按历史默认选择 production。
     */
    _findIosBuild(buildId) {
        const exact = this._iosCache.find(build => build.id === buildId);
        if (exact) return exact;

        const legacyMatches = this._iosCache.filter(build =>
            `ios_${build.branch}_${build.version}_${build.build}` === buildId
        );
        return legacyMatches.find(build => build.hasLegacySource) ||
            legacyMatches.find(build => build.env === 'production') ||
            legacyMatches[0] ||
            null;
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
