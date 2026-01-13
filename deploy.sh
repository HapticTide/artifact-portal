#!/bin/bash
#
# Artifact Portal 远程部署脚本
# 用于将项目部署到远程打包机
#
# 使用方式:
#   ./deploy.sh                    # 交互式部署
#   ./deploy.sh -y                 # 跳过确认（CI/CD 模式）
#   ./deploy.sh user@192.168.1.100 # 直接指定目标
#
# 配置文件:
#   deploy.local     - 本地配置（不上传 Git，包含敏感信息）
#   deploy.local.example - 配置模板
#

set -e

# 保存原始参数用于检测 -y 标志
SCRIPT_ARGS=("$@")

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 日志函数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "\n${CYAN}${BOLD}==> $1${NC}"; }

# 脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =====================================
# 默认配置（可被 deploy.local 覆盖）
# =====================================
PROJECT_NAME="artifact-portal"
DEPLOY_TARGET=""                        # SSH 目标 (user@host)
DEPLOY_DIR="\$HOME/$PROJECT_NAME"       # 远程部署目录
BUILDS_DIR=""                           # 构建产物目录
APP_NAME="Artifact Portal"              # 应用名称
APP_ICON=""                             # 应用图标
PORT=8088                               # 服务端口
HOST="0.0.0.0"                          # 监听地址
PUBLIC_BASE_URL=""                      # 公网访问地址

MAX_BUILDS=50                           # 最大构建数
MAX_AGE_DAYS=30                         # 最大保留天数
DISK_THRESHOLD_GB=50                    # 磁盘告警阈值

# =====================================
# 加载本地配置文件
# =====================================
LOCAL_CONFIG="$SCRIPT_DIR/deploy.local"
if [ -f "$LOCAL_CONFIG" ]; then
    log_info "加载本地配置: $LOCAL_CONFIG"
    # shellcheck source=/dev/null
    source "$LOCAL_CONFIG"
else
    log_warn "未找到本地配置文件 deploy.local"
    log_info "将使用默认配置或交互式输入"
    log_info "可复制 deploy.local.example 为 deploy.local 并修改"
fi

# 兼容旧配置变量名
REMOTE_DIR="${DEPLOY_DIR:-\$HOME/$PROJECT_NAME}"

# 需要排除的文件/目录
EXCLUDE_LIST=(
    "node_modules"
    ".git"
    ".env"
    "*.log"
    ".server.pid"
    ".DS_Store"
    "sample/builds"
    "deploy.local"
)

# 打印横幅
print_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}        ${BOLD}Artifact Portal - 远程部署工具${NC}                     ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 获取用户输入
prompt_input() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"
    local result

    if [ -n "$default" ]; then
        read -p "$(echo -e "${BLUE}?${NC} $prompt ${YELLOW}[$default]${NC}: ")" result
        result="${result:-$default}"
    else
        read -p "$(echo -e "${BLUE}?${NC} $prompt: ")" result
    fi

    eval "$var_name=\"$result\""
}

# 确认操作
confirm() {
    local prompt="$1"
    
    # 支持 -y 参数或 DEPLOY_YES 环境变量跳过确认
    if [[ "${DEPLOY_YES:-}" == "true" ]] || [[ " ${SCRIPT_ARGS[*]} " =~ " -y " ]] || [[ " ${SCRIPT_ARGS[*]} " =~ " --yes " ]]; then
        log_info "自动确认: $prompt"
        return 0
    fi
    
    local answer
    read -p "$(echo -e "${YELLOW}?${NC} $prompt (Y/n): ")" answer
    # 空输入（回车）或 Y/y 都表示确认
    [[ -z "$answer" ]] || [[ "$answer" =~ ^[Yy]$ ]]
}

# 配置 SSH 密钥
setup_ssh_key() {
    local target="$1"
    
    log_step "配置 SSH 密钥免密登录"
    
    # 检查本地是否有 SSH 密钥
    local key_file="$HOME/.ssh/id_ed25519"
    local key_type="ed25519"
    
    if [ ! -f "$key_file" ]; then
        key_file="$HOME/.ssh/id_rsa"
        key_type="rsa"
    fi
    
    if [ ! -f "$key_file" ]; then
        log_info "本地未找到 SSH 密钥，正在生成..."
        mkdir -p "$HOME/.ssh"
        chmod 700 "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -C "deploy@$(hostname)"
        key_file="$HOME/.ssh/id_ed25519"
        log_success "SSH 密钥已生成: $key_file"
    else
        log_info "使用现有 SSH 密钥: $key_file"
    fi
    
    # 复制公钥到远程服务器
    log_info "将公钥复制到远程服务器..."
    log_info "请输入远程服务器密码（这是最后一次输入密码）:"
    
    if ssh-copy-id -i "${key_file}.pub" "$target" 2>/dev/null; then
        log_success "SSH 密钥配置完成！"
        return 0
    else
        # ssh-copy-id 可能不存在，手动复制
        log_warn "ssh-copy-id 失败，尝试手动配置..."
        local pub_key=$(cat "${key_file}.pub")
        if ssh "$target" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub_key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"; then
            log_success "SSH 密钥配置完成！"
            return 0
        else
            log_error "SSH 密钥配置失败"
            return 1
        fi
    fi
}

# 检查 SSH 连接
check_ssh() {
    local target="$1"
    log_info "检查 SSH 连接..."
    
    # 先尝试无密码连接
    if ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" "echo ok" &>/dev/null; then
        log_success "SSH 连接正常（密钥认证）"
        return 0
    fi
    
    # 检查是否能 ping 通
    local server_ip="${target#*@}"
    if ping -c 1 -W 2 "$server_ip" &>/dev/null; then
        log_warn "SSH 密钥未配置"
        if confirm "是否现在配置 SSH 密钥免密登录（推荐）"; then
            if setup_ssh_key "$target"; then
                # 验证密钥是否生效
                if ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" "echo ok" &>/dev/null; then
                    log_success "密钥验证成功，后续操作无需输入密码"
                    return 0
                fi
            fi
            log_warn "密钥配置可能未生效，继续需要输入密码"
        fi
        return 0
    else
        log_error "无法连接到 $server_ip（网络不可达）"
        log_info "请确保:"
        echo "  1. 目标服务器已开机"
        echo "  2. 网络连接正常"
        echo "  3. IP 地址正确"
        return 1
    fi
}

# 检查远程环境
check_remote_env() {
    local target="$1"
    log_info "检查远程环境..."
    
    # 检查 nvm 是否安装
    local nvm_installed=$(ssh "$target" "[ -s \"\$HOME/.nvm/nvm.sh\" ] && echo 'installed' || echo 'not found'")
    if [[ "$nvm_installed" == "not found" ]]; then
        log_warn "远程服务器未安装 nvm"
        log_info "请先在远程服务器安装 nvm: https://github.com/nvm-sh/nvm"
        return 1
    fi
    log_info "nvm: 已安装"
    
    # 读取本地 .nvmrc 获取所需版本
    local required_version=""
    if [ -f "$SCRIPT_DIR/.nvmrc" ]; then
        required_version=$(cat "$SCRIPT_DIR/.nvmrc" | tr -d '[:space:]')
        log_info "项目要求 Node.js 版本: $required_version"
    fi
    
    # 检查远程是否安装了所需版本
    if [ -n "$required_version" ]; then
        local version_installed=$(ssh "$target" "source \"\$HOME/.nvm/nvm.sh\" && nvm ls '$required_version' 2>/dev/null | grep -q '$required_version' && echo 'installed' || echo 'not found'")
        if [[ "$version_installed" == "not found" ]]; then
            log_warn "远程服务器未安装 Node.js $required_version"
            log_info "将在部署时自动安装..."
        else
            log_info "Node.js $required_version: 已安装"
        fi
    fi
    
    return 0
}

# 构建 rsync 排除参数
build_exclude_args() {
    local args=""
    for item in "${EXCLUDE_LIST[@]}"; do
        args="$args --exclude='$item'"
    done
    echo "$args"
}

# 同步代码
sync_code() {
    local target="$1"
    local remote_dir="$2"
    
    log_step "同步代码到远程服务器"
    
    # 创建远程目录
    log_info "创建远程目录: $remote_dir"
    ssh "$target" "mkdir -p '$remote_dir'"
    
    # 构建 rsync 命令
    local exclude_args=$(build_exclude_args)
    
    log_info "同步文件..."
    eval rsync -avz --progress \
        $exclude_args \
        --delete \
        "$SCRIPT_DIR/" \
        "$target:$remote_dir/"
    
    # 同步 deploy.local（如果存在）
    if [ -f "$SCRIPT_DIR/deploy.local" ]; then
        log_info "同步 deploy.local 配置文件..."
        rsync -avz "$SCRIPT_DIR/deploy.local" "$target:$remote_dir/deploy.local"
    fi
    
    log_success "代码同步完成"
}

# 配置远程环境
configure_remote() {
    local target="$1"
    local remote_dir="$2"
    local server_ip="$3"
    
    log_step "配置远程环境"
    
    # 创建 .env 文件
    log_info "生成 .env 配置..."
    
    local deploy_port="${PORT:-8088}"
    local deploy_host="${HOST:-0.0.0.0}"
    local deploy_app_name="${APP_NAME:-Artifact Portal}"
    local deploy_app_icon="${APP_ICON:-}"
    local deploy_builds_dir="${BUILDS_DIR:-./builds}"
    local deploy_max_builds="${MAX_BUILDS:-50}"
    local deploy_max_age="${MAX_AGE_DAYS:-30}"
    local deploy_disk_threshold="${DISK_THRESHOLD_GB:-50}"
    
    # 生成公网地址
    local deploy_public_url="${PUBLIC_BASE_URL:-http://$server_ip}"
    # 如果端口不是标准端口，添加端口号
    if [[ "$deploy_port" != "443" && "$deploy_port" != "80" ]]; then
        if [[ ! "$deploy_public_url" =~ :[0-9]+$ ]]; then
            deploy_public_url="$deploy_public_url:$deploy_port"
        fi
    fi
    
    ssh "$target" "cat > '$remote_dir/.env'" << EOF
# =====================================
# Artifact Portal 部署配置
# 自动生成于: $(date '+%Y-%m-%d %H:%M:%S')
# =====================================

PORT=$deploy_port
HOST=$deploy_host

APP_NAME=$deploy_app_name
APP_ICON=$deploy_app_icon

PUBLIC_BASE_URL=$deploy_public_url

# 构建产物目录（指向 Fastlane 输出路径）
BUILDS_DIR=$deploy_builds_dir

MAX_BUILDS=$deploy_max_builds
MAX_AGE_DAYS=$deploy_max_age
DISK_THRESHOLD_GB=$deploy_disk_threshold

# iOS plist 代理服务配置
IOS_PLIST_PROXY_URL=${IOS_PLIST_PROXY_URL:-}
IOS_PLIST_LOGO=${IOS_PLIST_LOGO:-}
IOS_DISPLAY_NAME=${IOS_DISPLAY_NAME:-}
EOF
    
    log_success ".env 配置已生成"
    
    # 不再创建 builds 目录，使用已有的 Fastlane 输出目录
    log_info "构建产物目录: $deploy_builds_dir"
}

# 安装依赖并启动
start_service() {
    local target="$1"
    local remote_dir="$2"
    
    log_step "安装 Node.js 并启动服务"
    
    # 读取所需 Node.js 版本
    local required_version=""
    if [ -f "$SCRIPT_DIR/.nvmrc" ]; then
        required_version=$(cat "$SCRIPT_DIR/.nvmrc" | tr -d '[:space:]')
    else
        required_version="20"
    fi
    
    log_info "安装/切换 Node.js $required_version..."
    ssh "$target" "source \"\$HOME/.nvm/nvm.sh\" && cd '$remote_dir' && nvm install && nvm use"
    
    log_info "安装依赖..."
    ssh "$target" "source \"\$HOME/.nvm/nvm.sh\" && cd '$remote_dir' && nvm use && npm ci --omit=dev"
    
    # 先停止旧服务（如果正在运行）
    log_info "检查并停止旧服务..."
    ssh "$target" "source \"\$HOME/.nvm/nvm.sh\" && cd '$remote_dir' && nvm use && ./build.sh stop 2>/dev/null || true"
    
    log_info "启动 Artifact Portal..."
    ssh "$target" "source \"\$HOME/.nvm/nvm.sh\" && cd '$remote_dir' && nvm use && ./build.sh start"
    
    log_success "服务已启动"
}

# 显示部署结果
show_result() {
    local server_ip="$1"
    
    local port="${PORT:-8088}"
    
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}                    ${BOLD}部署完成！${NC}                             ${GREEN}║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  访问地址: ${CYAN}${BOLD}http://$server_ip:$port${NC}"
    echo ""
    echo -e "  ${BLUE}常用命令 (SSH 到服务器后):${NC}"
    echo "    cd ~/$PROJECT_NAME"
    echo "    ./build.sh status   # 查看状态"
    echo "    ./build.sh restart  # 重启服务"
    echo "    ./build.sh logs     # 查看日志"
    echo ""
}

# 主函数
main() {
    print_banner
    
    # 解析命令行参数（过滤掉 -y/--yes 标志）
    local target=""
    local server_ip=""
    local user=""
    
    for arg in "$@"; do
        case "$arg" in
            -y|--yes)
                # 忽略，已在 SCRIPT_ARGS 中处理
                ;;
            *)
                # 第一个非标志参数视为目标服务器
                if [ -z "$target" ]; then
                    target="$arg"
                fi
                ;;
        esac
    done
    
    # 如果命令行没有指定，使用配置文件中的目标
    target="${target:-$DEPLOY_TARGET}"
    
    # 如果没有提供参数且配置文件也没有，交互式获取
    if [ -z "$target" ]; then
        log_info "请输入部署目标信息"
        echo ""
        
        prompt_input "远程服务器 IP" "" "server_ip"
        prompt_input "SSH 用户名" "root" "user"
        
        target="${user}@${server_ip}"
    else
        # 从 target 解析 IP
        if [[ "$target" == *"@"* ]]; then
            server_ip="${target#*@}"
            user="${target%@*}"
        else
            server_ip="$target"
            target="root@$server_ip"
            user="root"
        fi
        log_info "使用配置: $target"
    fi
    
    echo ""
    log_info "部署目标: $target"
    log_info "远程目录: $REMOTE_DIR"
    echo ""
    
    # 询问构建产物目录（如果配置文件中没有设置）
    if [ -z "$BUILDS_DIR" ]; then
        prompt_input "Fastlane 构建产物目录" "./builds" "builds_dir"
        BUILDS_DIR="$builds_dir"
    fi
    log_info "构建目录: $BUILDS_DIR"
    echo ""
    
    # 检查连接
    if ! check_ssh "$target"; then
        exit 1
    fi
    
    # 检查远程环境
    if ! check_remote_env "$target"; then
        if ! confirm "环境检查有警告，是否继续"; then
            exit 1
        fi
    fi
    
    echo ""
    if ! confirm "确认开始部署到 $target"; then
        log_info "部署已取消"
        exit 0
    fi
    
    # 获取远程用户的实际 home 目录，展开 $HOME
    log_info "获取远程目录路径..."
    local remote_home=$(ssh "$target" "echo \$HOME")
    local actual_remote_dir="${REMOTE_DIR/\$HOME/$remote_home}"
    log_info "实际远程目录: $actual_remote_dir"
    
    # 执行部署步骤
    sync_code "$target" "$actual_remote_dir"
    configure_remote "$target" "$actual_remote_dir" "$server_ip"
    start_service "$target" "$actual_remote_dir"
    
    show_result "$server_ip"
}

# 入口
main "$@"
