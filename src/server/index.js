/**
 * Artifact Portal 服务入口
 */

import express from 'express';
import http from 'http';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config, { validateConfig } from './config.js';
import routes from './routes.js';
import { securityHeaders, requestLogger, errorHandler } from './middleware/security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

const pidFilePath = join(projectRoot, '.server.pid');

// 创建 Express 应用
const app = express();

// 中间件
app.use(securityHeaders);
app.use(requestLogger);
app.use(express.json());

// 静态文件（前端）
app.use(express.static(join(__dirname, '../web')));

// Tauri 桌面应用自动更新静态分发（仅当配置 UPDATER_DIR 时挂载，否则此路由不存在，对移动端门户零影响）：
// 哑静态服务 latest.json + 版本化产物（.app.tar.gz/.sig/-setup.exe/.AppImage），供 tauri-plugin-updater 拉取。
// 走在 SPA fallback 之前；完整性由客户端 minisign 验签兜底，本路由不鉴权、不改字节、不做业务语义。
if (config.updaterDir) {
    app.use('/updater', express.static(config.updaterDir));
}

// API 路由
app.use(routes);

// 前端路由 fallback（SPA）
app.get('*', (req, res) => {
    // 非 API / 下载 / 二维码 / updater 静态请求都返回 index.html；其余未命中返回 404
    if (
        !req.path.startsWith('/api/') &&
        !req.path.startsWith('/download/') &&
        !req.path.startsWith('/qr') &&
        !req.path.startsWith('/updater/')
    ) {
        res.sendFile(join(__dirname, '../web/index.html'));
    } else {
        res.status(404).json({ success: false, error: 'Not Found' });
    }
});

// 错误处理
app.use(errorHandler);

// 创建 HTTP 服务器
const server = http.createServer(app);

// 启动服务
server.listen(config.port, config.host, () => {
    // 写入 PID 文件
    writeFileSync(pidFilePath, process.pid.toString());

    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║        Artifact Portal 已启动              ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log(`  🌐 访问地址: http://localhost:${config.port}`);
    console.log(`  🔗 公网地址: ${config.publicBaseUrl}`);
    console.log(`  📁 构建目录: ${config.buildsDir}`);
    console.log('');

    // 验证配置并输出警告
    const warnings = validateConfig();
    if (warnings.length > 0) {
        console.log('配置警告:');
        warnings.forEach(w => console.log(`  ${w}`));
        console.log('');
    }

    console.log('  API 端点:');
    console.log('    GET /api/builds         - 获取构建列表');
    console.log('    GET /api/builds/latest  - 获取最新构建');
    console.log('    GET /api/health         - 健康检查');
    console.log('    GET /latest             - 跳转到最新构建');
    console.log('    GET /qr?text=...        - 生成二维码');
    console.log('');
});

// 优雅关闭
function cleanup() {
    // 删除 PID 文件
    try {
        if (existsSync(pidFilePath)) {
            unlinkSync(pidFilePath);
        }
    } catch (e) {
        // 忽略
    }
}

process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，正在关闭服务...');
    cleanup();
    server.close(() => {
        console.log('服务已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n收到 SIGINT 信号，正在关闭服务...');
    cleanup();
    server.close(() => {
        console.log('服务已关闭');
        process.exit(0);
    });
});

export default app;
