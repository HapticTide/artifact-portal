#!/bin/bash

# ============================================
# 构建清理脚本
# 清理旧的构建目录，保留最近 N 个
# ============================================

set -e

# 配置（可通过环境变量覆盖）
BUILDS_DIR="${BUILDS_DIR:-/var/artifacts/builds}"
MAX_BUILDS="${MAX_BUILDS:-50}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-30}"
DRY_RUN="${DRY_RUN:-false}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查目录是否存在
if [ ! -d "$BUILDS_DIR" ]; then
    log_error "构建目录不存在: $BUILDS_DIR"
    exit 1
fi

log_info "构建目录: $BUILDS_DIR"
log_info "保留数量: $MAX_BUILDS"
log_info "保留天数: $MAX_AGE_DAYS"
if [ "$DRY_RUN" = "true" ]; then
    log_warn "模拟运行模式 (DRY_RUN=true)"
fi
echo ""

# 获取所有构建目录（按名称排序，最新的在前）
# 目录格式: YYYYMMDD_buildNumber_commit
BUILD_DIRS=$(find "$BUILDS_DIR" -mindepth 1 -maxdepth 1 -type d -name "[0-9]*_*_*" | sort -r)

# 计算当前构建数量
TOTAL_COUNT=$(echo "$BUILD_DIRS" | grep -c "^" || echo 0)
log_info "当前构建数量: $TOTAL_COUNT"

# 统计
DELETED_COUNT=0
KEPT_COUNT=0

# 处理每个目录
CURRENT_INDEX=0
while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    
    CURRENT_INDEX=$((CURRENT_INDEX + 1))
    DIR_NAME=$(basename "$dir")
    
    # 检查是否有 build.json
    if [ ! -f "$dir/build.json" ]; then
        log_warn "跳过无效目录 (缺少 build.json): $DIR_NAME"
        continue
    fi
    
    # 检查是否超过保留数量
    if [ $CURRENT_INDEX -gt $MAX_BUILDS ]; then
        log_info "删除 (超过 $MAX_BUILDS 个): $DIR_NAME"
        if [ "$DRY_RUN" != "true" ]; then
            rm -rf "$dir"
        fi
        DELETED_COUNT=$((DELETED_COUNT + 1))
        continue
    fi
    
    # 提取日期并检查是否过期
    # 目录格式: YYYYMMDD_xxx_xxx
    DIR_DATE="${DIR_NAME:0:8}"
    if [[ "$DIR_DATE" =~ ^[0-9]{8}$ ]]; then
        # 计算天数差
        DIR_TIMESTAMP=$(date -j -f "%Y%m%d" "$DIR_DATE" "+%s" 2>/dev/null || echo 0)
        NOW_TIMESTAMP=$(date "+%s")
        AGE_DAYS=$(( (NOW_TIMESTAMP - DIR_TIMESTAMP) / 86400 ))
        
        if [ $AGE_DAYS -gt $MAX_AGE_DAYS ]; then
            log_info "删除 (超过 $MAX_AGE_DAYS 天, 已 $AGE_DAYS 天): $DIR_NAME"
            if [ "$DRY_RUN" != "true" ]; then
                rm -rf "$dir"
            fi
            DELETED_COUNT=$((DELETED_COUNT + 1))
            continue
        fi
    fi
    
    KEPT_COUNT=$((KEPT_COUNT + 1))
    
done <<< "$BUILD_DIRS"

echo ""
log_info "清理完成"
log_info "保留: $KEPT_COUNT 个"
log_info "删除: $DELETED_COUNT 个"

# 显示磁盘使用情况
if command -v du &> /dev/null; then
    DISK_USAGE=$(du -sh "$BUILDS_DIR" 2>/dev/null | cut -f1)
    log_info "当前占用: $DISK_USAGE"
fi
