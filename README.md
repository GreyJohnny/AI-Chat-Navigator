# AI Chat Navigator 🚀

[English](#english) | [中文](#中文)

---

## English

A high-performance browser extension designed for AI heavy users. It provides real-time context indexing and precision navigation for **Doubao** and **Google Gemini**.

![Project Icon](icons/icon128.png)

### ✨ Core Features
- **Smart Context Indexing**: Automatically extracts user prompts to build a real-time navigation sidebar.
- **Multimodal Support**:
    - **Image Detection**: Accurately detects images, canvases, and native `<img>` tags.
    - **Auto-Numbering**: Assigns ordered labels (e.g., *Picture 1, Picture 2*) to pure image messages.
- **Deep Jump Engine**:
    - **Smooth Scrolling**: Identifies complex nested scroll containers to ensure precise location anchoring.
    - **Visual Feedback**: Triggers a highlight effect on the target block upon navigation.
- **Persistence & Management**:
    - **Custom Renaming**: Allows manual editing of index titles.
    - **Favorites System**: "Star" important conversations; data is persisted via `chrome.storage`.

### 🛠️ Technical Highlights
- **Performance Optimization**:
    - **Render Debouncing**: Limits rendering frequency to a 300ms window, preventing CPU spikes during AI's streaming output.
    - **Heuristic Pruning**: Pre-filters nodes based on features (child count, text length) before expensive `getComputedStyle` calls to minimize **Reflow**.
- **Spatial Fingerprinting**: Generates unique IDs for image-only messages using `offsetTop` and `offsetLeft` coordinates, ensuring index stability under **Lazy Loading** conditions.
- **Two-pass Parsing**: A recursive algorithm that eliminates nested duplicates in the first pass and handles logic numbering in the second.

### 📦 Installation
1. Download and extract the source code.
2. Go to `chrome://extensions/` in Chrome.
3. Enable **Developer Mode**.
4. Click **Load unpacked** and select the project folder.

---

## 中文

一款专为 AI 重度用户设计的高性能浏览器扩展。为 **豆包 (Doubao)** 与 **Google Gemini** 提供实时的上下文索引与精准跳转功能。

### ✨ 核心特性
- **智能上下文索引**：自动提取用户提问，构建实时更新的导航侧边栏。
- **多模态支持**：
    - **图像探测**：精准识别对话中的图片、Canvas 或原生 `<img>` 标签。
    - **自动编号**：针对纯图片消息提供有序编号（如 *Picture 1, Picture 2*）。
- **深度跳转引擎**：
    - **平滑滚动**：自动识别复杂的嵌套滚动容器，确保精准锚定。
    - **视觉反馈**：跳转后目标块伴有高亮特效，提升定位感知。
- **数据持久化**：
    - **自定义重命名**：支持手动修改索引标题。
    - **收藏系统**：支持“星标”重要对话，数据通过 `chrome.storage` 跨会话保存。

### 🛠️ 技术亮点
- **性能优化**：
    - **渲染防抖 (Debounce)**：将渲染频率控制在 300ms/次，避免 AI 逐字生成时的 CPU 剧烈波动。
    - **启发式剪枝**：在调用高开销样式计算前进行特征预筛选，最大限度减少浏览器**重排 (Reflow)**。
- **空间指纹识别**：针对无文字图片消息，结合物理坐标生成唯一 ID，解决**懒加载**环境下的索引偏移问题。
- **双重扫描算法**：首轮递归判定父子关系剔除嵌套，次轮完成逻辑编排。

### 📦 安装方法
1. 下载并解压源代码。
2. 在 Chrome 中访问 `chrome://extensions/`。
3. 开启 **开发者模式**。
4. 点击 **加载解压的扩展程序**，选择本项目文件夹。

---

## 📄 License
[MIT License](LICENSE)