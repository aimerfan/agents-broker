# cc-sessions-broker

讓多個各自獨立開啟的 Claude Code session 在 Windows 上經由一個常駐 broker 互通訊息。

> **狀態:已終止(2026-09-14)。** 前提由官方在 Claude Code 2.1.239 解決,Windows
> 已原生支援 cross-session `SendMessage` / `ListAgents`,並於 2.1.270 實測通過。
> 理由與實測見文末〈結語〉。以下本文保留 2026-08-21 的原樣,未回頭修訂。

狀態(原文,2026-08-21):地基驗證完成,spike 可跑,正式實作未開始。

## 為什麼要做

官方的 cross-session `SendMessage` / `ListAgents` 走 Unix domain socket,changelog 至今仍標 **(macOS and Linux)**,Windows 是整條通道缺席,不是某個 flag 沒開。本機是 Windows,所以要自己接。

同一 session 內用 `Agent` 開出來的 subagent 不受影響(走 in-process,不經 socket),本專案只解決**跨終端機視窗**的情境。

## 需求

- **頻道語意**,不是點對點。建立頻道後參與的 session 在上面分享進度,fan-out 由 broker 負責
- **保留 >2 參與者的能力**,即使目前場景只有兩個 session
- **in-memory**,訊息不經檔案系統,不在硬碟散落小檔案(非硬性要求,但已確認可做到)
- **Windows 可用**

## 架構

```
session A ──ws 訂閱──┐                      ┌──ws 訂閱── session B
                     ├──> broker (in-mem) ──┤
session A ──POST 發送─┘   channels{}         └──POST 發送── session C
                          ring buffer(未實作)
```

- **訂閱**用 Monitor 的 `ws` source,broker push 的每個 text frame 直接變成對話裡的事件
- **發送**用 Bash `curl -X POST`,body 帶 channel、sender、text
- **fan-out 在 broker 做**,session 端不需要知道有誰在線
- **落盤的只有 broker 那一支腳本**,訊息全在進程記憶體

## 已驗證的地基(2026-08-21 實測)

| 驗證點 | 結果 | 怎麼驗的 |
|---|---|---|
| Monitor 事件能中斷 idle session | **成立** | 起 Monitor 盯一個檔案後閒置,從另一個 PowerShell 視窗 append 一行,對話自己起了一輪 |
| Monitor `ws` 在 Windows 能連 | **成立** | `Monitor({ws: {url: 'ws://127.0.0.1:8787/sub?channel=spike&as=claude-A'}})`,訂閱確認 frame 以事件抵達 |
| 外部 POST → broker fan-out → 事件抵達 idle session | **成立** | 外部 `Invoke-RestMethod` POST `/pub`,回 `delivered: 1`,同時對話跳出 `[spike] ryan: hello from another terminal` |

第一點是整個專案的分水嶺:**成立才是即時通訊,不成立就只是留言板**。已成立。

### 重現步驟

```
node broker.js                                    # 起 broker(localhost:8787)
curl -s http://127.0.0.1:8787/health              # 應回 {"ok":true,"channels":{}}
```

session 端訂閱:

```
Monitor({ws: {url: "ws://127.0.0.1:8787/sub?channel=spike&as=claude-A"},
         description: "messages on broker channel 'spike'",
         persistent: true, timeout_ms: 3600000})
```

外部發送(另一個 PowerShell 視窗):

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/pub" -Method Post -ContentType "application/json" `
  -Body '{"channel":"spike","sender":"ryan","text":"hello from another terminal"}'
```

**否證點**:貼完 POST 後對話沒有自己跳出訊息,就是這條路不通。

## 先例調研:沒有一個同時滿足需求

| 專案 | 傳輸 | 收訊 | Windows | 拓樸 | 為何不用 |
|---|---|---|---|---|---|
| [inter-session](https://github.com/yilunzhang/claude-code-inter-session) | localhost WebSocket + Monitor | push,ms 級 | 自稱 Unix-only | peer 名字 + broadcast | **架構與我們相同**,但要改的正好是它的核心:peer 拓樸、Python、落盤 |
| [claude-chat](https://github.com/neeboo/claude-chat) | WebSocket + web UI | `tmux send-keys` | 不可能 | `@all` 廣播 | 見下 |
| [agent-bus](https://github.com/MustaphaSteph/agent-bus) / [agent-bus-mcp](https://github.com/alessandrobologna/agent-bus-mcp) | SQLite | **pull**,要自己呼叫 `sync()`/inbox | 未提 | 有 named topic | pull 就是留言板,叫不醒 idle session |
| [walkie-talkie](https://github.com/suruseas/walkie-talkie) | Hub + MCP + HTTP long polling | agent 掛在「聽→回→再聽」loop | 未提 | callsign | long polling 佔著 session,那不是 idle |
| [agent-comms-mcp](https://github.com/watchout/agent-comms-mcp) | pg_notify + webhook | 宣稱自動注入 | 未提 | 點對點 | 要 PostgreSQL,過重 |

### claude-chat 為什麼不行(表面最像,實際最遠)

`src/index.ts:361` 的投遞方式:

```ts
await $`tmux send-keys -t ${tmuxTarget} "'${formattedMessage}'"`;
await $`tmux send-keys -t ${tmuxTarget} Enter`;
```

它是**模擬鍵盤把字打進終端機**。後果:

- Windows 沒有 tmux,投遞層根本不存在
- 訊息以使用者身分進入,**帶完整 user authority**,對方會當指令執行 —— 官方 SendMessage 刻意不這麼做,Monitor 路徑天然避開(事件是資料,不是指令)
- 需要 `--dangerously-skip-permissions`,README 自陳「For personal research only. NOT for production use」
- 協作紀律靠 `CLAUDE_TEMPLATE.md` 塞 prompt 協議維持(「[URGENT] 必須 2 小時內回覆」),是約定不是機制

### inter-session 的 Unix-only 是三個移植點,不是架構障礙

| 卡點 | 位置 | Windows 實情 |
|---|---|---|
| `import fcntl` | `client.py:22`、`discover.py:105` | Unix-only 模組,import 當場失敗。用途僅是 `flock` 做單例鎖 |
| venv 路徑寫死 `bin/python` | `client.py` bootstrap | Windows venv 是 `Scripts/python.exe` |
| `start_new_session=True` | `spawn.py:88` | Windows 不支援,要用 `creationflags=DETACHED_PROCESS` |
| `python3` 指令名 | `monitors/monitors.json` | Windows 通常只有 `python` |

WebSocket bus 與 Monitor 本身跨平台,已實測。

### 值得從 inter-session 抄的設計(它踩過的)

- **單例鎖**:每個 session 只能有一個 listener,避免重複訂閱
- **rate limit + 訊息長度上限**:server 端就擋,它有 `broadcast rate limit exceeded`
- **idle shutdown**:沒有 client 連線就自己退場(預設 10 分鐘),不留孤兒進程
- **`peer_joined` 事件**:上線下線廣播給頻道其他人
- **`userConfig` 放 port 與 idle timeout**:plugin manifest 就能設定,不必改 code

它的 `monitors/monitors.json` 用法(這是 plugin 自動 arm Monitor 的實例):

```json
{
  "name": "inter-session-client",
  "command": "python3 ${CLAUDE_PLUGIN_ROOT}/skills/inter-session/bin/client.py",
  "description": "inter-session messages",
  "when": "on-skill-invoke:inter-session"
}
```

## 未決事項

**必須先查證的一條**:plugin 的 `monitors` manifest **支不支援 `ws` source**?

- 支援 → 免掉常駐 client 進程,Monitor 原生連 broker,比 inter-session 少一整層
- 不支援 → 自動 arm 得寫一支 ws-to-stdout 橋接進程,這也解釋了 inter-session 為何用 Python client

註:manifest 現在應宣告在 `"experimental": { "monitors": ... }` 底下,頂層仍可用但 `claude plugin validate` 會警告。另有安全限制:monitors 的 shell-form command 不接受 `${user_config.*}`,值要在腳本內自己讀。

**其餘待決**:

- **落地形態**:plugin(`experimental.monitors` 自動 arm + skill 包發送)/ 專案內腳本 / 先最小可用再打包
- **broker 由誰起**:手動起一次(狀態清楚) / 第一個 session 偵測後 detached spawn(省事,但要處理搶跑與孤兒)
- **ring buffer**:要不要在 broker 留最近 N 則,讓中途加入的 session 連上時回放。幾行的成本,決定「第三個 session 中途加入」有沒有意義
- **身分**:session 端自己帶名字進 POST body,或想辦法拿 session 識別

## 已知陷阱(實際踩過)

- **`TaskStop` 不殺 msys 子進程**。Monitor 逾時也一樣。第一次的 `tail -f` 從 11:37 一直活到手動 `kill`,自製工具必須自己管 PID 回收 —— 這也是 idle shutdown 值得抄的理由
- **`tail -f` 持有 handle 會擋掉 Windows 寫入**。PowerShell `Add-Content` 會報 "being used by another process"。走檔案就得用「每 tick 開關檔案」的輪詢;走 broker 則完全繞開
- **PowerShell 5.1 的 `Invoke-RestMethod` 送 body 會踩 CJK 編碼**。正式版要處理,spike 階段一律用英文避開
- **Monitor 事件不帶 user authority**。內容是資料不是指令,即使寫「請執行 X」也只會回報給使用者。這與官方 SendMessage 同等條件,不是自製版的缺陷

## 目前的檔案

- `broker.js` — spike 版 broker,約 100 行,可跑。HTTP `/pub` 發送、WebSocket `/sub` 訂閱、`/health` 檢視。**尚未有** ring buffer、rate limit、單例鎖、idle shutdown、認證
- `package.json` / `node_modules/` — 只依賴 `ws`(Node 內建只有 WebSocket client,沒有 server)

尚未 `git init`。

---

## 結語:專案終止(2026-09-14)

**前提已由官方解決。本專案不再實作。**

Claude Code **2.1.239** changelog:

> Windows: cross-session messaging is now available, so Claude Code sessions
> across your machines can message each other with `SendMessage` and find each
> other with `ListAgents`, as on macOS and Linux

本文開頭「官方通道走 Unix domain socket,Windows 整條缺席」在 2026-08-21 成立,
現在不成立。

### 實測(2026-09-14,Claude Code 2.1.270,Windows 11)

兩個各自獨立開啟的終端機 session 對測,三條全過:互相在 `ListAgents` 看得見、
`SendMessage` 送得到、**且訊息在對方 idle 時抵達並喚醒它,無任何使用者輸入**。

第三條正是本文〈已驗證的地基〉標為「整個專案分水嶺」的那一條。官方路徑現已自行滿足。

### 需求對照

| 原需求 | 現況 |
|---|---|
| Windows 可用 | 官方已解決。這是整個專案存在的理由 |
| 訊息能中斷 idle session | 官方原生語意,不需要 Monitor 撐著 |
| 訊息不落盤 | 官方有落盤。原文已標為非硬性要求 |
| 身分(未決事項) | 已解決:`ListAgents` 會告訴 session 它自己的名字 |
| **頻道語意 / fan-out** | **唯一未被官方覆蓋的**。官方是點對點,按名字送 |

官方路徑另外附帶了本專案「尚未實作」清單裡的 rate limit、訊息長度上限、收訊開關,
以及本文〈已知陷阱〉提過的「訊息不帶 user authority」。相對地,自製 broker 要自己
扛 PID 回收(見〈已知陷阱〉第一條,已踩過)。

### 剩下的 delta

只有 fan-out,以及「中途加入的 session 回放最近 N 則」。但成本結構變了:以前要一支
常駐 broker 才做得到,現在是 `ListAgents` 拿名單 → 迴圈 `SendMessage`,十幾行的 skill
就到頂。三個 session 的場景用不著常駐進程。

### 保留與作廢

**保留**:〈已驗證的地基〉那三條實測不作廢。它們證明的是 Monitor `ws` source 在
Windows 可用、且外部事件能中斷 idle session —— 這個結論與本專案存亡無關,日後任何
要把外部事件推進 Claude Code 對話的設計都還用得上。

**作廢**:〈未決事項〉中「plugin `monitors` manifest 支不支援 `ws` source」一條
不再需要查證。〈目前的檔案〉末句「尚未 git init」已過時(repo 已建立)。
