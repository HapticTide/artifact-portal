#!/bin/bash
#
# 安装/卸载 Artifact Portal 开机自启服务
#
# 使用方式:
#   ./scripts/install-service.sh install   # 安装开机自启
#   ./scripts/install-service.sh uninstall # 卸载开机自启
#   ./scripts/install-service.sh status    # 查看服务状态
#

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_SRC="$PROJECT_DIR/deploy/com.artifact-portal.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.artifact-portal.plist"
SERVICE_NAME="com.artifact-portal"

# 获取用户的 home 目录（用于替换 plist 中的 ~）
USER_HOME="$HOME"

# 从 .env 读取端口配置
ENV_FILE="$PROJECT_DIR/.env"
HTTPS_PORT=8088
HTTP_PORT=8089

if [ -f "$ENV_FILE" ]; then
    port_from_env=$(grep -E "^PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | tr -d '"')
    if [ -n "$port_from_env" ]; then
        HTTPS_PORT="$port_from_env"
        HTTP_PORT=$((HTTPS_PORT + 1))
    fi
fi

install_service() {
    log_info "安装 Artifact Portal 开机自启服务..."
    
    # 检查 plist 模板是否存在
    if [ ! -f "$PLIST_SRC" ]; then
        log_error "找不到 plist 模板: $PLIST_SRC"
        exit 1
    fi
    
    # 创建 LaunchAgents 目录
    mkdir -p "$HOME/Library/LaunchAgents"
    
    # 替换 ~ 为实际路径并复制 plist
    sed "s|~/artifact-portal|$USER_HOME/artifact-portal|g" "$PLIST_SRC" > "$PLIST_DEST"
    
    # 设置权限
    chmod 644 "$PLIST_DEST"
    
    # 先停止已有的服务（如果存在）
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    
    # 先停止 build.sh 管理的进程
    if [ -f "$PROJECT_DIR/.server.pid" ]; then
        log_info "停止现有服务..."
        "$PROJECT_DIR/build.sh" stop 2>/dev/null || true
    fi
    
    # 加载服务
    log_info "加载 LaunchAgent..."
    launchctl load "$PLIST_DEST"
    
    # 等待服务启动
    sleep 3
    
    # 检查服务状态
    if launchctl list | grep -q "$SERVICE_NAME"; then
        log_success "服务安装成功！"
        echo ""
        log_info "服务将在开机时自动启动"
        log_info "使用以下命令管理服务:"
        echo "  launchctl start $SERVICE_NAME  # 启动"
        echo "  launchctl stop $SERVICE_NAME   # 停止"
        echo "  launchctl list | grep $SERVICE_NAME  # 状态"
        echo ""
        log_info "或继续使用 build.sh 管理（但不要同时使用两种方式）:"
        echo "  ./build.sh status"
        echo "  ./build.sh logs"
    else
        log_error "服务加载失败，请检查日志"
        cat "$PROJECT_DIR/server.log" | tail -20
        exit 1
    fi
}

uninstall_service() {
    log_info "卸载 Artifact Portal 开机自启服务..."
    
    if [ -f "$PLIST_DEST" ]; then
        # 停止并卸载服务
        launchctl unload "$PLIST_DEST" 2>/dev/null || true
        
        # 删除 plist 文件
        rm -f "$PLIST_DEST"
        
        log_success "服务已卸载"
        log_info "服务将不再开机自启"
        log_info "你仍可以手动启动: ./build.sh start"
    else
        log_warn "服务未安装"
    fi
}

show_status() {
    echo ""
    echo "======================================"
    echo "  Artifact Portal 服务状态"
    echo "======================================"
    echo ""
    
    # 检查 LaunchAgent
    if [ -f "$PLIST_DEST" ]; then
        log_info "LaunchAgent: 已安装"
        
        if launchctl list | grep -q "$SERVICE_NAME"; then
            local pid=$(launchctl list | grep "$SERVICE_NAME" | awk '{print $1}')
            if [ "$pid" != "-" ]; then
                log_success "服务状态: 运行中 (PID: $pid)"
            else
                log_warn "服务状态: 已加载但未运行"
            fi
        else
            log_warn "服务状态: 未加载"
        fi
    else
        log_info "LaunchAgent: 未安装"
    fi
    
    echo ""
    
    # 检查进程
    if pgrep -f "artifact-portal" > /dev/null; then
        log_info "Node.js 进程: 运行中"
    else
        log_info "Node.js 进程: 未运行"
    fi
    
    # 检查端口
    if lsof -i :$HTTPS_PORT > /dev/null 2>&1; then
        log_info "端口 $HTTPS_PORT (HTTPS): 已监听"
    else
        log_info "端口 $HTTPS_PORT (HTTPS): 未监听"
    fi
    
    if lsof -i :$HTTP_PORT > /dev/null 2>&1; then
        log_info "端口 $HTTP_PORT (HTTP): 已监听"
    else
        log_info "端口 $HTTP_PORT (HTTP): 未监听"
    fi
    
    echo ""
}

# 主逻辑
case "${1:-status}" in
    install)
        install_service
        ;;
    uninstall|remove)
        uninstall_service
        ;;
    status)
        show_status
        ;;
    *)
        echo "用法: $0 {install|uninstall|status}"
        echo ""
        echo "  install   - 安装开机自启服务"
        echo "  uninstall - 卸载开机自启服务"
        echo "  status    - 查看服务状态"
        exit 1
        ;;
esac
