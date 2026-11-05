# 内网快传（lan-drop）

组内传文件、发消息的网页工具。只需要一台电脑运行服务，其他同事用浏览器打开网址就能用，什么都不用安装。

## 启动

运行服务的电脑需要 Node.js 20 或更高版本。

```bash
npm install
npm run build
npm start
```

终端会显示访问地址和访问口令，把这两项发给同事即可。

- **选对地址：** 如果显示了多个地址，用公司内网的那个。
- **防火墙：** 系统询问是否允许 Node 接受连接时要选允许，否则同事打不开。
- **防止休眠：** 电脑休眠后全组都用不了。Mac 可以用 `caffeinate -i npm start` 启动，这样开着盖子不会休眠；合上盖子仍会休眠。

### 运行服务的电脑装不了依赖

运行时不依赖任何第三方包，TypeScript 只在构建时用到。可以在别的电脑上执行 `npm install` 和 `npm run build`，然后把 `dist/`、`public/`、`package.json` 拷过去，运行：

```bash
node dist/server/main.js
```

## 功能

- 查看在线同事，对方离线也可以发，上线后能收到
- 给个人或全组发文件：选择文件或直接拖进窗口，显示进度，可以取消和重试
- 发文字消息，新消息有未读数和标题闪烁提醒
- 深色和浅色主题，默认跟随系统

## 使用限制

- 单个文件最大 20 MB，不支持直接发文件夹
- 文件 24 小时后自动删除，文字消息保留 7 天
- 所有文件的总容量上限是 2 GB，满了之后要等旧文件过期
- 走 HTTP，内容没有加密，不建议传高度敏感的文件
- 同一个浏览器不要同时开太多标签页：HTTP 下同一网站最多 6 条连接，每个标签页占一条

## 配置

都是可选的环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LAN_DROP_PORT` | `8000` | 端口 |
| `LAN_DROP_HOST` | 所有网卡 | 只监听某个地址时才需要设置 |
| `LAN_DROP_CODE` | 自动生成 | 访问口令 |
| `LAN_DROP_DATA_DIR` | `./data` | 数据目录 |
| `LAN_DROP_MAX_FILE_MB` | `20` | 单文件大小上限 |
| `LAN_DROP_MAX_STORAGE_GB` | `2` | 文件总容量上限 |
| `LAN_DROP_FILE_TTL_HOURS` | `24` | 文件保留时间 |

```bash
LAN_DROP_PORT=8001 npm start
```

Windows PowerShell 的写法是 `$env:LAN_DROP_PORT=8001; npm start`。

## 数据和口令

运行数据都在 `data/` 目录，不会进入 Git：

| 路径 | 内容 |
|---|---|
| `access-code.txt` | 自动生成的访问口令 |
| `users.json` | 同事和登录会话（只存令牌的哈希值） |
| `messages.jsonl` | 消息记录，一行一条 |
| `files/` | 上传的文件，文件名是随机 id |

- **换口令：** 删除 `access-code.txt` 后重启。已登录的同事不受影响。
- **让所有人重新登录：** 停止服务，删除 `users.json`，再启动。
- **清空全部数据：** 停止服务，删除整个 `data/` 目录。

## 代码结构

```
public/              页面骨架和样式，颜色变量都在 style.css 开头
src/shared/types.ts  前后端共用的类型
src/server/
  main.ts            启动入口，打印访问地址
  config.ts          读取配置，生成口令
  app.ts             所有 HTTP 接口，从底部的 route 函数开始看
  store.ts           数据读写和定期清理
  events.ts          SSE 长连接管理，判断谁在线
src/web/
  app.ts             页面逻辑：状态 + 渲染函数
  api.ts             和服务器通信
  format.ts          大小、时间的显示格式
src/test/            服务端集成测试
```

### 发一个文件时发生了什么

1. 浏览器把文件的原始字节 `POST` 到 `/api/files?to=接收人&name=文件名`。
2. 服务器先检查登录状态、大小和容量，再把内容写入临时文件。
3. 写完后改成正式文件名，并追加一条文件消息。
4. 服务器通过 SSE 把消息推送给能看到它的人，对方页面立刻显示下载按钮。
5. 对方点击下载时，服务器再检查一次权限，然后按附件返回文件。

### 为什么这样设计

- **文件经服务器中转，不用 WebRTC 直连：** 只要能访问服务器的一个 TCP 端口就能用，对方离线也能收。
- **实时推送用 SSE，不用 WebSocket：** Node 内置模块就能实现，不需要第三方库。发送走普通 POST，推送只需要单向。
- **上传文件时要求带 Content-Length：** Node 不会读取超过这个长度的内容，提前检查它就能保证文件不超限。
- **下载一律按二进制附件返回：** 否则有人上传 HTML 文件，浏览器可能直接执行里面的脚本。

## 开发

```bash
npm test
```

`npm test` 会先构建，再运行 `src/test/server.test.ts` 里的集成测试，它们会启动真实的 HTTP 服务器。改完代码要重新执行 `npm run build`，然后重启服务。
