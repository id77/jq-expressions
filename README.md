# jq 表达式可视化生成器

一个纯前端的 JSON 编辑与 jq 表达式生成工具。无需安装或启动后端服务，打开页面即可使用。

**在线使用：**[https://id77.github.io/jq-expressions/](https://id77.github.io/jq-expressions/)

## 功能

- 粘贴或编辑 JSON，并在树形视图中查看和编辑字段。
- 添加赋值、默认值、条件判断、数组映射、`with_entries`、原始 jq 等操作。
- 生成单行或多行 jq 表达式，并支持导入已有表达式继续编辑。
- 在页面中执行 jq 表达式、预览结果，并比较输入与目标 JSON。
- 支持撤销、剪贴板粘贴和复制。

## 隐私与数据处理

- 本项目是静态前端页面，没有自建后端、账号系统、数据上报或应用内数据存储。
- 输入的 JSON、jq 表达式和生成结果均在当前浏览器中处理；本项目页面代码不会上传或发送这些编辑内容。
- 结果预览依赖 `jq-web@0.6.2`，由 jsDelivr CDN 提供。浏览器打开页面时会向 GitHub Pages 主机和 jsDelivr 请求页面资源；这些服务会收到正常的网络请求信息。
- 剪贴板仅在用户点击粘贴或复制按钮时通过浏览器 API 访问。浏览器权限、扩展程序或设备上的其他软件不属于本页面可控制的范围。
- 由于 jq 执行库从 CDN 加载，打开页面时需要能够访问 jsDelivr。若需要完全离线或不依赖第三方 CDN，可将该依赖作为仓库内的本地静态文件发布。

## 发布到 GitHub Pages

本仓库通过 GitHub Actions 自动发布 Pages。将改动推送到 `main` 分支后，工作流会部署仓库根目录；也可以在 **Actions → Deploy to GitHub Pages → Run workflow** 手动触发。

首次部署完成后，可在仓库的 **Settings → Pages** 查看站点状态和网址。站点地址为 [https://id77.github.io/jq-expressions/](https://id77.github.io/jq-expressions/)。

此项目没有构建步骤，也不需要安装依赖。

## 本地预览

直接用现代浏览器打开 `index.html` 即可。剪贴板 API 通常要求 HTTPS 或 localhost 等安全上下文；部署到 GitHub Pages 后使用 HTTPS 即可。

## 技术说明

- 页面：原生 HTML、CSS 和 JavaScript。
- jq 执行与结果预览：`jq-web@0.6.2`（jsDelivr CDN）。
- 无构建工具、服务端代码或运行时包安装步骤。
