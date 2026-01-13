#!/bin/bash

# ==============================================
# Artifact Portal 一键开发脚本
# 功能：安装依赖 → 启动服务器 → 打开/刷新 Chrome
# ==============================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
PORT=${PORT:-8088}
URL="http://localhost:$PORT"

# 打印带颜色的消息
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║      Artifact Portal 开发环境启动          ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js 未安装，请先安装 Node.js 20+"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    log_warn "Node.js 版本 $(node -v)，建议使用 20+"
fi

log_info "Node.js 版本: $(node -v)"

# 检查并安装依赖
if [ ! -d "node_modules" ]; then
    log_info "首次运行，安装依赖..."
    npm install
    log_success "依赖安装完成"
else
    log_info "依赖已存在，跳过安装"
fi

# 检查端口是否被占用，如果是则关闭
if lsof -i :$PORT -t &> /dev/null; then
    log_warn "端口 $PORT 被占用，正在关闭..."
    lsof -i :$PORT -t | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 启动服务器（后台运行）
log_info "启动服务器..."
npm start &
SERVER_PID=$!

# 等待服务器启动
log_info "等待服务器就绪..."
for i in {1..30}; do
    if curl -s "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
        log_success "服务器已启动 (PID: $SERVER_PID)"
        break
    fi
    sleep 0.5
done

# 检查服务器是否成功启动
if ! curl -s "http://localhost:$PORT/api/health" > /dev/null 2>&1; then
    log_error "服务器启动失败"
    exit 1
fi

# macOS: 尝试刷新已打开的 Chrome 标签，否则打开新标签
if [[ "$OSTYPE" == "darwin"* ]]; then
    # 使用 AppleScript 检查并刷新 Chrome 中已打开的页面
    REFRESH_RESULT=$(osascript <<EOF 2>/dev/null
tell application "Google Chrome"
    set found to false
    repeat with w in windows
        repeat with t in tabs of w
            if URL of t starts with "$URL" then
                set found to true
                tell t to reload
                set active tab index of w to (index of t)
                activate
                return "refreshed"
            end if
        end repeat
    end repeat
    if not found then
        return "not_found"
    end if
end tell
EOF
)
    if [[ "$REFRESH_RESULT" == "refreshed" ]]; then
        log_success "已刷新 Chrome 中的页面"
    else
        log_info "打开 Chrome 浏览器..."
        open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
        log_success "浏览器已打开: $URL"
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux: 直接打开
    log_info "打开浏览器..."
    google-chrome "$URL" 2>/dev/null || xdg-open "$URL"
    log_success "浏览器已打开: $URL"
else
    # Windows (Git Bash / WSL)
    log_info "打开浏览器..."
    start chrome "$URL" 2>/dev/null || explorer.exe "$URL"
    log_success "浏览器已打开: $URL"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  服务器运行中，按 Ctrl+C 停止"
echo "══════════════════════════════════════════════"
echo ""

# 等待服务器进程
wait $SERVER_PID
