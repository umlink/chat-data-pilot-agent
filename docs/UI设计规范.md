# DataPilotAgent UI 设计规范

**来源**：`docs/chat-run-detail.html`（DataPilot Design System · shadcn/ui base-mira preset · neutral 基色 · Light）
**版本**：v1.0　**日期**：2026-08-25
**用途**：前端 UI 开发标准。所有页面对齐本规范；Block 组件、会话页、会话列表、输入区、Run 详情抽屉均以本规范与《Block与协议规范》为唯一依据。

---

## 1. 设计令牌（Design Tokens）

> 令牌已落入 `frontend/src/index.css`：语义令牌定义在 `:root`，Tailwind 类映射在 `@theme inline`。

### 1.1 色彩

| 语义 | 值（Light） | Tailwind 类 | 用途 |
|------|-----------|------------|------|
| background | oklch(1 0 0) | `bg-background` | 页面底 |
| foreground | oklch(0.145 0 0) | `text-foreground` | 主文本 |
| card / card-foreground | oklch(1 0 0) / oklch(0.145 0 0) | `bg-card` | 卡片 |
| primary / primary-foreground | oklch(0.205 0 0) / oklch(0.985 0 0) | `bg-primary` | 主按钮、选中态、品牌 |
| secondary | oklch(0.97 0 0) | `bg-secondary` | 次级面 |
| muted / muted-foreground | oklch(0.97 0 0) / oklch(0.556 0 0) | `bg-muted` `text-muted-foreground` | 表头、辅助文案 |
| accent | oklch(0.97 0 0) | `hover:bg-accent` | hover 面 |
| border / input / ring | oklch(0.922 0 0) / 同 / oklch(0.708 0 0) | `border` `focus:ring` | 描边、聚焦 |
| destructive | oklch(0.577 0.245 27.325) | `text-destructive` | 危险操作 |

**扩展语义令牌（DataPilot）**

| 语义 | 值 | Tailwind | 用途 |
|------|-----|----------|------|
| state-success / -bg | oklch(0.62 0.19 145) / oklch(0.93 0.08 145) | `text-success` `bg-success-bg` | 成功、正增长 |
| state-warning / -bg | oklch(0.75 0.18 75) / oklch(0.95 0.06 80) | `text-warning` | 确认、风险 |
| state-error / -bg | oklch(0.577 0.245 27.325) / oklch(0.95 0.05 25) | `text-error` `bg-error-bg` | 失败、负增长 |
| state-info / -bg | oklch(0.65 0.18 230) / oklch(0.94 0.05 230) | `text-info` | 进行中 |
| chart-1..5（橙色阶） | oklch(0.837 0.128 66.29) → oklch(0.47 0.157 37.304) | `text-chart-1` 等 | 图表主色 |
| 代码块 | bg oklch(0.145 0 0) / fg oklch(0.92) / header oklch(0.205) / border oklch(0.27) / lang bg oklch(0.25) / lang fg oklch(0.7) | `bg-code-bg` `text-code-fg` 等 | SQL/代码 |
| 用户气泡 | bg oklch(0.205 0 0) / fg oklch(0.985 0 0) | `bg-user-bubble text-user-bubble-fg` | 聊天 |

### 1.2 字体
- 无衬线：`Inter Variable`（`@fontsource-variable/inter`）
- 等宽：`'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace`
- SQL/Python 源码统一等宽。

| 字号 | 值 | 用于 |
|------|-----|------|
| xs | 12px | 表单提示、徽标、时间、视线 |
| sm | 13px | 次级文本、按钮、表格 |
| base | 14px | 正文、输入 |
| md | 15px | Token 数值 |
| lg | 16px | 抽屉标题 |
| xl | 18px | 大标题 |
| 行高 | 1.25 / 1.5 / 1.6 | heading / 常规 / 宽松（聊天、代码） |

### 1.3 间距 · 圆角 · 阴影

| 层级 | 值 |
|------|-----|
| 间距 | 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32（px） |
| 圆角 | sm 7 / md 10 / lg 12 / xl 17 / full 9999（基准 `--radius: 0.75rem`） |
| 阴影 | sm `0 1px 2px rgb(0 0 0 / .04)`；md `0 4px 12px rgb(0 0 0 / .06)`；lg `-8px 0 24px rgb(0 0 0 / .06)`（抽屉） |

> 视觉语言基准（对齐参考设计系统）：**浅灰画布 + 纯白卡片浮起**。`--background` 为浅灰（oklch 0.98），`--card` / `--sidebar` / `--popover` 为纯白，卡片靠 border 与底色差分层，不依赖重阴影。bento 卡片网格用于配置/日志/概览等次级页面；对话主界面保持三栏垂直流（见第 2 章）。

---

## 2. 布局（三栏）

| 区 | 尺寸 | 说明 |
|----|------|------|
| 左：Sidebar | 260px | 品牌栏 56px + 新建对话 + 搜索 + 会话列表 + 底导航/用户 |
| 中：Center | flex | Topbar 52px + 消息流（padding 20px 32px）+ 输入区 |
| 右：Drawer（Run 详情） | 380px | 淡入 slideInRight，仅打开时显示 |

---

## 3. 组件规范

### 3.1 按钮 `.btn`
基准：`inline-flex items-center gap-2`，`rounded-lg`，字号 sm，`focus-visible: ring-2`。
| 变体 | 规格 | 说明 |
|------|------|------|
| primary | `h-9 px-4`，`bg-primary text-primary-foreground`，hover 加深 | 主操作 |
| ghost | `h-9 px-3`，hover `bg-accent` | 顶栏操作、次操作 |
| sm | `h-7 px-2.5 text-xs` | 行内 |
| icon | `h-9 w-9` | 图标按钮 |
| send | `h-[34px] w-[34px] rounded-[10px] bg-primary` | 发送 |

### 3.2 徽标 `.badge`
基准：`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium`。
| 变体 | 底色 |
|------|------|
| default | `bg-primary text-primary-foreground` |
| secondary | `bg-secondary text-secondary-foreground` |
| success | `bg-success-bg` + 深绿文本（含勾选图标） |
| outline | `border` + `text-foreground` |

### 3.3 状态点 `.status-dot`
8px 圆点：`.succeeded`=success；`.running`=info；`.queued`=灰 + 脉冲动画。

### 3.4 聊天消息
| 元素 | 规格 |
|------|------|
| 用户气泡 | 靠右，`max-w-[75%]`，`bg-user-bubble text-user-bubble-fg`，`rounded-[16px_16px_4px_16px]`，`px-3.5 py-2.5 text-[13px] leading-[1.6]` |
| AI 头 | 头像 28px 圆（primary 底白图标）+ 名称 12px/600 + 时间 11px muted + 状态点 + 状态徽标 |
| AI 文本 | `text-[13px] leading-[1.6]`，`<strong>` 加粗强调结论 |

### 3.5 代码块 `.code-block`
深色：`bg-code-bg border-code-border rounded-lg overflow-hidden`。
- 头部：`bg-code-header`，语言徽标 `bg-code-lang-bg text-code-lang-fg text-[10px] uppercase tracking-wider`
- 主体：`font-mono text-xs leading-[1.6] text-code-fg`，超宽横向滚动
- 语法高亮类：`.tok-keyword` 紫 / `.tok-string` 绿 / `.tok-number` 橙 / `.tok-comment` 灰斜体 / `.tok-func` 蓝 / `.tok-builtin` 琥珀

### 3.6 数据表格 `.data-table`
外层 `rounded-lg border overflow-hidden text-xs`；th：`bg-muted px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground`；td：`px-3 py-2 border-b`；末行去 border。脚注：`text-[11px]` 含「导出 CSV」下划线链接。正负增长用 `text-success` / `text-error`。

### 3.7 图表卡片
`.card` + `p-4`；标题 `text-[13px] font-semibold`；柱状主色渐变橙 400→600；坐标轴 9px muted；图例 11px。M4 由 recharts（shadcn/ui Chart 封装）渲染，颜色取 `--chart-1..5`。

### 3.8 引用卡 `.quote-card`
`bg-muted border-l-4 border-primary rounded-md p-3 text-sm leading-[1.6]`（用于「用户输入」回显、澄清说明）。

### 3.9 Token 统计 `.token-stats`
`rounded-md border overflow-hidden flex`；单元 `flex-1 p-2.5 text-center`、border-r；数值 `text-md font-semibold font-mono`；标签 11px；Cost 单元缩小用 muted。

### 3.10 KV 网格 `.kv-grid`
2 列 `gap-x-4 gap-y-2.5`；label xs muted；value sm/500（id 等用 mono）。

### 3.11 产物卡片 `.artifact-card`
`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[11px] cursor-pointer`，hover 加深；图标 26px `rounded-md`，底色按类型：chart 橙、table 蓝、text 灰。

### 3.12 输入区 `.composer`
`rounded-xl border border-input p-2 focus-within:ring-2 ring/15`；工具图标 32px muted；textarea `text-[13px]` min-h 22 max-h 120；发送 34px。下方辅助行 11px muted：`Enter 发送 · Shift+Enter 换行 · @ 提及数据集`。

### 3.13 Run 详情抽屉
Tabs（`h-11 text-sm`、active 底部 2px primary 线 + 600）；区块间距 24px；`code-preview` 折叠态 max-h 72px + 渐变遮罩 +「查看完整代码」链接；产物列表 `/artifact-item` 与 3.11 同源。

---

## 4. Block 渲染标准（对应《Block与协议规范》）

| Block type | 渲染容器 | 状态呈现 |
|-----------|---------|---------|
| text | AI 文本（markdown） | running 逐 token，闪烁光标示意 |
| code | 3.5 代码块 | 头部附「执行中/成功/失败」状态点 |
| table | 3.6 数据表格 | 无 |
| chart | 3.7 图表卡片 | 加载骨架 |
| confirmation | 警告卡（amber 边框 + 影响说明 + SQL 预览） | pending→approved（primary 按钮） |
| progress | 进度条 + 步骤清单 | running 信息态/queued 脉冲 |
| error | `bg-error-bg text-error border` | 可重试则展示重试按钮 |
| insights | 列表，标题加粗 | 无 |
| suggestions | 胶囊按钮（`rounded-full border`） | 点击发起新对话 |
| attachment | 产物式小卡（上传/解析/就绪/失败状态） | 状态徽标 |

---

## 5. 动效与反馈
- 基础：`transition-colors` 120–200ms；hover 用 accent 面，**避免位移动画**。
- 状态：queued 脉冲点、progress 25px 条纹可选、发送中 Stop 图标切换。
- 抽屉/弹层：`slideInRight 0.3s`；列表项轻 `fadeIn 0.2s`。
- 滚动条：6px 细滚动条，thumb `oklch(0.88 0 0)`。

---

## 6. 开发标准（必须遵守）

1. **令牌即颜色**：禁止硬编码色值，一律用第 1 章语义令牌。状态一律用 `success / warning / error / info` 令牌，**不用**红绿任意色。
2. **字号阶梯**：只能用 xs/sm/base/md/lg/xl 阶梯（1.2），或在代码块内使用更小的 10/11/12px（文本内容例外）。
3. **间距阶梯**：4/6/8/12/16/20/24/32，禁止 1px 间距（border 除外）、禁止奇数间距。
4. **圆角阶梯**：6/8/10/12/9999。
5. **语义化命名**：类名用 Tailwind 工具类；重复组件（按钮/徽标/表格/代码块）提取为 `@layer components` 类或共享组件，禁止跨文件复制样式。
6. **可访问性**：交互元素 `aria-label`；`focus-visible` 可见 ring；最小可点区域 28px；颜色对比 ≥ 4.5:1。
7. **明暗主题**：所有颜色来自令牌变量，暗色在 `.dark` 覆盖变量，不新增 magic 值。
8. **与后端契约一致**：组件与 `Block` 类型的映射遵循《Block与协议规范》第 6 章，type 不变更命名。
9. **新增页面/组件**：先按本规范抽令牌与组件类，再实现；如无法用现有令牌表达，先在 `docs/UI设计规范.md` 登记新令牌再使用。