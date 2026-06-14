#!/bin/zsh
cd "$(dirname "$0")"
echo "正在停止 TeamRoom..."
echo
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo
  read "?按回车键关闭窗口..."
  exit 1
fi
node scripts/teamroom-control.mjs stop
status=$?
echo
if [ $status -eq 0 ]; then
  echo "TeamRoom 已停止。"
else
  echo "停止没有成功，请查看上面的提示。"
  read "?按回车键关闭窗口..."
fi
sleep 2
exit $status
