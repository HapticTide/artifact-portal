#!/usr/bin/env bash

# ============================================
# 构建清理脚本
# 清理当前上传目录结构中的旧 IPA/APK 文件。
#
# 支持目录：
#   builds/ios/<branch>/<env>/<version>/*.ipa  （env: pre / production）
#   builds/ios/<branch>/<version>/*.ipa        （旧结构兼容）
#   builds/android/<branch>/<version>.<build>/*.apk
#   builds/android/<branch>/<version>.<build>/*.mapping.zip
#     （与对应 APK 同目录，随 APK 一起清理，APK 不存在的 mapping 视为孤立文件删除）
#   builds/android/<branch>/mapping/*.mapping.txt  （旧结构遗留，直接回收）
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

# 记录本轮"计划删除"的 APK 路径（每行一个）。
# 孤立 mapping 判断时同时参考此集合，使 DRY_RUN 预览与真实运行的删除范围一致：
# 真实运行时 APK 已被删除，靠文件是否存在即可判断；
# DRY_RUN 时 APK 仍在磁盘上，必须借助此集合才能预告随之删除的 mapping。
PLANNED_APK_DELETIONS="$(mktemp)"
trap 'rm -f "$PLANNED_APK_DELETIONS"' EXIT

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

    # 记录被删除的 APK，供后续孤立 mapping 判断使用（DRY_RUN 下也记录）。
    case "$file" in
        *.apk) printf '%s\n' "$file" >> "$PLANNED_APK_DELETIONS" ;;
    esac

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

cleanup_ranked_files() {
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
    done
}

cleanup_branch() {
    local branch_dir="$1"
    local pattern="$2"

    find "$branch_dir" -type f -name "$pattern" -print0 |
            while IFS= read -r -d '' file; do
                printf '%s\t%s\n' "$(file_mtime "$file")" "$file"
            done |
            sort -rn |
            cleanup_ranked_files
}

cleanup_legacy_ios_branch() {
    local branch_dir="$1"

    # 新目录按 env 独立计数；这里仅处理不位于身份目录下的旧两层布局。
    find "$branch_dir" -type f -name '*.ipa' \
            ! -path "$branch_dir/pre/*" \
            ! -path "$branch_dir/production/*" \
            ! -path "$branch_dir/sandbox/*" \
            -print0 |
        while IFS= read -r -d '' file; do
            printf '%s\t%s\n' "$(file_mtime "$file")" "$file"
        done |
        sort -rn |
        cleanup_ranked_files
}

cleanup_ios_platform() {
    local ios_dir="$BUILDS_DIR/ios"

    if [ ! -d "$ios_dir" ]; then
        return 0
    fi

    find "$ios_dir" -mindepth 1 -maxdepth 1 -type d -print0 |
        while IFS= read -r -d '' branch_dir; do
            local branch
            branch="$(basename "$branch_dir")"

            for env in pre production sandbox; do
                local env_dir="$branch_dir/$env"
                if [ -d "$env_dir" ]; then
                    log_info "检查身份: ios/$branch/$env"
                    cleanup_branch "$env_dir" '*.ipa'
                fi
            done

            log_info "检查旧布局: ios/$branch"
            cleanup_legacy_ios_branch "$branch_dir"
        done

    cleanup_empty_dirs "$ios_dir"
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

# 清理旧结构遗留的 mapping 文件：android/<branch>/mapping/*.mapping.txt
# 这些文件在新版本中已不再展示，直接全部回收。
cleanup_legacy_mappings() {
    local android_dir="$BUILDS_DIR/android"

    if [ ! -d "$android_dir" ]; then
        return 0
    fi

    find "$android_dir" -mindepth 2 -maxdepth 2 -type d -name 'mapping' -print0 |
        while IFS= read -r -d '' mapping_dir; do
            find "$mapping_dir" -type f -name '*.mapping.txt' -print0 |
                while IFS= read -r -d '' mapping_file; do
                    delete_file "$mapping_file" "legacy mapping"
                done
        done
}

# 删除没有对应 APK 的 mapping 文件（新结构）
# mapping 与 APK 同放在 android/<branch>/<version>/ 目录下，
# 按文件名去掉 .mapping.zip 后拼出同目录下的 .apk 路径即可判断是否孤立。
cleanup_orphan_mappings() {
    local android_dir="$BUILDS_DIR/android"

    if [ ! -d "$android_dir" ]; then
        return 0
    fi

    find "$android_dir" -mindepth 3 -maxdepth 3 -type f -name '*.mapping.zip' -print0 |
        while IFS= read -r -d '' mapping_file; do
            local version_dir base apk_path
            version_dir="$(dirname "$mapping_file")"
            base="$(basename "$mapping_file")"
            base="${base%.mapping.zip}"
            apk_path="$version_dir/$base.apk"

            # 对应 APK 已不在磁盘，或本轮计划删除，均视为孤立 mapping。
            # 后者保证 DRY_RUN 能预告随 APK 一起被删的 mapping。
            if [ ! -f "$apk_path" ] || grep -qxF "$apk_path" "$PLANNED_APK_DELETIONS"; then
                delete_file "$mapping_file" "orphan mapping"
            fi
        done

    cleanup_empty_dirs "$android_dir"
}

if [ ! -d "$BUILDS_DIR" ]; then
    log_error "构建目录不存在: $BUILDS_DIR"
    exit 1
fi

log_info "构建目录: $BUILDS_DIR"
log_info "保留数量: iOS 每个分支/身份、Android 每个分支最多 $MAX_PER_BRANCH 个"
log_info "保留天数: $MAX_AGE_DAYS"
if [ "$DRY_RUN" = "true" ]; then
    log_warn "模拟运行模式 (DRY_RUN=true)"
fi

cleanup_ios_platform
cleanup_platform "android" "*.apk"
cleanup_legacy_mappings
cleanup_orphan_mappings

log_info "清理完成"
if command -v du >/dev/null 2>&1; then
    log_info "当前占用: $(du -sh "$BUILDS_DIR" 2>/dev/null | cut -f1)"
fi
