#!/bin/bash
#
# Artifact Portal 一键构建脚本
# 用于在打包机上快速部署和启动服务
#
# 使用方式:
#   ./build.sh          # 安装依赖并启动服务
#   ./build.sh install  # 仅安装依赖
#   ./build.sh start    # 仅启动服务
#   ./build.sh restart  # 重启服务
#   ./build.sh stop     # 停止服务
#   ./build.sh status   # 查看服务状态
#   ./build.sh logs     # 查看实时日志
#

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 项目配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="artifact-portal"
PID_FILE="$SCRIPT_DIR/.server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
NODE_REQUIRED="20"

# 加载 nvm（如果存在）
load_nvm() {
    # 尝试加载 nvm
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        source "$NVM_DIR/nvm.sh"
        
        # 如果存在 .nvmrc，自动切换版本
        if [ -f "$SCRIPT_DIR/.nvmrc" ]; then
            local required_version=$(cat "$SCRIPT_DIR/.nvmrc" | tr -d '[:space:]')
            if ! nvm ls "$required_version" &>/dev/null; then
                log_info "安装 Node.js $required_version..."
                nvm install "$required_version"
            fi
            nvm use "$required_version" &>/dev/null
        fi
        return 0
    fi
    return 1
}

# 日志函数
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

# 检查 Node.js 版本
check_node() {
    # 优先尝试加载 nvm
    if load_nvm; then
        log_info "使用 nvm 管理 Node.js"
    fi
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装"
        log_info "请安装 nvm 并在项目目录执行: nvm install"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt "$NODE_REQUIRED" ]; then
        log_error "Node.js 版本过低 (当前: v$(node -v | sed 's/v//')，需要: v$NODE_REQUIRED+)"
        if [ -f "$SCRIPT_DIR/.nvmrc" ]; then
            log_info "请执行: nvm install && nvm use"
        fi
        exit 1
    fi
    
    log_info "Node.js 版本: $(node -v)"
}

# 检查 .env 文件
check_env() {
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        log_warn ".env 文件不存在"
        if [ -f "$SCRIPT_DIR/.env.example" ]; then
            log_info "从 .env.example 复制默认配置..."
            cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
            log_warn "请根据实际环境修改 .env 配置"
        else
            log_error "找不到 .env.example 模板文件"
            exit 1
        fi
    fi
}

# 安装依赖
install_deps() {
    log_info "安装项目依赖..."
    cd "$SCRIPT_DIR"
    
    if [ -f "package-lock.json" ]; then
        npm ci --production
    else
        npm install --production
    fi
    
    log_success "依赖安装完成"
}

# 获取服务 PID
get_pid() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            echo "$pid"
            return 0
        fi
    fi
    echo ""
    return 1
}

# 启动服务
start_server() {
    local pid=$(get_pid)
    if [ -n "$pid" ]; then
        log_warn "服务已在运行 (PID: $pid)"
        return 0
    fi
    
    log_info "启动 $PROJECT_NAME 服务..."
    cd "$SCRIPT_DIR"
    
    # 后台启动，输出到日志文件
    nohup node src/server/index.js > "$LOG_FILE" 2>&1 &
    local new_pid=$!
    echo "$new_pid" > "$PID_FILE"
    
    # 等待服务启动
    sleep 2
    
    if ps -p "$new_pid" > /dev/null 2>&1; then
        # 读取端口
        local port=$(grep -o 'PORT=[0-9]*' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8088")
        log_success "服务已启动 (PID: $new_pid)"
        log_info "访问地址: http://localhost:$port"
    else
        log_error "服务启动失败，请查看日志: $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
}

# 停止服务
stop_server() {
    local pid=$(get_pid)
    if [ -z "$pid" ]; then
        log_warn "服务未在运行"
        rm -f "$PID_FILE"
        return 0
    fi
    
    log_info "停止服务 (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    
    # 等待进程退出
    local count=0
    while ps -p "$pid" > /dev/null 2>&1 && [ $count -lt 10 ]; do
        sleep 1
        ((count++))
    done
    
    if ps -p "$pid" > /dev/null 2>&1; then
        log_warn "服务未响应，强制终止..."
        kill -9 "$pid" 2>/dev/null || true
    fi
    
    rm -f "$PID_FILE"
    log_success "服务已停止"
}

# 重启服务
restart_server() {
    stop_server
    sleep 1
    start_server
}

# 查看服务状态
show_status() {
    local pid=$(get_pid)
    if [ -n "$pid" ]; then
        log_success "服务正在运行 (PID: $pid)"
        
        # 显示更多信息
        local port=$(grep -o 'PORT=[0-9]*' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8088")
        local url=$(grep -o 'PUBLIC_BASE_URL=.*' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "http://localhost:$port")
        
        echo ""
        echo "  端口: $port"
        echo "  地址: $url"
        echo "  日志: $LOG_FILE"
        echo ""
        
        # 显示内存使用
        if command -v ps &> /dev/null; then
            local mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
            echo "  内存: $mem"
        fi
    else
        log_warn "服务未在运行"
    fi
}

# 查看日志
show_logs() {
    if [ -f "$LOG_FILE" ]; then
        log_info "实时日志 (Ctrl+C 退出)..."
        tail -f "$LOG_FILE"
    else
        log_warn "日志文件不存在"
    fi
}

# 完整构建流程
full_build() {
    echo ""
    echo "======================================"
    echo "  Artifact Portal 构建部署"
    echo "======================================"
    echo ""
    
    check_node
    check_env
    install_deps
    start_server
    
    echo ""
    log_success "部署完成！"
}

# 主函数
main() {
    local command="${1:-}"
    
    case "$command" in
        install)
            check_node
            install_deps
            ;;
        start)
            check_node
            check_env
            start_server
            ;;
        stop)
            stop_server
            ;;
        restart)
            check_node
            check_env
            restart_server
            ;;
        status)
            show_status
            ;;
        logs)
            show_logs
            ;;
        ""|build)
            full_build
            ;;
        *)
            echo "用法: $0 {install|start|stop|restart|status|logs}"
            echo ""
            echo "命令说明:"
            echo "  install  - 仅安装依赖"
            echo "  start    - 启动服务"
            echo "  stop     - 停止服务"
            echo "  restart  - 重启服务"
            echo "  status   - 查看服务状态"
            echo "  logs     - 查看实时日志"
            echo ""
            echo "无参数执行完整构建流程 (安装 + 启动)"
            exit 1
            ;;
    esac
}

# 入口
main "$@"
