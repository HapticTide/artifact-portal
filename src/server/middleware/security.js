/**
 * 安全中间件
 */

/**
 * 设置安全响应头
 */
export function securityHeaders(req, res, next) {
    // 防止 MIME 类型嗅探
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // 防止点击劫持
    res.setHeader('X-Frame-Options', 'DENY');

    // XSS 保护
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // 禁用缓存敏感信息（API 响应）
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }

    next();
}

/**
 * 请求日志中间件
 */
export function requestLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? 'warn' : 'info';

        console[logLevel](
            `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
        );
    });

    next();
}

/**
 * 错误处理中间件
 */
export function errorHandler(err, req, res, next) {
    console.error('未处理的错误:', err);

    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production'
            ? '服务器内部错误'
            : err.message,
    });
}
