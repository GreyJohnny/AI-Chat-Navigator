# AI Chat Navigator

一款支持 Google Gemini、ChatGPT、DeepSeek 和豆包网页版的 Chrome / Edge 扩展。扩展会从当前对话中提取用户提问，在页面右侧生成可搜索的 Prompt 目录，并支持跳转、高亮、重命名、置顶和跨会话收藏。界面语言为英文。

## 支持平台

| 平台 | 页面结构 | 历史加载 |
| --- | --- | --- |
| Gemini | 普通 DOM 消息流 | 滚动扫描并按消息定位 |
| ChatGPT | 普通 DOM 消息流 | 向上滚动触发旧消息加载 |
| DeepSeek | 虚拟列表、虚拟滚动 | 跨虚拟窗口累积索引 |
| 豆包 | 虚拟列表、虚拟滚动 | 跨虚拟窗口累积索引 |

## 主要功能

- 自动提取用户提问，不把助手回复和页面侧栏内容加入目录。
- 支持文字、Markdown、纯图片和图文混合 Prompt。
- 纯图片按会话中的索引顺序显示为 **Image 1**、**Image 2** 等；多图会显示图片数量。
- 搜索 Prompt，并跳转、高亮对应消息；较新的提问默认显示在上方。
- 支持自定义导航标题。
- 支持 **Pin & Save**：将 Prompt 置顶到当前会话的 **Pinned** 区域，并加入全局 **Saved** 视图。
- Pinned 支持折叠、独立滚动和拖动分割条。
- Saved 按平台分组，支持搜索、跨会话和跨平台跳转。
- 自动更新新增提问、修改后的文本和页面内切换的会话。
- 点击 **Load full history** 扫描较早的聊天记录，扫描结束恢复原来的阅读位置。
- 扫描期间可点击 **Stop**，也可通过滚轮、触摸或翻页中断；已扫描的结果会保留。
- 点击已从页面卸载的历史 Prompt 时，会重新滚动加载并按消息身份定位。
- 鼠标悬停 Prompt 卡片可查看完整内容；超长内容可在左侧 Tooltip 内滚轮滚动查看。
- 面板放在 Shadow DOM 中，减少与网页原有样式的冲突。

## 平台适配

### Gemini

- 适配 `user-query`、`m-user-query` 等消息结构。
- 排除助手回复和页面无障碍冗余文本。
- 支持文字和图片 Prompt。

### ChatGPT

- 根据当前 ChatGPT DOM 使用 `.bg-user-message` 识别用户 Prompt 容器。
- 使用容器内部的 `.whitespace-pre-wrap` 读取 Prompt 正文。
- 用户消息容器同时作为目录条目、跳转目标和高亮目标。
- **Load full history** 会向上滚动页面，触发 ChatGPT 加载较早的消息。
- 扫描完成后恢复用户原来的阅读位置。
- 过滤路由切换后仍残留在 DOM 中的隐藏旧会话，避免不同会话之间串 Prompt。
- 跳转时网页临时卸载消息节点不会导致侧栏 Prompt 消失或快闪。

### DeepSeek

- 适配 DeepSeek 的虚拟列表和用户消息气泡。
- 按用户消息容器、消息 ID 或稳定的虚拟行位置分别记录 Prompt，避免多条 Prompt 被错误合并。
- 消息离开虚拟窗口后仍保留索引，可继续搜索、重命名和收藏。
- 过滤隐藏旧会话，并给索引增加版本校验，避免使用旧版本产生的污染缓存。

### 豆包

- 适配 `send_message` 标记和用户消息气泡结构。
- 排除助手回复、侧栏内容和纯文件附件。
- 支持纯图片和图文混合 Prompt，正文中提到的文件名会正常保留。

## 历史扫描

- **Load full history** 会从当前位置开始滚动扫描，读取尚未出现在 DOM 中的历史消息。
- 扫描采用自适应等待：检测到页面内容或滚动高度变化后立即继续，只有页面没有变化时才等待超时上限。
- ChatGPT 使用普通 DOM 滚动加载；DeepSeek 和豆包使用虚拟列表窗口扫描。
- 单轮扫描最多持续约两分钟。超时后会保留部分结果，可以再次扫描继续补充。
- 如果本地历史索引读取失败或超时，不会禁用 **Load full history**。

## 安装

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目文件夹。
5. 打开或刷新 [Gemini](https://gemini.google.com/app)、[ChatGPT](https://chatgpt.com/)、[DeepSeek](https://chat.deepseek.com/) 或 [豆包](https://www.doubao.com/chat/) 对话页。
6. 点击页面右侧的 **Navigator** 按钮。

更新代码后，在扩展管理页点击扩展卡片上的重新加载按钮，再刷新对话页面。`2.5.0` 新增 ChatGPT 和 DeepSeek 站点权限，浏览器可能提示确认访问权限。

## 使用说明

- 搜索框只过滤当前平台当前会话中已索引的 Prompt。
- 左侧 Tooltip 显示 Prompt 的完整索引文本；超长内容限制高度后可在 Tooltip 内滚动。
- 首次打开长对话时，目录可能只包含已经加载的部分，此时点击 **Load full history**。
- 跨会话收藏跳转会等待页面加载并重试；超时后会提示重新加载历史。
- 网站的地区限制、登录限制或页面结构变化仍由对应网站决定。

## 数据与隐私

- Prompt 文本、图片数量、标题、收藏和消息定位信息保存在浏览器本地。
- 不缓存图片文件或图片地址。
- 不把 Prompt、标题或收藏发送到外部服务。
- 扩展只在以下站点运行：
  - `gemini.google.com`
  - `chatgpt.com`
  - `chat.openai.com`
  - `chat.deepseek.com`
  - `doubao.com` 的 `/chat` 页面

## 本地开发

此扩展运行时不需要构建步骤或第三方依赖。核心文件：

- `manifest.json`
- `src/content.js`
- `src/history.js`
- `src/style.css`

安装测试依赖并运行检查：

```bash
npm ci
npm run check
npm test
```

测试使用 jsdom 验证四种站点的消息识别、搜索跳转、数据持久化、会话隔离、虚拟列表回收、历史分页、自适应扫描、索引超时、排序和 Tooltip。自动测试不能完全替代真实网页验证。

## License

MIT，见 [LICENSE](LICENSE)。
