# Kaguya WebUI 设计系统

<!-- impeccable:design-schema 1 -->

## World

**深夜霓虹 · 鸟居**。产品界面运行在 `data-theme="dark"`：深蓝夜空底色（`#071526`）、线稿鸟居与霓虹云/鱼/章鱼插画作为背景层，月牙橙（coral）与青色霓虹（cyan）承担交互语义。灵感来自夜晚神社的灯火：安静、克制的深色承载面上，只有少数高亮元素发光。

模式：**Operate（操作型）**。用户来判断服务是否可用、完成配置、发送消息、排查问题。扫描效率与状态可信优先于装饰。

## Themes

- **dark（产品唯一活跃主题）**：`index.html` 固定 `data-theme="dark"`。所有页面按深色验收。
- **light（遗留基线）**：`:root` 默认令牌仍保留浅色值，仅供 `preview/arousal.tsx` 设计预览的主题切换使用。不为浅色新增投入，也不新增仅浅色可见的规则。

## Tokens

颜色令牌分三层，组件只引用语义层：

- **品牌**：`--kaguya-coral`（主强调/主按钮/当前态）、`--kaguya-coral-strong`（悬停与深色下的强调文字）、`--kaguya-gold`（辅助点缀）、`--kaguya-cyan`（成功、焦点、深色次要强调）。
- **表面**：`--kaguya-paper`（卡片/面板）、`--kaguya-paper-soft`（次级表面、输入底）、`--kaguya-line`（常规边框，低存在）、`--kaguya-ink`（正文）、`--kaguya-muted`（辅助说明）。
- **状态**：成功用 cyan 系、错误/危险用 coral-strong 系。颜色不单独承担语义，配合图标或文字。

阴影表达层级：常规卡片 `0 1px 2px` 近景阴影；弹层与浮起卡片使用带偏移的柔和阴影。不使用零偏移光晕假装深度；霓虹发光（drop-shadow）只留给品牌 Logo 与背景插画。

## Typography

字体栈：Inter / Segoe UI / Microsoft YaHei / system-ui（无自托管字体，中文回退系统黑体）。

- 页面标题 h1：22–26px / 650，中文不使用负字距。
- 区块标题 h2/h3：15–18px / 600。
- 正文：14px / 400 / 行高 1.6+；辅助说明 12–13px / 400，muted。
- 按钮、标签、芯片：500–600，**不用 700**；粗体只留给数值与关键词。
- 数字与 ID 使用 `font-variant-numeric: tabular-nums`；代码与 ID 用等宽。

## Shape & Spacing

- 卡片/面板圆角 12–14px；按钮、输入 9–10px；胶囊仅用于状态徽章与小控件。
- 间距节奏 4px 基线：相关组内 8–12px，组间 20–32px；标题上方留白大于下方。
- 内容必须落在承载面上：正文不直接压在背景插画上。

## Components

- **按钮**：`wb-button` 三档——primary（coral 实心）、secondary（描边）、danger（描边 + coral-strong 文字，非实心红块）。min-height 38–40px。
- **状态徽章**：`wb-status` 胶囊，图标 + 文字 + 同色相 8% 底 / 20% 边。
- **字段反馈**：`wb-field-message` 圆角提示块，不用 ≥3px 的彩色左边条。
- **输入**：`paper-soft` 底 + `line` 边；聚焦时边框与光环用 cyan（深色）/ coral（浅色）；占位符 muted 70%。
- **链接**：继承调色板颜色与下划线偏移，不出现浏览器默认蓝。
- **导航**：当前页 = 次级表面底 + coral 左侧 3px 内嵌条 + 600 字重；悬停仅底色变化。
- **空状态**：居中图标 + 一句结论 + 一句指引 + 一个主操作，不堆砌说明。

## Motion

动效只表达反馈：加载旋转、悬停过渡（≤150ms）、弹层淡入。全站尊重 `prefers-reduced-motion: reduce`（已有全局覆盖）。不为了"显得有设计"而添加动画。

## Browser surfaces

选中色、光标（caret）、滚动条、焦点环、链接下划线偏移均来自调色板，不保留浏览器默认。

## Evidence

incumbent 实现证据：`src/styles.css`（全局与暗色覆盖）、`src/components/workbench.css`（壳层）、`docs/design/index.md`（产品视觉原则）。背景插画位于 `public/theme/`。
