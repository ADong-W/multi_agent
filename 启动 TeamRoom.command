#!/bin/zsh
cd "$(dirname "$0")"
node scripts/teamroom-control.mjs start
status=$?
echo
if [ $status -eq 0 ]; then
  echo "可以关闭这个窗口，TeamRoom 会继续运行。"
else
  echo "启动没有成功，请查看上面的提示。"
  read "?按回车键关闭窗口..."
fi
sleep 2
exit $status
