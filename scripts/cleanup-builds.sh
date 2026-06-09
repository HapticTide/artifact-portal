#!/usr/bin/env bash

# ============================================
# 构建清理脚本
# 清理当前上传目录结构中的旧 IPA/APK 文件。
#
# 支持目录：
#   builds/ios/<branch>/<version>/*.ipa
#   builds/android/<branch>/*.apk
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

read_env_value() {
    local key="$1"
    local value=""

    if [ -f "$ENV_FILE" ]; then
        value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d'=' -f2- || true)"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
    fi

    printf '%s' "$value"
}

BUILDS_DIR="${BUILDS_DIR:-$(read_env_value BUILDS_DIR)}"
BUILDS_DIR="${BUILDS_DIR:-./sample/builds}"
if [[ "$BUILDS_DIR" != /* ]]; then
    BUILDS_DIR="$PROJECT_DIR/$BUILDS_DIR"
fi

# MAX_PER_BRANCH 优先；没有配置时兼容旧 MAX_BUILDS。
MAX_PER_BRANCH="${MAX_PER_BRANCH:-${MAX_BUILDS:-$(read_env_value MAX_BUILDS)}}"
MAX_PER_BRANCH="${MAX_PER_BRANCH:-50}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-$(read_env_value MAX_AGE_DAYS)}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-30}"
DRY_RUN="${DRY_RUN:-true}"

if [ "${NO_COLOR:-false}" = "true" ]; then
    GREEN=''
    YELLOW=''
    RED=''
    NC=''
else
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    NC='\033[0m'
fi

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

file_mtime() {
    local file="$1"

    if stat -c '%Y' "$file" >/dev/null 2>&1; then
        stat -c '%Y' "$file"
    else
        stat -f '%m' "$file"
    fi
}

delete_file() {
    local file="$1"
    local reason="$2"

    if [ "$DRY_RUN" = "true" ]; then
        log_warn "[DRY_RUN] delete ($reason): $file"
    else
        rm -f "$file"
        log_info "deleted ($reason): $file"
    fi
}

cleanup_empty_dirs() {
    local platform_dir="$1"

    if [ "$DRY_RUN" = "true" ]; then
        return 0
    fi

    find "$platform_dir" -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true
}

cleanup_branch() {
    local branch_dir="$1"
    local pattern="$2"
    local now
    local index=0

    now="$(date '+%s')"

    # 按文件修改时间倒序保留最近 MAX_PER_BRANCH 个。
    while IFS=$'\t' read -r mtime file; do
        [ -n "$file" ] || continue

        index=$((index + 1))
        local age_days=$(( (now - mtime) / 86400 ))

        if [ "$age_days" -gt "$MAX_AGE_DAYS" ]; then
            delete_file "$file" "older than ${MAX_AGE_DAYS} days"
            continue
        fi

        if [ "$index" -gt "$MAX_PER_BRANCH" ]; then
            delete_file "$file" "exceeds ${MAX_PER_BRANCH} per branch"
            continue
        fi
    done < <(
        find "$branch_dir" -type f -name "$pattern" -print0 |
            while IFS= read -r -d '' file; do
                printf '%s\t%s\n' "$(file_mtime "$file")" "$file"
            done |
            sort -rn
    )
}

cleanup_platform() {
    local platform="$1"
    local pattern="$2"
    local platform_dir="$BUILDS_DIR/$platform"

    if [ ! -d "$platform_dir" ]; then
        return 0
    fi

    find "$platform_dir" -mindepth 1 -maxdepth 1 -type d -print0 |
        while IFS= read -r -d '' branch_dir; do
            log_info "检查分支: $platform/$(basename "$branch_dir")"
            cleanup_branch "$branch_dir" "$pattern"
        done

    cleanup_empty_dirs "$platform_dir"
}

if [ ! -d "$BUILDS_DIR" ]; then
    log_error "构建目录不存在: $BUILDS_DIR"
    exit 1
fi

log_info "构建目录: $BUILDS_DIR"
log_info "每个平台每个分支保留数量: $MAX_PER_BRANCH"
log_info "保留天数: $MAX_AGE_DAYS"
if [ "$DRY_RUN" = "true" ]; then
    log_warn "模拟运行模式 (DRY_RUN=true)"
fi

cleanup_platform "ios" "*.ipa"
cleanup_platform "android" "*.apk"

log_info "清理完成"
if command -v du >/dev/null 2>&1; then
    log_info "当前占用: $(du -sh "$BUILDS_DIR" 2>/dev/null | cut -f1)"
fi
