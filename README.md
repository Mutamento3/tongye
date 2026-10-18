# 同页 · tongye

人和 AI 一起写的手帐日记本。一天一页，两个人都能改、能批注：照片的拍摄信息、那天聊天的原话、吃了什么，排成一页能骰、能贴的手帐。

**先看再拿：https://tangfanovo.github.io/tongye/** —— 一台假手机，里面是带演示数据的本子，点开哪一页都能换版式、换风格、贴贴纸、留批注。

| 文件 | 是什么 |
|---|---|
| [`book/app.html`](book/app.html) | 整个本子，一个文件，**空的，自己用、部署都用这份**。主页（每一天的热力图、做好的页）→ 选一天 → 交给 AI 排一页 / 自己拼 → 编辑器 |
| [`book/index.html`](book/index.html) | 同一个本子带演示数据，只给上面那台假手机看，别拿去部署 |
| [`server/journal-server.mjs`](server/journal-server.mjs) | 参考后端，零依赖，Node 18+：存页面和批注、存图、推送改动、给 agent 读那天的原料 |
| [`server/journal-mcp.mjs`](server/journal-mcp.mjs) | 给 agent 的 MCP 工具：读原料、放照片、写一页、报进度、看她改了什么、回批注 |
| [`server/BACKEND.md`](server/BACKEND.md) | 接口说明，和「做 9.27 的日记」这句话说出口以后整条链怎么走 |
| [`server/AGENT.md`](server/AGENT.md) | agent 做一页的步骤和规矩 |

## 三种用法

| 想怎么用 | 要什么 |
|---|---|
| 自己拼着玩 | 只要 `book/app.html`，浏览器直接打开。东西存在这台设备上 |
| 两个人和 AI 一起写 | 跑参考后端，手机打开它给的地址；agent 装上 `journal-mcp.mjs` |
| 装进自己的 App | 照 `BACKEND.md` 写同样的路由，或者直接用参考后端，WebView 加载它的地址 |

## 跑起来

```bash
git clone https://github.com/TangfanOVO/tongye.git
cd tongye/server
JOURNAL_TOKEN=换成一串随机字 node journal-server.mjs
# 手机打开 http://<这台机器的地址>:8787/?token=同一串字
```

给 agent 装工具（以 Claude Code 为例）：

```bash
claude mcp add journal -e JOURNAL_URL=http://localhost:8787 -e JOURNAL_TOKEN=同一串字 -- node /你的路径/tongye/server/journal-mcp.mjs
```

在 claude.ai 里打开 `book/app.html` 的话，页面用 Claude 自己的存储，调工具时找的连接器名叫「连环」（作者家里那个），换成你自己的连接器名就行，搜 `callTool("连环"` 那几处。

照片、聊天记录、吃了什么、读书时的书摘、那天的步数睡眠从哪来，`BACKEND.md` 第二节写了格式，书摘和健康没有也行。在本子里点「交给」传的照片，页面会在缩小之前从原图读出拍摄时间、经纬度、光圈快门（JPEG、HEIC 都读），跟着请求一起交给 agent；截图和聊天软件存下来的图一般读不到。参考后端先读 `server/journal-data/sources/` 里的几个 JSON，换成你自己的数据源就行。吃的那一栏能接 [吃了吗](https://github.com/TangfanOVO/have-you-eaten)。

## 小螃蟹和颜文字

| | 去哪儿拿 |
|---|---|
| 小螃蟹动图 | 同页没带。它们来自 [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)，美术保留所有权利，想用请先去那边问作者 |
| 颜文字 | 本子自带一套，设置里能自己粘。想要更多、按心情分好类的，用 [fuyue-kaomoji-drawer](https://github.com/TangfanOVO/fuyue-kaomoji-drawer)（自带 325 枚，也有给 AI 用的 MCP）：参考后端设 `KAOMOJI_FILE` 指向它的库，设置里「从家里拿」就会按心情去那儿拿 |

## 页面和 agent 都守的几条

- 原话一个字不改；不是原话的标「演示」，或者别放。
- 没有的不编：没有 GPS 不画路线，没有 EXIF 不写参数，没有天气就空着。
- 不生图：只用照片、手画感的线和贴纸库里的素材。
- 她藏掉的零件、自己打的字，重做那一页的时候不覆盖。

## 素材

表情、图标、胶带花色、博物馆藏品各有出处和许可，见 [NOTICE.md](NOTICE.md)。演示照片是作者自己拍的，不在开源协议里。

## 协议

[AGPL-3.0](LICENSE)，商用可以另外授权，详见 [COMMERCIAL.md](COMMERCIAL.md)：

| 你打算怎么用 | 要做什么 |
|---|---|
| 只在自己手里用 | 什么都不用做，随便改 |
| 发出去，或者放到网上给别人用 | 整个项目按 AGPL-3.0 开源 |
| 商用，但不想开源 | [开一个 issue](https://github.com/TangfanOVO/tongye/issues/new) 来拿授权 |
