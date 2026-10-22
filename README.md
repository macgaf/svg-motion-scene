# SVG Motion Scene

一个面向智能体（Agent）的 Skill：把一个场景要求，转化为**可直接打开的单文件 SVG 动画 HTML**，并用真实浏览器完成结构、运动、循环、画幅和交互验收。

它不是动画库，也不是 CLI。它是一套工作流 + 可运行示例 + 验收工具，帮助 Agent 在生成 SVG 动画时不只追求“能动”，还同时满足：

- 主体、部件、连接、包含和遮挡关系清楚；
- 几何只有一个权威来源，静态绘制与动画代码不各写一套坐标；
- 场景运动由同一个 JavaScript 时钟驱动，暂停、恢复和减少动态一致；
- 循环边界的位置与速度连续；
- 适配手机竖屏、手机横屏和桌面横屏；
- 视觉结果经过实际浏览器检查，而不是只检查代码里有没有动画声明。

## 仓库内容

| 路径 | 作用 |
| --- | --- |
| [SKILL.md](SKILL.md) | Skill 主入口：完整生成工作流、强制约束、文件名规则和审计契约 |
| [references/motion-model.md](references/motion-model.md) | 场景契约、唯一几何、连接/包含、共享状态、时钟与循环建模细则 |
| [references/verification.md](references/verification.md) | 验收矩阵、误差容差、采样方法和汇报模板 |
| [assets/starter.html](assets/starter.html) | 一个可运行的示例动画，示范时钟、暂停、减少动态、自适应取景和可访问性 |
| [scripts/audit_scene.mjs](scripts/audit_scene.mjs) | 通用浏览器验收脚本：外部依赖、三画幅、交互、暂停相位、循环边界等 |
| [tests/starter-relations.mjs](tests/starter-relations.mjs) | 只针对 starter 的场景关系测试，示范如何独立读取最终 SVG 路径做断言 |

## 安装

前置条件：使用一个会读取 `SKILL.md` 的智能体运行时。示例使用项目级或用户级 `.agents/skills` 目录。

### 安装到当前项目

在项目根目录执行：

```bash
mkdir -p .agents/skills
git clone https://github.com/macgaf/svg-motion-scene.git .agents/skills/svg-motion-scene
```

安装后目录应为：

```text
<project>/.agents/skills/svg-motion-scene/
├── README.md
├── SKILL.md
├── assets/
├── references/
├── scripts/
└── tests/
```

### 安装为用户级 Skill

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/macgaf/svg-motion-scene.git ~/.agents/skills/svg-motion-scene
```

如果 Agent 运行时使用其他 skills 目录，请按该运行时的文档放置；关键在于让本仓库的 `SKILL.md` 位于该 Skill 目录的根级。

### 更新

```bash
git -C .agents/skills/svg-motion-scene pull --ff-only
```

安装或更新后，按运行时要求重新加载会话或 Skill 列表。

## 使用

安装完成后，在对话中直接描述场景，并点名调用该 Skill。例如：

```text
用 svg-motion-scene 生成一个「雨夜鲸群穿过城市」的 SVG 动画。
场景名：雨夜鲸群
模型：deepseek-flash
思考强度：高
```

Agent 会按 [SKILL.md](SKILL.md) 的流程先建立场景契约与唯一几何，再实现页面并做验收。

默认输出文件名为：

```text
<场景名>-<模型名>-<思考强度>.html
```

文件名规则：用户最后一次明确指定的名称优先；否则使用上面的默认格式。文件写入当前工作目录。

生成的 HTML 应自包含：

- 内联 SVG、CSS、JavaScript；
- 无外部图片、字体、库或网络请求；
- 包含移动端 viewport、暂停/继续控件和可访问的 SVG 文本说明；
- 支持 `prefers-reduced-motion` 和页面可见性恢复。

生成完成后直接在浏览器打开该 HTML 即可，不需要启动服务器或安装依赖。

## 浏览器验收

`scripts/audit_scene.mjs` 需要 Node.js 和开发期的 Playwright + Chromium。脚本在 Node v22.22.0、Playwright 1.62 上验证过。**生成的动画 HTML 本身不依赖它们。**

```bash
npm install --no-save playwright
npx playwright install chromium
```

以下命令以 Skill 安装在项目的 `.agents/skills/svg-motion-scene` 为例；如果当前就在 Skill 仓库目录内，把 `scripts/`、`tests/` 路径相应缩短即可。

运行通用验收并生成三种画幅的截图：

```bash
node .agents/skills/svg-motion-scene/scripts/audit_scene.mjs \
  path/to/your-scene.html \
  --shots .audit
```

脚本会检查：

- 无外部资源和实际网络/文件资源请求；
- viewport、SVG 标题/说明、暂停按钮和键盘操作；
- 390×844、844×390、1440×900 三种画幅的主体边界、安全边距与控件遮挡；
- 暂停后的画面与时钟冻结、恢复后的相位连续性；
- 减少动态下的默认暂停和显式播放；
- 页面隐藏再恢复时是否追赶时间；
- 若页面提供 `window.__svgSceneAudit`，检查循环边界的位置、透明度和有限差分速度。

示例场景的专用关系测试：

```bash
node .agents/skills/svg-motion-scene/tests/starter-relations.mjs
```

该测试会从实际渲染的 SVG 路径检查触手连接、灯球包含、吊点、灯球刚性和灯绳长度。它**只适用于与 starter 结构对应的场景**；生成新场景时，应按 [references/verification.md](references/verification.md) 为它另写断言。

## 已验证范围与限制

- 通用审计和示例测试已在 Chromium + Playwright 中实际运行，覆盖三种目标画幅、暂停/恢复、减少动态和循环边界。
- 通用脚本不能证明任意场景的语义、接触、遮挡与物理约束；这些必须按场景另写检查，不能把“0 FAIL”当作所有关系的证明。
- 真实移动端 Safari/Chrome、Firefox、操作系统级标签页挂起和真实屏幕阅读器仍有待在使用环境中验证；脚本中的页面可见性测试使用 DOM 事件模拟。
- 视觉截图需要人工查看，脚本只负责生成和提示。
- 验收脚本**不是**生产依赖，不会被写入生成的 HTML。
