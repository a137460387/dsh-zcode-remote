---
name: zcode-remote-usage
description: Use when driving a ZCode desktop from DSH through the zcode_remote_* tools — dispatching a task, collecting a reply, listing devices/workspaces/tasks, or stopping a remote task. Covers the remote-control link prerequisite, the five tools, single and parallel dispatch, model and reasoning-level selection, workspace and device addressing, verification, failure appearances, and known limits.
whenToUse: 任何要把工作发给 ZCode 桌面端执行的请求（本机或另一台机器），或检查、停止这类任务时。
---

# 使用 dsh-zcode-remote

通过 ZCode 的移动远程控制中继驱动 ZCode 桌面端 agent（原理与手机 App 相同）。工具为
zcode_remote_* 五个。一次调用 = 目标桌面端的一条用户消息。

## 前置：远程控制链接

远端 ZCode 桌面端需要一条链接；同机 ZCode 可通过下面的 localDevice 自动发现。在远端桌面端点
左下角手机图标 → 移动端远程控制 → 复制连接地址。形如：
    https://zcode.z.ai/remote/v4?sid=…&hash=…&t=…&mid=…&name=<机器名>

一次性配置（写入 profile 的用户 patch 层 <DSH_HOME>/profiles/<profile>/cordis.patch.yml）：
    - id: zcode-remote
      config:
        remoteUrl: <完整链接>

或在调用时传 url 参数（不落盘，适合临时用）。

多机寻址（配一次，之后按名字调用）：
    - id: zcode-remote
      config:
        device: hp
        devices:
          hp: <链接>
          matebook: <链接>

同机自动发现（dsh 和 ZCode 在同一台 Windows 机器）不需要保存 URL：
    - id: zcode-remote
      config:
        localDevice:
          home: C:\Users\USER
          username: USER
          label: local

插件从 `<home>\.zcode\v2` 读凭据、按 ZCode 的密钥规则解密 pass_hash、并从**该实例自己的日志**
恢复它当前使用的 sid（共享 setting.json 会被多开实例互相覆盖，不可信），然后在每次寻址时生成
新时间戳的 URL。若 dsh 以 SYSTEM 等其他账户运行，home 和 username 必须明确指向运行 ZCode
桌面的真实用户。该方式不会把 URL 或解密后的 hash 写回磁盘，但 ZCode 仍须存在当前有效的远程
控制配对；自动发现不能自行开启或续期配对。

多开实例（zcode-multi 的每个 slot 是一台独立 ZCode，各有账号/mid/pass_hash）可批量发现：
    - id: zcode-remote
      config:
        localDevices:
          s1: { home: C:\Users\USER\AppData\Roaming\zcode-multi\1\data, username: USER }
          s2: { home: C:\Users\USER\AppData\Roaming\zcode-multi\2\data, username: USER }

用 `device:"s1"` 等寻址；`zcode_remote_devices()` 列出全部已发现实例。只有同机设备可自动发现；
远端机器仍需配置 URL，或在调用时传 url。多开实例会持续重注册导致 sid 轮换，派发前现取 URL。

链接的三个硬特性，必须遵守：
1. 含 hash secret：严禁写入任何仓库、不得出现在报告或日志里。
2. 有效期以小时计（实测 45 分钟以上仍有效）：用前现生成，不要复用隔天的旧链接。
3. 一条链接同一时刻只允许一个终端连接：当手机/浏览器正开着同一条远程页面时，插件连接会
   把对方踢掉（对方报 KICKED），反之亦然。用插件时先关掉别处的同一链接页面。

## 五个工具

- zcode_remote_devices()：列出可达设备，无需连接。零成本自检，第一步用它。
- zcode_remote_status(device?/url?/workspace?)：该设备的打开工作区、最近任务、
  正在运行的任务数与并发上限。
- zcode_remote_dispatch(text, session_id?, new_task?, model?, thought?, async?, wait_seconds?,
  device?/url?, workspace?)：派发任务。
- zcode_remote_collect(session_id, wait_seconds?, device?/url?, workspace?)：取回异步任务的
  回复；可重复调用，未完成的任务不会丢流。
- zcode_remote_stop(session_id?, device?/url?, workspace?)：中断正在跑的远端任务。

## 派发

单任务（最常用）：
    zcode_remote_dispatch(text: "任务内容", new_task: true, device: "hp", workspace: "dhsh")

- new_task: true 开零上下文新窗口执行（走 createSession 携带首条输入的路径）。不传它就必须
  显式给 session_id；没给就报错，那是在要求你指定目标，不是故障。
- 完成判据：默认等回复；任务产生过回复且之后静默 12 秒即算完成。wait_seconds 只是等待预算
  （默认 180 秒，上限 600 秒）；预算耗尽不算失败，回复仍在订阅里，稍后再取即可。

并行（一台 ZCode 客户端最多 3 个并发任务）：
    zcode_remote_dispatch(text:"A", new_task:true, async:true, device:"hp")  → sessionId
    zcode_remote_dispatch(text:"B", new_task:true, async:true, device:"hp")  → sessionId
    zcode_remote_dispatch(text:"C", new_task:true, async:true, device:"hp")  → sessionId
    然后逐个 zcode_remote_collect(session_id:"sess_…", device:"hp")

async: true 在任务被接受后立即返回；collect 不会干扰同一客户端上的其他任务。

## 模型与推理等级

默认：每个 new_task 都以官方 Z.ai 通道（builtin:zai-start-plan）的 GLM-5.3-Flash、推理等级
最高（max）启动；可用 config.defaultModel / defaultThought / defaultProvider 改默认。

按次覆盖（仅 new_task 生效）：
    zcode_remote_dispatch(text:"…", new_task:true, model:"GLM-5.3", thought:"high")
可选模型：GLM-5.3-Flash、GLM-5.3；推理等级：low | high | max（max=最高）。

- 模型选择随 createSession 下发，只对新建任务生效；对已有 session 的追加派发无法换模型。
- 派发/collect 结果里的 config 字段是桌面端实际应用的配置（订阅快照回传）。无效值会被
  桌面端静默替换成桌面默认，判断实际生效以该字段为准，不要信远端 agent 的自我报告。

## 寻址语义

设备：device 传已配置的机器名；url 传完整链接；都不传用默认设备。
工作区：不传一律落到 ZCodeProject（注意不是桌面当前活动工作区）。传了就按该客户端已打开的
工作区做精确路径 / 目录名 / 唯一后缀匹配（"dhsh" 匹配 D:\tools\dhsh）。匹配不到或匹配到多个
会报错并列出全部已打开工作区，绝不静默替你挑一个。目标工作区必须已在 ZCode 桌面端打开。

## 验证

1. zcode_remote_devices：返回设备清单 ⇒ 插件已加载。
2. zcode_remote_status：目标在线、有空位、工作区已在列。
3. 最小实连验证：zcode_remote_dispatch(text:"请只回复五个字：DSH-ZCODE-OK",
   new_task:true) —— 回 "DSH-ZCODE-OK" 即全链路通。
4. 需要指定模型时，核对派发/collect 结果回传的 config 字段与要求一致。

## 常见失败外观

- 链接过期/被吊销：中继拒绝或直接断开连接，需重新生成链接。
- 桌面端没运行：workspace-bridge-error(desktop-disconnected)。
- 工作区没打开：报错并列出已打开工作区清单。
- 客户端并发已满：dispatch 立即拒绝并给出计数、指向 zcode_remote_stop，不排队耗掉等待预算。
- 未配置链接：工具会说明需要传什么。

## 已知限制（必须如实告知用户，不要掩饰）

1. 模型与推理等级只对 new_task 派发生效（随 createSession 下发）；对已有 session 的追加
   派发无法更换模型。provider 不能按次指定，只能通过 config.defaultProvider 改默认。
   无效值会被桌面端静默替换成桌面默认——以结果回传的 config 字段为准。
2. 部分客户端（已知惠普机）所有任务的 displayStatus 恒为 null，"最多 3 个并发"的满载拒绝
   因此不触发——并发数需人工控制。

## 规则

1. 链接含 secret：不入库、不进报告、日志脱敏。
2. 一次 dispatch = 目标桌面端一条用户消息。不要为"保险"重复派发同一任务。
3. 同一条链接不要在多处同时使用（单终端约束）。
4. 长任务用 async: true + 多次 collect，不要用超大 wait_seconds 硬等。
5. 派发前确认目标 ZCode 桌面端在运行、目标工作区已打开。
6. 工具报错原样转述（含它给出的候选清单），不要猜测或改写目标。
