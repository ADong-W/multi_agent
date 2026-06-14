#!/bin/zsh
cd "$(dirname "$0")"
node scripts/teamroom-control.mjs stop
status=$?
echo
if [ $status -eq 0 ]; then
  echo "窗口即将关闭。"
else
  echo "停止没有成功，请查看上面的提示。"
  read "?按回车键关闭窗口..."
fi
sleep 2
exit $status
