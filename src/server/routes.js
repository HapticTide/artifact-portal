/**
 * 路由模块
 * 定义所有 API 和页面路由
 */

import { Router } from 'express';
import { join, dirname } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import config from './config.js';
import artifactManager from './artifacts.js';
import { iconParser } from './iconParser.js';
import { generateManifest } from './manifest.js';
import { generateQRCode, getQRCacheStats } from './utils/qrcode.js';
import { isPathSafe, isExtensionAllowed } from './utils/fs.js';
import {
    buildAndroidMappingUploadTarget,
    buildAndroidUploadTarget,
    buildIosUploadTarget,
    normalizeIosEnv,
    validateAndroidMappingUploadFile,
    validateAndroidUploadFile,
    validateIosUploadFile,
} from './upload.js';
import { apkFilenameHasVersionBuild } from './androidMapping.js';


const router = Router();

function isUploadAuthorized(req) {
    if (!config.uploadToken) {
        return false;
    }

    const authorization = req.get('authorization') || '';
    const bearerToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
    const headerToken = req.get('x-upload-token') || '';

    return bearerToken === config.uploadToken || headerToken === config.uploadToken;
}

async function writeRequestBodyToFile(req, targetPath) {
    let receivedBytes = 0;
    const output = createWriteStream(targetPath, { flags: 'wx' });

    req.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > config.uploadMaxBytes) {
            req.destroy(new Error('上传文件超过大小限制'));
        }
    });

    await pipeline(req, output);
    return receivedBytes;
}

// ============================================
// API 路由
// ============================================

/**
 * POST /api/upload/ios - 上传 iOS IPA 文件
 * Query: branch, version, filename, env? (pre|production；兼容 sandbox，缺省 production)
 * Auth: Authorization: Bearer <UPLOAD_TOKEN>
 */
router.post('/api/upload/ios', async (req, res) => {
    let tempPath = null;

    try {
        if (!config.uploadToken) {
            return res.status(503).json({
                success: false,
                error: '上传功能未配置',
            });
        }

        if (!isUploadAuthorized(req)) {
            return res.status(401).json({
                success: false,
                error: '上传鉴权失败',
            });
        }

        const { branch, version, filename, env } = req.query;
        const uploadFilename = filename || req.get('x-artifact-filename');

        if (!branch || !version || !uploadFilename) {
            return res.status(400).json({
                success: false,
                error: '缺少 branch、version 或 filename 参数',
            });
        }

        if (!validateIosUploadFile(uploadFilename)) {
            return res.status(400).json({
                success: false,
                error: '只允许上传 .ipa 文件',
            });
        }

        let target;
        try {
            target = buildIosUploadTarget({
                buildsDir: artifactManager.buildsDir,
                branch,
                version,
                filename: uploadFilename,
                env,
            });
        } catch (validationErr) {
            return res.status(400).json({
                success: false,
                error: validationErr.message || '参数非法',
            });
        }

        const contentLength = parseInt(req.get('content-length') || '0');
        if (contentLength > config.uploadMaxBytes) {
            return res.status(413).json({
                success: false,
                error: '上传文件超过大小限制',
            });
        }

        const uploadTempDir = join(artifactManager.buildsDir, '.uploads');
        await mkdir(uploadTempDir, { recursive: true });
        await mkdir(target.directory, { recursive: true });

        tempPath = join(uploadTempDir, `${Date.now()}-${process.pid}-${target.filename}.tmp`);
        const size = await writeRequestBodyToFile(req, tempPath);
        if (size <= 0) {
            await rm(tempPath, { force: true });
            tempPath = null;
            return res.status(400).json({
                success: false,
                error: '上传文件为空',
            });
        }

        await rename(tempPath, target.absolutePath);
        tempPath = null;

        artifactManager.invalidateCache();

        res.json({
            success: true,
            data: {
                platform: 'ios',
                branch: target.branch,
                env: target.env,
                version: target.version,
                filename: target.filename,
                size,
                relativePath: target.relativePath,
                downloadUrl: `${config.publicBaseUrl}/download/${target.relativePath}`,
            },
        });
    } catch (err) {
        if (tempPath) {
            await rm(tempPath, { force: true }).catch(() => {});
        }

        console.error('上传 iOS 包失败:', err);
        res.status(500).json({
            success: false,
            error: err.message || '上传失败',
        });
    }
});

/**
 * POST /api/upload/android - 上传 Android APK 文件
 * Query: branch, filename
 * Auth: Authorization: Bearer <UPLOAD_TOKEN>
 */
router.post('/api/upload/android', async (req, res) => {
    let tempPath = null;

    try {
        if (!config.uploadToken) {
            return res.status(503).json({
                success: false,
                error: '上传功能未配置',
            });
        }

        if (!isUploadAuthorized(req)) {
            return res.status(401).json({
                success: false,
                error: '上传鉴权失败',
            });
        }

        const { branch, filename } = req.query;
        const uploadFilename = filename || req.get('x-artifact-filename');

        if (!branch || !uploadFilename) {
            return res.status(400).json({
                success: false,
                error: '缺少 branch 或 filename 参数',
            });
        }

        if (!validateAndroidUploadFile(uploadFilename)) {
            return res.status(400).json({
                success: false,
                error: '只允许上传 .apk 文件',
            });
        }

        // 文件名必须同时携带版本号与 build 号（如 xxx_v1.2.0.123_...apk），
        // 否则无法确定存储目录，构建会在页面上"消失"却无法排查原因
        if (!apkFilenameHasVersionBuild(uploadFilename)) {
            return res.status(400).json({
                success: false,
                error: 'APK 文件名必须包含版本号和 build 号（格式如 {AppName}_v{version}.{build}_..），否则无法归档到对应版本目录',
            });
        }

        const contentLength = parseInt(req.get('content-length') || '0');
        if (contentLength > config.uploadMaxBytes) {
            return res.status(413).json({
                success: false,
                error: '上传文件超过大小限制',
            });
        }

        const target = buildAndroidUploadTarget({
            buildsDir: artifactManager.buildsDir,
            branch,
            filename: uploadFilename,
        });

        const uploadTempDir = join(artifactManager.buildsDir, '.uploads');
        await mkdir(uploadTempDir, { recursive: true });
        await mkdir(target.directory, { recursive: true });

        tempPath = join(uploadTempDir, `${Date.now()}-${process.pid}-${target.filename}.tmp`);
        const size = await writeRequestBodyToFile(req, tempPath);
        if (size <= 0) {
            await rm(tempPath, { force: true });
            tempPath = null;
            return res.status(400).json({
                success: false,
                error: '上传文件为空',
            });
        }

        await rename(tempPath, target.absolutePath);
        tempPath = null;

        artifactManager.invalidateCache();

        res.json({
            success: true,
            data: {
                platform: 'android',
                branch: target.branch,
                filename: target.filename,
                size,
                relativePath: target.relativePath,
                downloadUrl: `${config.publicBaseUrl}/download/${target.relativePath}`,
            },
        });
    } catch (err) {
        if (tempPath) {
            await rm(tempPath, { force: true }).catch(() => {});
        }

        console.error('上传 Android 包失败:', err);
        res.status(500).json({
            success: false,
            error: err.message || '上传失败',
        });
    }
});

/**
 * POST /api/upload/android/mapping - 上传 Android mapping（混淆映射）文件
 * Query: branch, apk（对应的 APK 文件名）, filename（可选，仅支持 .zip，默认 mapping.zip）
 * Auth: Authorization: Bearer <UPLOAD_TOKEN>
 *
 * 存储路径：android/<branch>/<version>/<apk 文件名去掉 .apk>.mapping.zip
 * version 从 apk 文件名解析，与对应 APK 同目录。必须先上传对应的 APK，否则返回 404。
 */
router.post('/api/upload/android/mapping', async (req, res) => {
    let tempPath = null;

    try {
        if (!config.uploadToken) {
            return res.status(503).json({
                success: false,
                error: '上传功能未配置',
            });
        }

        if (!isUploadAuthorized(req)) {
            return res.status(401).json({
                success: false,
                error: '上传鉴权失败',
            });
        }

        const { branch, apk } = req.query;
        const apkFilename = apk || req.get('x-artifact-apk');
        const uploadFilename = req.query.filename || req.get('x-artifact-filename') || 'mapping.zip';

        if (!branch || !apkFilename) {
            return res.status(400).json({
                success: false,
                error: '缺少 branch 或 apk 参数',
            });
        }

        if (!validateAndroidUploadFile(apkFilename)) {
            return res.status(400).json({
                success: false,
                error: 'apk 参数必须是合法的 .apk 文件名',
            });
        }

        // apk 参数同样决定 mapping 的存储目录，必须携带版本号和 build 号
        if (!apkFilenameHasVersionBuild(apkFilename)) {
            return res.status(400).json({
                success: false,
                error: 'apk 参数文件名必须包含版本号和 build 号（格式如 {AppName}_v{version}.{build}_..），否则无法归档到对应版本目录',
            });
        }

        if (!validateAndroidMappingUploadFile(uploadFilename)) {
            return res.status(400).json({
                success: false,
                error: 'mapping 文件只允许 .zip 或 .txt 格式',
            });
        }

        const contentLength = parseInt(req.get('content-length') || '0');
        if (contentLength > config.uploadMaxBytes) {
            return res.status(413).json({
                success: false,
                error: '上传文件超过大小限制',
            });
        }

        const target = buildAndroidMappingUploadTarget({
            buildsDir: artifactManager.buildsDir,
            branch,
            apkFilename,
            filename: uploadFilename,
        });

        // mapping 与 APK 一一对应，APK 不存在时拒绝，避免产生孤立文件
        const apkAbsolutePath = join(artifactManager.buildsDir, target.apkRelativePath);
        try {
            const apkStat = await stat(apkAbsolutePath);
            if (!apkStat.isFile()) {
                throw new Error('Not a file');
            }
        } catch {
            // 完整存储路径只打服务端日志，响应体使用通用文案，避免泄漏文件系统布局
            console.warn(`mapping 上传失败：对应 APK 不存在 ${target.apkRelativePath}`);
            return res.status(404).json({
                success: false,
                error: '对应的 APK 不存在，请先上传 APK',
            });
        }

        const uploadTempDir = join(artifactManager.buildsDir, '.uploads');
        await mkdir(uploadTempDir, { recursive: true });
        await mkdir(target.directory, { recursive: true });

        tempPath = join(uploadTempDir, `${Date.now()}-${process.pid}-${target.filename}.tmp`);
        const size = await writeRequestBodyToFile(req, tempPath);
        if (size <= 0) {
            await rm(tempPath, { force: true });
            tempPath = null;
            return res.status(400).json({
                success: false,
                error: '上传文件为空',
            });
        }

        await rename(tempPath, target.absolutePath);
        tempPath = null;

        artifactManager.invalidateCache();

        res.json({
            success: true,
            data: {
                platform: 'android',
                type: 'mapping',
                branch: target.branch,
                apk: target.apkFilename,
                filename: target.filename,
                size,
                relativePath: target.relativePath,
                downloadUrl: `${config.publicBaseUrl}/download/${target.relativePath}`,
            },
        });
    } catch (err) {
        if (tempPath) {
            await rm(tempPath, { force: true }).catch(() => {});
        }

        console.error('上传 Android mapping 失败:', err);
        res.status(500).json({
            success: false,
            error: err.message || '上传失败',
        });
    }
});

/**
 * GET /api/builds - 获取构建列表
 * Query: days（每次加载天数）, skipDays（跳过天数）, branch, platform, env
 */
router.get('/api/builds', async (req, res) => {
    try {
        const { days = '3', skipDays = '0', branch, platform, env } = req.query;
        let normalizedEnv = null;
        if (env !== undefined) {
            try {
                normalizedEnv = normalizeIosEnv(env);
            } catch (validationErr) {
                return res.status(400).json({ success: false, error: validationErr.message });
            }
        }

        const result = await artifactManager.getBuilds({
            days: Math.min(parseInt(days) || 3, 30),
            skipDays: parseInt(skipDays) || 0,
            branch: branch || null,
            platform: platform || null,
            env: normalizedEnv,
        });

        res.json({
            success: true,
            data: result,
        });
    } catch (err) {
        console.error('获取构建列表失败:', err);
        res.status(500).json({
            success: false,
            error: '获取构建列表失败',
        });
    }
});

/**
 * GET /api/builds/latest - 获取最新构建（分平台）
 * 同时返回 iOS 和 Android 的最新构建
 * Query: branch, env（缺省 production；sandbox 兼容为 pre）
 */
router.get('/api/builds/latest', async (req, res) => {
    try {
        const { branch, env } = req.query;
        let normalizedEnv;
        try {
            normalizedEnv = normalizeIosEnv(env);
        } catch (validationErr) {
            return res.status(400).json({ success: false, error: validationErr.message });
        }

        const result = await artifactManager.getLatestByPlatform({
            branch: branch || null,
            env: normalizedEnv,
        });

        res.json({
            success: true,
            data: result,
        });
    } catch (err) {
        console.error('获取最新构建失败:', err);
        res.status(500).json({
            success: false,
            error: '获取最新构建失败',
        });
    }
});

/**
 * GET /api/builds/:buildDir - 获取单个构建详情
 */
router.get('/api/builds/:buildDir', async (req, res) => {
    try {
        const { buildDir } = req.params;

        // 安全检查
        if (!isPathSafe(buildDir)) {
            return res.status(400).json({
                success: false,
                error: '无效的构建目录',
            });
        }

        const build = await artifactManager.getBuild(buildDir);

        if (!build) {
            return res.status(404).json({
                success: false,
                error: '构建不存在',
            });
        }

        res.json({
            success: true,
            data: build,
        });
    } catch (err) {
        console.error('获取构建详情失败:', err);
        res.status(500).json({
            success: false,
            error: '获取构建详情失败',
        });
    }
});

/**
 * GET /api/builds/:buildId/icon - 获取构建图标
 * 优先级：IPA 解析 → 全局配置 → 默认 404
 */
router.get('/api/builds/:buildId/icon', async (req, res) => {
    try {
        const { buildId } = req.params;

        // 获取 iOS 构建信息
        const buildInfo = await artifactManager.getIosBuildInfo(buildId);

        if (buildInfo) {
            // 获取 IPA 所在目录
            const ipaDir = dirname(buildInfo.absolutePath);

            // 尝试从 IPA 解析图标
            const iconInfo = await iconParser.getIcon(ipaDir);
            if (iconInfo) {
                res.set('Content-Type', iconInfo.type);
                res.set('Cache-Control', 'public, max-age=86400');
                return createReadStream(iconInfo.path).pipe(res);
            }
        }

        // 无图标，返回 404（不缓存 404 响应）
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.status(404).json({
            success: false,
            error: '图标不存在',
        });
    } catch (err) {
        console.error('获取构建图标失败:', err);
        res.status(500).json({
            success: false,
            error: '获取构建图标失败',
        });
    }
});

/**
 * GET /api/branches - 获取所有分支列表
 */
router.get('/api/branches', async (req, res) => {
    try {
        const branches = await artifactManager.getBranches();

        res.json({
            success: true,
            data: branches,
        });
    } catch (err) {
        console.error('获取分支列表失败:', err);
        res.status(500).json({
            success: false,
            error: '获取分支列表失败',
        });
    }
});

/**
 * GET /api/stats/size - 获取包体积统计数据
 * Query: limit (默认 30 个构建), platform (ios/android/all)
 */
router.get('/api/stats/size', async (req, res) => {
    try {
        const { limit = '30', platform = 'all' } = req.query;
        const limitNum = Math.min(parseInt(limit) || 30, 100);

        const stats = await artifactManager.getSizeStats({
            limit: limitNum,
            platform: platform,
        });

        res.json({
            success: true,
            data: stats,
        });
    } catch (err) {
        console.error('获取包体积统计失败:', err);
        res.status(500).json({
            success: false,
            error: '获取包体积统计失败',
        });
    }
});

/**
 * GET /api/health - 健康检查
 */
router.get('/api/health', async (req, res) => {
    try {
        const builds = await artifactManager.getBuilds({ limit: 1 });
        const diskStats = await artifactManager.getDiskStats();
        const qrStats = getQRCacheStats();

        res.json({
            status: 'ok',
            buildsCount: builds.total,
            latestBuild: builds.builds[0]?.dir || null,
            diskUsage: diskStats.usageFormatted,
            diskWarning: diskStats.warning,
            isHttps: config.isHttps,
            qrCacheSize: qrStats.size,
            uptime: Math.floor(process.uptime()),
        });
    } catch (err) {
        console.error('健康检查失败:', err);
        res.status(500).json({
            status: 'error',
            error: err.message,
        });
    }
});

/**
 * GET /api/config - 获取前端需要的配置
 */
router.get('/api/config', (req, res) => {
    res.json({
        success: true,
        data: {
            appName: config.appName,
            appIcon: config.appIcon,
            publicBaseUrl: config.publicBaseUrl,
            // iOS plist 代理配置
            iosPlistProxyUrl: config.iosPlistProxyUrl,
            iosPlistLogo: config.iosPlistLogo,
            iosDisplayName: config.iosDisplayName,
        },
    });
});

// ============================================
// 跳转路由
// ============================================

/**
 * GET /latest - 跳转到最新构建
 * Query: platform, branch, env（iOS 缺省 production；sandbox 兼容为 pre）
 */
router.get('/latest', async (req, res) => {
    try {
        const { platform, branch, env } = req.query;
        let normalizedEnv;
        try {
            normalizedEnv = normalizeIosEnv(env);
        } catch (validationErr) {
            return res.status(400).send(validationErr.message);
        }

        const build = await artifactManager.getLatestBuild({
            platform: platform || null,
            branch: branch || null,
            env: normalizedEnv,
        });

        if (!build) {
            // 返回友好的 404 页面
            return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>未找到构建</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
            .container { text-align: center; padding: 40px; }
            h1 { color: #333; margin-bottom: 16px; }
            p { color: #666; margin-bottom: 24px; }
            a { color: #F4A507; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>😕 暂无符合条件的构建</h1>
            <p>未找到${platform ? ` ${platform.toUpperCase()} 平台的` : ''}${branch ? ` ${branch} 分支的` : ''}构建</p>
            <a href="/">返回首页</a>
          </div>
        </body>
        </html>
      `);
        }

        // 302 跳转到构建详情页
        res.redirect(302, `/#build=${build.dir}`);
    } catch (err) {
        console.error('/latest 跳转失败:', err);
        res.status(500).send('服务器错误');
    }
});

// ============================================
// 下载路由
// ============================================

/**
 * GET /download/* - 下载构建文件
 * 支持路径格式：
 *   /download/iOS/{branch}/{version}/{file}
 *   /download/android/{branch}/{version}/{file}
 */
router.get('/download/*', async (req, res) => {
    try {
        // 获取完整路径
        const relativePath = req.params[0];

        if (!relativePath) {
            return res.status(400).json({
                success: false,
                error: '缺少文件路径',
            });
        }

        // 安全检查：防止路径遍历
        if (relativePath.includes('..') || relativePath.includes('//')) {
            return res.status(403).json({
                success: false,
                error: '非法路径',
            });
        }

        // 获取文件名
        const fileName = relativePath.split('/').pop();

        // 安全检查：扩展名
        if (!isExtensionAllowed(fileName, config.security.allowedExtensions)) {
            return res.status(403).json({
                success: false,
                error: '不允许下载该类型的文件',
            });
        }

        // 构造绝对路径
        const filePath = join(artifactManager.buildsDir, relativePath);

        // 检查文件是否存在
        let fileStats;
        try {
            fileStats = await stat(filePath);
            if (!fileStats.isFile()) {
                throw new Error('Not a file');
            }
        } catch {
            return res.status(404).json({
                success: false,
                error: '文件不存在',
            });
        }

        // 设置响应头
        const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
        const mimeTypes = {
            '.ipa': 'application/octet-stream',
            '.apk': 'application/vnd.android.package-archive',
            '.plist': 'application/xml',
            '.json': 'application/json',
            '.txt': 'text/plain',
            '.zip': 'application/zip',
        };

        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Accept-Ranges', 'bytes');

        const range = req.headers.range;

        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            let start = match && match[1] ? parseInt(match[1], 10) : 0;
            let end = match && match[2] ? parseInt(match[2], 10) : fileStats.size - 1;

            // 支持 suffix range，例如 bytes=-1024，iOS 下载器可能会用这种形式探测文件尾部。
            if (match && !match[1] && match[2]) {
                const suffixLength = parseInt(match[2], 10);
                start = Math.max(fileStats.size - suffixLength, 0);
                end = fileStats.size - 1;
            }

            const hasStartOrEnd = Boolean(match && (match[1] || match[2]));

            if (!match || !hasStartOrEnd || Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileStats.size) {
                res.setHeader('Content-Range', `bytes */${fileStats.size}`);
                return res.status(416).end();
            }

            end = Math.min(end, fileStats.size - 1);
            const chunkSize = end - start + 1;

            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileStats.size}`);
            res.setHeader('Content-Length', chunkSize);

            const stream = createReadStream(filePath, { start, end });
            stream.pipe(res);

            stream.on('error', (err) => {
                console.error('文件读取错误:', err);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: '文件读取失败',
                    });
                }
            });

            return;
        }

        res.setHeader('Content-Length', fileStats.size);

        // 流式传输完整文件
        const stream = createReadStream(filePath);
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('文件读取错误:', err);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: '文件读取失败',
                });
            }
        });
    } catch (err) {
        console.error('下载失败:', err);
        res.status(500).json({
            success: false,
            error: '下载失败',
        });
    }
});

/**
 * GET /api/manifest/:buildId - 动态生成 manifest.plist
 * 用于没有静态 manifest.plist 的 iOS 构建
 */
router.get('/api/manifest/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;

        // 获取构建信息
        const buildInfo = await artifactManager.getIosBuildInfo(buildId);

        if (!buildInfo) {
            return res.status(404).json({
                success: false,
                error: '构建不存在',
            });
        }

        // 如果有静态 manifest，重定向到静态文件
        if (buildInfo.hasStaticManifest) {
            return res.redirect(302, `/download/${buildInfo.manifestPath}`);
        }

        // 生成动态 manifest
        const ipaUrl = `${config.publicBaseUrl}/download/${buildInfo.relativePath}`;

        // 优先使用构建中解析到的 appName，否则回退到配置
        const displayName = buildInfo.appName || config.iosDisplayName;

        // 优先使用从 IPA 解析的 bundleId，否则回退到配置
        const bundleId = buildInfo.bundleId || config.iosBundleId;

        const manifest = generateManifest({
            ipaUrl,
            bundleId: bundleId,
            version: buildInfo.version,
            build: buildInfo.build,
            displayName: displayName,
            // 可选：添加图标 URL（如果配置了的话）
            iconUrl: config.appIcon ? `${config.publicBaseUrl}${config.appIcon}` : null,
        });

        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Content-Disposition', 'inline; filename="manifest.plist"');
        res.send(manifest);
    } catch (err) {
        console.error('生成 manifest 失败:', err);
        res.status(500).json({
            success: false,
            error: '生成 manifest 失败',
        });
    }
});

// ============================================
// 二维码路由
// ============================================

/**
 * GET /qr - 生成二维码
 * Query: text, size
 */
router.get('/qr', async (req, res) => {
    try {
        const { text, size = '200' } = req.query;

        if (!text) {
            return res.status(400).json({
                success: false,
                error: '缺少 text 参数',
            });
        }

        const width = Math.min(Math.max(parseInt(size) || 200, 100), 500);

        const buffer = await generateQRCode(text, { width });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(buffer);
    } catch (err) {
        console.error('二维码生成失败:', err);
        res.status(500).json({
            success: false,
            error: '二维码生成失败',
        });
    }
});

// ============================================
// 辅助 API
// ============================================

/**
 * GET /api/ios-install-url/:buildId - 获取 iOS 安装 URL
 * 支持新的 buildId 格式
 */
router.get('/api/ios-install-url/:buildId', async (req, res) => {
    try {
        const { buildId } = req.params;

        const build = await artifactManager.getBuild(buildId);

        if (!build || !build.platforms.ios) {
            return res.status(404).json({
                success: false,
                error: '未找到 iOS 构建',
            });
        }

        const ios = build.platforms.ios;

        // manifest URL（静态或动态）
        const manifestUrl = ios.hasStaticManifest
            ? `${config.publicBaseUrl}/download/${ios.manifest}`
            : `${config.publicBaseUrl}/api/manifest/${build.id}`;

        const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

        res.json({
            success: true,
            data: {
                installUrl,
                manifestUrl,
            },
        });
    } catch (err) {
        console.error('获取 iOS 安装 URL 失败:', err);
        res.status(500).json({
            success: false,
            error: '获取安装 URL 失败',
        });
    }
});

export default router;
