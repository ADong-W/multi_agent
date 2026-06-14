#!/bin/zsh
cd "$(dirname "$0")"
echo "正在启动 TeamRoom..."
echo
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo
  read "?按回车键关闭窗口..."
  exit 1
fi
node scripts/teamroom-control.mjs start
status=$?
echo
if [ $status -eq 0 ]; then
  echo "TeamRoom 已启动。浏览器会自动打开页面。"
  echo "可以关闭这个窗口，TeamRoom 会继续在后台运行。"
else
  echo "启动没有成功，请查看上面的提示。"
  echo "如果提示 OpenCode 未安装，请先安装 opencode，或在页面里改为连接已有服务。"
  read "?按回车键关闭窗口..."
fi
sleep 2
exit $status
