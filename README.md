# Zotero LiveReload

在 Zotero 原生 PDF 阅读器中实时预览 LaTeX 编译结果。默认地址为 `http://10.253.0.9:8765/main.pdf`。

## 安装和使用

从 [最新 Release](https://github.com/dyingjie/zotero-livereload/releases/latest) 下载 Assets 中的 `.xpi` 安装包。[查看更新记录](CHANGELOG.md)。

1. 打开 Zotero → 工具 → 插件，右上角齿轮 → 从文件安装插件，选择 `dist/zotero-livereload-0.1.1.xpi`。
2. 工具 → PDF 实时预览 (LiveReload) → 打开 / 刷新远程 PDF。
3. PDF 顶部只显示“刷新 PDF”和上次成功刷新时间。远程预览按钮会直接重新下载并重载，其他 PDF 标签页则重载自己的本地文件。
4. 自动刷新开关及“设置 PDF 地址…”放在工具 → PDF 实时预览菜单中。

首次使用会在个人文献库创建一个独立的链接附件。文件保存在 Zotero 数据目录的 `livereload/` 内，不会替换其他已有附件。不同 URL 使用不同缓存文件。链接附件不参与 Zotero 文件同步。自动刷新默认关闭，开关会保存；仅在预览标签页或独立阅读窗口打开时轮询。

每 2 秒以 HEAD 检查 ETag / Last-Modified / Content-Length，变化连续稳定两次后下载。通常在编译完成后约 2–4 秒加下载时间更新。服务器不支持 HEAD 或没有版本标头时退回 GET，并比较文件内容。手动刷新跳过 HEAD，使用带唯一查询参数的 GET 立即下载，避免缓存。HTTP 请求超时为 15 秒，自动刷新失败后下次重试。更新时间记录成功触发重载的时间，不代表服务器文件修改时间或页面渲染完成时间；失败时保留上次成功时间。

下载内容必须具有 PDF 文件头及结尾标记，再通过临时文件替换缓存；网络失败和明显不完整的文件不会覆盖上一版。这是基本完整性检查，不替代 PDF 解析。服务器最好在编译成功后原子替换 `main.pdf`，避免向客户端提供编译中间文件。相同秒内修改且大小不变时，Last-Modified/长度可能无法识别，手动刷新可强制检查；可靠的 ETag 可改善检测。

刷新复用 Zotero 原生 `reader.reload()`，阅读位置的保留行为由 Zotero 决定。修改排版可能导致已有批注偏移。工具栏通过阅读器事件注入；安装前已打开的 PDF 可能需要关闭再打开以显示按钮，工具菜单可直接使用。

## 构建与验证

需要 Node.js 和 Windows PowerShell，无 npm 依赖。

```powershell
npm test
npm run build
```

`npm run smoke` 会启动隔离的 Zotero 测试配置，下载默认地址的 PDF，检查菜单、工具栏、页面渲染及原生重载，结束后关闭测试实例。结果写入 `.test-results/smoke.json`。使用独立的 `.test-profile/data`，不访问现有文献库；不要把测试实例的数据目录改成日常使用的目录。

清单允许 Zotero 7–10；本机验证目标为 Zotero 10.0.6，其他版本尚未实机验证。原生阅读器内部属性集中在 `livereload.js`，后续 Zotero 更新可能需要适配。

已通过自动化测试，并在 Zotero 10.0.6 的隔离配置中验证远程 PDF 下载、22 页文档渲染、真实工具栏按钮点击及原生重载。

当前通过 XPI 手动更新。Zotero 10 要求清单提供更新 URL，因此暂用保留域名 `example.invalid`，没有连接任何第三方更新服务；发布时应替换为自己的更新清单地址。

## 发布维护

1. 同步修改 `manifest.json` 和 `package.json` 的版本号，并在 `CHANGELOG.md` 顶部增加对应版本的更新说明。
2. 运行 `npm test`、`npm run build`；涉及阅读器行为时再运行本机 `npm run smoke`。
3. 提交并推送代码，再创建和推送对应标签，例如 `git tag v0.1.2`、`git push origin v0.1.2`。
4. GitHub Actions 自动检查版本一致性、运行测试、打包并创建 Release，附上 XPI 和更新说明。GitHub 托管环境不运行需要内网 PDF 服务的实机测试。

每个发布标签对应固定版本，不移动已发布标签或覆盖已发布附件；修正应发布新版本。Release 页面用于下载发行包，Zotero 插件内自动升级尚未配置。
