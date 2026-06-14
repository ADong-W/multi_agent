#!/bin/zsh
cd "$(dirname "$0")"
echo "正在重启 TeamRoom..."
echo
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo
  read "?按回车键关闭窗口..."
  exit 1
fi
node scripts/teamroom-control.mjs restart
status=$?
echo
if [ $status -eq 0 ]; then
  echo "TeamRoom 已重启。浏览器会自动打开页面。"
  echo "可以关闭这个窗口，TeamRoom 会继续在后台运行。"
else
  echo "重启没有成功，请查看上面的提示。"
  read "?按回车键关闭窗口..."
fi
sleep 2
exit $status
