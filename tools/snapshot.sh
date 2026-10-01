#!/bin/bash
# 无 git 环境下的简易版本快照。
#
# 本机 Command Line Tools 残缺（缺 git 二进制），而修复需要在图形界面点确认，
# 所以先用 tar 快照顶上。等 git 装好后可以随时删掉 .snapshots 目录切换过去。
#
# 用法：
#   bash tools/snapshot.sh            # 创建快照
#   bash tools/snapshot.sh list       # 列出全部快照
#   bash tools/snapshot.sh restore N  # 从第 N 个快照恢复（按 list 的序号）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_DIR="$ROOT/.snapshots"
KEEP=15

cmd="${1:-create}"

case "$cmd" in
  list)
    if [ ! -d "$SNAP_DIR" ]; then
      echo "还没有任何快照"
      exit 0
    fi
    ls -1t "$SNAP_DIR"/snapshot-*.tar.gz 2>/dev/null | nl -w2 -s') ' || echo "还没有任何快照"
    ;;

  restore)
    idx="${2:-}"
    if [ -z "$idx" ]; then
      echo "用法: bash tools/snapshot.sh restore <序号>" >&2
      exit 1
    fi
    target="$(ls -1t "$SNAP_DIR"/snapshot-*.tar.gz 2>/dev/null | sed -n "${idx}p")"
    if [ -z "$target" ]; then
      echo "找不到第 $idx 个快照" >&2
      exit 1
    fi
    echo "即将从 $target 恢复，当前内容会被覆盖。"
    read -r -p "确认继续？(yes/no) " ans
    [ "$ans" = "yes" ] || { echo "已取消"; exit 0; }
    tar -xzf "$target" -C "$ROOT"
    echo "已恢复"
    ;;

  create)
    mkdir -p "$SNAP_DIR"
    stamp="$(date +%Y%m%d-%H%M%S)"
    archive="$SNAP_DIR/snapshot-$stamp.tar.gz"

    # 排除依赖与构建产物：它们可以重新生成，且体积远大于源码本身
    tar -czf "$archive" -C "$ROOT" \
      --exclude='node_modules' \
      --exclude='dist' \
      --exclude='.snapshots' \
      --exclude='.DS_Store' \
      --exclude='*.log' \
      client/src client/index.html client/package.json client/tsconfig.json client/vite.config.ts \
      tools server docs README.md 开发规划.md 2>/dev/null || true

    size="$(du -h "$archive" | cut -f1)"
    echo "✓ 快照已创建: .snapshots/snapshot-$stamp.tar.gz ($size)"

    # 只保留最近 KEEP 份，避免快照目录无限膨胀
    count="$(ls -1 "$SNAP_DIR"/snapshot-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$count" -gt "$KEEP" ]; then
      ls -1t "$SNAP_DIR"/snapshot-*.tar.gz | tail -n $((count - KEEP)) | while read -r old; do
        rm -f "$old"
        echo "  已清理旧快照: $(basename "$old")"
      done
    fi
    ;;

  *)
    echo "未知命令: $cmd（可用: create / list / restore）" >&2
    exit 1
    ;;
esac
