/**
 * 路由模块
 * 定义所有 API 和页面路由
 */

import { Router } from 'express';
import { join, dirname } from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import config from './config.js';
import artifactManager from './artifacts.js';
import { iconParser } from './iconParser.js';
import { generateManifest } from './manifest.js';
import { generateQRCode, getQRCacheStats } from './utils/qrcode.js';
import { isPathSafe, isExtensionAllowed } from './utils/fs.js';


const router = Router();

// ============================================
// API 路由
// ============================================

/**
 * GET /api/builds - 获取构建列表
 * Query: days（每次加载天数）, skipDays（跳过天数）, branch, platform
 */
router.get('/api/builds', async (req, res) => {
    try {
        const { days = '3', skipDays = '0', branch, platform } = req.query;

        const result = await artifactManager.getBuilds({
            days: Math.min(parseInt(days) || 3, 30),
            skipDays: parseInt(skipDays) || 0,
            branch: branch || null,
            platform: platform || null,
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
 * Query: branch
 */
router.get('/api/builds/latest', async (req, res) => {
    try {
        const { branch } = req.query;

        const result = await artifactManager.getLatestByPlatform({
            branch: branch || null,
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
 * Query: platform, branch
 */
router.get('/latest', async (req, res) => {
    try {
        const { platform, branch } = req.query;

        const build = await artifactManager.getLatestBuild({
            platform: platform || null,
            branch: branch || null,
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
 *   /download/android/{branch}/{file}
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
        res.setHeader('Content-Length', fileStats.size);

        // 流式传输
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
            : `${config.publicBaseUrl}/api/manifest/${buildId}`;

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
