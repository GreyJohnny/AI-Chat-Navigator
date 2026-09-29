# Gemini Chat Navigator

一款只针对 Google Gemini 网页版的 Chrome / Edge 扩展。它会从当前对话中提取用户提问，生成可搜索的侧边目录，并支持跳转、高亮、重命名和收藏。

## 功能

- 自动扫描 Gemini 对话里的用户提问，适配 `user-query`、`m-user-query` 等页面结构。
- 通过侧边栏搜索提问，并平滑跳转到对应消息。
- 支持自定义导航标题和收藏。
- 标题与收藏保存在浏览器本地存储中。
- 面板收纳在 Shadow DOM 中，减少与 Gemini 页面样式冲突。
- 只在 `gemini.google.com` 上运行。

## 安装（开发者模式）

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目文件夹。
5. 打开或刷新 Gemini 对话页，点击页面右侧的“导航”按钮。

更新代码后，在扩展管理页点击扩展卡片上的刷新按钮，再刷新 Gemini 页面。

## 本地开发

此扩展不需要构建步骤或第三方依赖。核心文件为 `manifest.json`、`src/content.js` 和 `src/style.css`。

## License

MIT，见 [LICENSE](LICENSE)。
