# SVG Motion Scene

一个面向智能体（Agent）的 Skill：把场景要求转化为**可直接打开的单文件 SVG 动画 HTML**，同时提供完整的工作流、可运行示例和验收工具。

生成过程关注：

- 主体、部件、连接、包含和遮挡关系清楚；
- 几何只有一个权威来源，静态绘制与动画代码不各写一套坐标；
- 场景运动由同一个 JavaScript 时钟驱动，暂停、恢复和减少动态一致；
- 循环边界的位置与速度连续；
- 适配手机竖屏、手机横屏和桌面横屏；
- 视觉结果由实际浏览器验收。

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
用 svg-motion-scene 生成鲸群穿过雨夜城市的 SVG 动画。

用 svg-motion-scene 做一个纸鸢掠过麦田的单文件循环动画，放在当前目录。

用 svg-motion-scene 生成机械蜂鸟悬停在玻璃温室中的 SVG 动画，适配手机和桌面。
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

生成完成后，直接用浏览器打开该 HTML。

## 限制

- 通用审查无法替代每个场景自己的语义、接触和遮挡检查。
- 真实移动端浏览器、操作系统级标签页挂起和真实屏幕阅读器仍需在目标环境验证；页面可见性测试使用 DOM 事件模拟。
