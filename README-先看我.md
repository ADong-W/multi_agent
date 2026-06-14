# TeamRoom 启动说明

这是给普通用户使用的本地启动包说明。

## 1. 第一次使用前

请先确认电脑已经安装：

- Node.js 22 或更高版本
- OpenCode 命令行工具

如果只是连接别人已经启动好的 OpenCode 服务，可以不由 TeamRoom 自动启动 OpenCode。

## 2. 推荐文件摆放方式

建议把 TeamRoom 和 OpenCode 项目放在同一个文件夹下：

```text
TeamRoom-Package/
  TeamRoom/
  opencode_foxagent/
```

其中：

- `TeamRoom/` 是本项目目录
- `opencode_foxagent/` 是你的 OpenCode Agent 项目目录

这样双击启动时，TeamRoom 会自动识别 `opencode_foxagent`。

## 3. 如何启动

macOS：

```text
双击 启动 TeamRoom.command
```

Windows：

```text
双击 启动 TeamRoom.cmd
```

启动成功后，浏览器会自动打开 TeamRoom 页面。命令窗口可以关闭，TeamRoom 会继续在后台运行。

## 4. 如何重启或停止

重启：

```text
双击 重启 TeamRoom.command / 重启 TeamRoom.cmd
```

停止：

```text
双击 停止 TeamRoom.command / 停止 TeamRoom.cmd
```

## 5. 如果启动失败

请先看启动窗口里的提示。常见原因：

- 没有安装 Node.js 22+
- 端口 8787 已经被占用
- 没有安装 OpenCode 命令行工具
- `opencode_foxagent` 没有和 TeamRoom 放在同一层目录

运行日志保存在：

```text
data/teamroom.log
```
