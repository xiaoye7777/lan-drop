#!/bin/sh
# lan-drop 启动脚本（Mac / Linux）。用法：sh start.sh
cd "$(dirname "$0")" || exit 1

# 项目里的 node 文件夹有免安装版 Node.js 就用它，否则用系统装好的
if [ -x ./node/bin/node ]; then NODE=./node/bin/node; else NODE=node; fi

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "没有找到 Node.js。请安装 Node.js 20 或更高版本，或者把免安装版解压到这里的 node 文件夹。"
  exit 1
fi

exec "$NODE" dist/server/main.js
