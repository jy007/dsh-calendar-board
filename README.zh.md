# 日历看板 · Calendar Board for DSH

[English](README.md) · **中文**

给 [DeepSeek Harness](https://deepseek.com) 桌面端加一块**月视图日历看板**：每天要做的事、DSH 里设置的定时任务、点击日期格直接编辑，勾掉一条就放烟花。

![日历看板截图](docs/preview.png)

> 纯前端插件，无构建步骤、无第三方依赖、不上传任何数据。事项存在本机页面的 localStorage 里，定时任务只读。

## 功能

**月视图**
- 周一起始的整月网格，带 ISO 周号、农历（`Intl` 中国历）、今天高亮、跨月补格
- 每格显示当天前 3 条事项与剩余条数，颜色/下划线/删除线原样呈现

**直接编辑**
- 点任意日期格即进入编辑：格子内出现输入框，回车新增一条并保持焦点
- 每条文字可直接点改，**改完即时保存**；Esc 或点到别处退出编辑，未提交的草稿也会自动落盘
- 清空一条文字后离开即删除

**每条事项**
- 勾选完成 → 文字加删除线变灰；再点取消
- 悬停行尾：`U` 下划线开关、`●` 循环换色（默认/红/橙/绿/蓝）、`×` 删除
- 右侧当日面板按 `1. 2. 3.` 编号，带完成进度条

**本机日历（零配置）**
- macOS 上直接读系统「日历」：里面已经同步的 Google、飞书、Outlook 账号全都在，不需要注册应用、不需要粘贴任何地址
- 点 **+ 连接日历** → 在「本机日历（macOS）」里勾选要显示的日历即可；首次读取会弹系统的「允许 DSH 控制日历」
- 读取在后台进行并缓存，日历很大也不会卡住月视图

**订阅个人日历**
- 用任意 iCalendar 订阅地址接入：Google 日历、飞书、Outlook、Apple 日历的「私密 iCal 地址」都行，日程与自己的事项并列显示
- 每个来源一种颜色，顶栏图例可逐个开关
- 支持每日/每周（`BYDAY`）/每月/每年重复，`COUNT`、`UNTIL`、`EXDATE`，全天事件，`TZID` 当地时间与 UTC 时间，都会展开进当前月
- 订阅由 Host 拉取并缓存 10 分钟，页面里不执行任何第三方脚本

**定时任务叠加**
- 读取 DSH 的 `schedule` 服务，把 daily / weekly / 一次性 / every / cron 提醒按天展开进日历
- 顶栏徽标显示同步状态；Host 侧另有只读路由 `/calendar-board/schedules` 作为备用数据源

**完成庆祝**
- 完成一条：三音琶音（WebAudio 实时合成）+ canvas 烟花 + 纯 CSS 彩带 + 顶部气泡
- 顶栏 `✦` 可随时预览效果，喇叭可一键静音（状态本地保存）
- 尊重系统「减少动态效果」

**其他**
- 每日提醒（系统通知，按设定时间触发）
- 中英文界面，全部使用 DSH 主题 token，深浅色自动适配

## 安装

### 一键安装（推荐）

在 DSH 里开一个新会话，对助手说一句：

```
安装插件 github:jy007/dsh-calendar-board
```

助手会调用插件管理器的 `install_bundle` 完成安装。装完侧栏出现日历图标；如果没出现，重载窗口或重启 DSH。

### 手动安装

```bash
git clone https://github.com/jy007/dsh-calendar-board.git ~/plugins/dsh-calendar-board
```

然后在 DSH 里让助手把 `~/plugins/dsh-calendar-board` 安装为 bundle，或在插件管理器里选择该本地目录。

### 使用本机已有的日历

点 **+ 连接日历**，在「本机日历（macOS）」里勾选即可。首次读取会请求「允许 DSH 控制日历」（系统设置 → 隐私与安全性 → 自动化），允许一次就够了。

### 更新

```bash
cd dsh-calendar-board && git pull
```

然后在 DSH 里重新安装一次 `github:jy007/dsh-calendar-board`。插件安装的是**快照副本**，不会自动跟随仓库变化；面板右下角的 `vX.Y.Z` 就是当前运行版本。

### 卸载

在插件管理器里移除 `dsh-calendar-board` 即可；事项数据随浏览器本地存储保留。

## 使用

1. 点侧栏的**日历图标**打开面板
2. 点某一天，直接在格子里写今天要做的事（回车继续写，Esc 退出）
3. 勾选事项 → 音效 + 烟花；悬停可换色、加下划线、删除
4. 顶栏：`‹ ›` 换月、`今天` 回到本月、`+ 添加今天`、`每日提醒`、`✦` 预览烟花、喇叭静音、`⟳` 重新同步定时任务

## 让 Agent 直接读写看板

Host 半是唯一的数据源，所以**任何 DSH 会话**都能通过一个工具读改看板，不需要截图、不需要猜：

```jsonc
{ "action": "list", "from": "2026-11-02", "to": "2026-11-08" }
{ "action": "add", "date": "2026-11-06", "title": "给 adon 发邮件", "time": "10:00" }
{ "action": "complete", "id": "itmw3c6bd3c83xd" }
{ "action": "remove", "id": "itmw3c6bd3c83xd" }
```

| action | 参数 | 说明 |
| --- | --- | --- |
| `list` | `date` 或 `from`/`to`、`includeDone` | 返回 `id`、`date`、`time`、`title`、`done`、`repeat`、`color` |

所有 action 统一返回 `{ "ok": true, ... }`：`list` 额外带 `today`、`count`、`items`，其余返回被改动的 `item` 或 `removed`。
| `add` | `title`，可选 `date`（默认今天）、`time`、`repeat:"daily"` | 新增一条 |
| `update` | `id` + `title`/`date`/`time`/`repeat`/`color`/`underline` 任意项 | 原地修改 |
| `complete` | `id`，可选 `date`、`done` | 勾选/取消某一条的某一天 |
| `remove` | `id` | 删除 |
| `sources` | – | 列出本地、定时任务、订阅三类来源及颜色 |
| `events` | `from`/`to` | 某时间窗内所有订阅来源的日程 |
| `subscribe` | `name`、`url` | 新增 iCal 订阅（`webcal://` 会自动改写） |
| `unsubscribe` | `id` | 取消订阅 |
| `toggleSource` | `id`、`enabled` | 显示/隐藏某个来源 |
| `calendars` | – | 本机「日历」里可用的日历（已加进看板的会标出来） |
| `subscribe` | `provider:"local"`、`calendarId`、`color` | 把一个本机日历加到看板 |

可以直接对助手说：

- 今天还剩哪些事没做？
- 帮我加一条：明天 10 点给 adon 发邮件
- 把「吃小龙虾」标记完成

其他插件也可以直接调用同一个实现（Host 服务 `calendarBoard`）。

## 数据与隐私

| 内容 | 位置 |
| --- | --- |
| 你写的事项 | Host 侧 `<DSH_HOME>/storages/calendar-board/items.json`；页面保留一份 localStorage 缓存 |
| 订阅的 iCal 地址 | `<DSH_HOME>/storages/calendar-board/sources.json`；日程只在内存里缓存 |
| 图例里关掉了哪些来源 | 浏览器 localStorage：`dsh-calendar-board.hidden-sources.v1` |
| 音效开关 | `dsh-calendar-board.sound.v1` |
| 每日提醒开关 | `dsh-calendar-board.notify.v1` |
| 定时任务 | 只读，来自 DSH `schedule` 服务，不落盘 |

页面本身除本机 DSH 的 HTTP 端口外不发请求。订阅地址只在显示某个月时由 Host 拉取一次（缓存 10 分钟），因此日历服务商看到的是这台机器的请求 —— 私密 iCal 地址请当作密码对待。面板底部会显示 `已同步 Host` / `仅本机保存`，一眼能看出它有没有接上 Host 存储。

## 兼容性

- DSH Desktop NEXT（`desktop-next` profile，Web GUI）
- 使用 Client slots：`sidebar.panellist`（图标）、`main`（面板）
- 可选依赖 Host 服务 `schedule`（缺失时顶栏显示「定时任务不可用」，其余功能正常）与 `webServer`（缺失时只用 remote 通道）

## 发布 / 作为索引源

本仓库自带一份 [format 1 市场索引](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)：`dsh-index.json`，不需要任何服务器就能被 DSH 当成插件源：

```
https://cdn.jsdelivr.net/gh/jy007/dsh-calendar-board@main/dsh-index.json
```

在 **插件 → 发现 → 添加索引源** 粘贴上面的地址，就能搜到本插件并一键安装。

想让插件进入更大的社区市场：向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，它的目录每天会被重新发布成大多数 DSH 市场读取的索引。

市场要求每个版本声明 `engines.dsh`；本包声明 `>=0.2.1-rc.2`（DSH Desktop NEXT 2.0.19 内置的运行时）。

## 开发

```
dsh-calendar-board/
├── package.json        # dsh.bundle / dsh.client 清单
├── cordis.patch.yml    # 插入 calendar-board 这一行
├── index.js            # Host 半：只读 schedules 路由
├── client.js           # Client 半：面板 + 侧栏图标（classic script，IIFE 包裹）
├── locale/{zh,en}.json # 插件管理器里的标题与描述
└── icon.svg
```

注意：`client.js` 由页面以**经典脚本**加载，HMR 会重复求值同一份文件，因此所有声明都包在 IIFE 里 —— 否则第二次求值会抛 `Identifier '...' has already been declared`。

本地开发时把目录链接进 profile 即可：

```
安装插件 /绝对路径/dsh-calendar-board
```

改 `client.js` 后 HMR 会热加载；改 `index.js`（Host 半）需要重启 DSH。

## 更新日志

- **1.5.1** — 适配 DSH 0.2.2（2.0.22-next）：服务必须在 `export const inject` 里以数组声明，工具与 HTTP 路由因此恢复注册；本机日历面板打开时不再抛错
- **1.5.0** — 定时任务只在今天和明天显示，并按运行状态配色（今日待运行红、明日未运行黄、已运行/已过期灰），每 30 秒刷新；图例里的「我的事项」「定时任务」现在会真正隐藏对应内容；移除 Google OAuth，日历来源只剩 iCal 订阅与本机日历
- **1.4.0** — macOS 本机日历读取（走 Calendar.app，零 OAuth、零地址粘贴），连接面板里可选日历，后台读取并缓存
- **1.3.0** — Google 日历授权登录：OAuth 2.0 + PKCE、回环重定向、token 刷新、`calendarList` + `events.list` 同步；工具新增 `connect` / `disconnect` / `accounts` / `calendars`
- **1.2.0** — 日历订阅：iCal 源（Google / 飞书 / Outlook / Apple），按来源配色，图例可逐个开关；工具新增 `sources` / `events` / `subscribe` / `unsubscribe` / `toggleSource`
- **1.1.2** — 迁移改为页面加载时就执行，不依赖打开日历面板
- **1.1.1** — 面板每 15 秒重试一次 Host 连接，不再因首次失败永久留在本机模式
- **1.1.0** — Host 侧存储 + `calendar_board` Agent 工具 + `calendarBoard` 服务；面板改为同步 Host 存储，不再只存在 localStorage
- **1.0.1** — README 截图；面板版本号改为跟随包版本
- **1.0.0** — 首个公开版本：月视图、内联编辑、完成/下划线/换色/删除、定时任务叠加、完成音效 + 烟花 + 彩带

## License

MIT © 2026 jy007
