# 文藏 · 公众号文章转 PDF

用于个人阅读归档的本地应用。导入公众号文章清单，提取全文和图片，按文章发布日期分别导出 PDF。

## 功能

- 导入 `articles.json`，识别标题、发布日期和链接；每批最多 100 条。
- 勾选逐篇提取，显示状态，支持停止、继续和失败重试。
- 每篇独立 PDF，多篇打包 ZIP；文件名为 `YYYY-MM-DD_文章标题.pdf`。
- 日期缺失标记“日期不详”，重名自动加序号。
- 图片分批读取、去重、缓存并嵌入文档，失败显示原因。
- 支持单篇链接、粘贴正文、HTML/TXT 导入、排版预览和浏览器草稿。

## Windows 使用

1. 下载整个项目并完整解压。
2. 安装 [Node.js](https://nodejs.org/) 22 或以上版本，电脑需已安装 Edge 或 Chrome。
3. 双击 `Start.cmd`，保持启动窗口打开。
4. 浏览器打开 `http://127.0.0.1:8765/`。
5. 选择“JSON 批量”→导入清单→提取正文→“分别导出 PDF”。

普通使用不需要 `npm install`，界面已包含在根目录 `index.html` 中。

清单结构见 [示例文件](docs/articles.example.json)，其中链接为占位符，请替换为自己的文章链接。JSON 摘要不代替全文。

直接双击 `index.html` 可使用粘贴、文件导入和单篇打印；链接提取和自动批量 PDF 需要本地服务。详细说明见 [README.txt](README.txt)。

## GitHub Pages

GitHub Pages 提供静态网页托管。本项目需要 Node.js 读取文章和图片，并调用本机 Edge / Chrome 生成 PDF。因此 GitHub 仓库用于分发源码和本地应用；GitHub Pages 无法独立提供完整功能。

## 开发与测试

开发使用 Node.js 22.13 或以上版本。

```sh
# 用现成界面启动，无需安装前端依赖
npm start

# 运行测试，无需安装前端依赖
npm test

# 修改前端后重新生成根目录 index.html
npm --prefix source install
npm run build
```

Python 可选：已安装时执行独立 ZIP 兼容性测试，否则跳过该项。普通使用无需 Python。服务端仅使用 Node.js 内置模块。

## 目录

| 文件 | 用途 |
| --- | --- |
| `index.html` | 可直接运行的已构建界面 |
| `Start.cmd` | Windows 启动入口 |
| `server.mjs` | 文章、图片和 PDF 本机接口 |
| `pdf-export.mjs` | Edge / Chrome 后台 PDF 转换 |
| `source/` | 前端源码与构建配置 |
| `tests/` | 清单、队列、图片、ZIP、PDF 和接口测试 |
| `ThirdPartyNotices.txt` | 第三方组件许可 |

## 数据和边界

本地服务只监听 `127.0.0.1`，不需要微信或 ChatGPT 登录。读取公众号内容需要联网；遇到微信验证、限制或无法访问会报错，不会绕过验证。音视频和复杂互动组件不保留。

批量清单和正文暂存在当前页面，刷新需重新导入。草稿在当前浏览器中，清理浏览器数据会删除草稿。PDF 转换使用独立临时浏览器目录，不读取个人浏览器登录状态。

仓库仅含程序和合成测试数据，不包含使用者的文章清单、归档或凭据。

## 验证情况

已测试图片队列、日期命名、ZIP 兼容性和服务接口；浏览器中已验证 67 张测试图片完成打印准备。PDF 转换器测试使用注入的执行器，Windows 后台 PDF 转换尚未完成实机验证。

## 许可

项目暂未指定开源许可证。第三方依赖许可见 `ThirdPartyNotices.txt`。
