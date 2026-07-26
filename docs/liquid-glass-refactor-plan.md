# 液态玻璃视觉重构 + Tailwind 本地化 计划

> 目标：把当前「Tailwind Play CDN（runtime）+ 扁平 utility」的前端，重构为「**本地预编译 Tailwind + macOS 液态玻璃质感**」的生产级方案。
> 解决三件事：① 生产环境不该用 Play CDN（性能/稳定性/安全/webview 噪音）；② 视觉升级为真实玻璃折射；③ 部署工作流对服务器零负担。
>
> 参考样式：`液态玻璃样式设计指南（修订版）.md`（下称「指南」）。本计划与之逐条对应，并针对本项目做了落地化裁剪。

---

## 0. 背景与现状

### 0.1 当前样式架构
- `index.html` / `login.html` 头部引用 `https://cdn.tailwindcss.com`（Play CDN，runtime JIT）。
- HTML 大量使用 Tailwind utility class（`bg-blue-600`、`shadow-md`、`rounded-lg`、`grid-cols-*` 等）。
- `css/style.css` 仅 22 行（`.nav-btn.active`、`.hidden`、`.pdf-capture-mode`、`.loading-overlay` 等）。
- 容器级表面：顶部 `nav.bg-blue-600`、左侧菜单 `div.bg-gray-800`、各 section 的 `div.bg-white.rounded-lg.shadow-md.p-6`、统计卡片、表单容器、表格。

### 0.2 已知问题（本计划一并解决）
1. Play CDN 在 IDE webview 受限环境抛 `Script error.` + `getBoundingClientRect null` 噪音（真实 Chrome 不复现，功能正常）。已在 `index.html` head 加 error 拦截脚本抑制，但根本解是去掉 Play CDN。
2. 生产部署依赖外网 CDN，国内访问慢/不稳，CDN 故障则整站样式丢失。
3. Play CDN 无法 purge/tree-shake，体积大、首屏 FOUC。
4. 视觉为扁平卡片，无玻璃质感。

### 0.3 不动的部分（红线）
- 业务内容、文案、HTML 结构、JS 交互逻辑**不改**。
- 后端、数据库、API 不改。
- 仅动：样式引用方式、CSS 文件、给容器补 `class="glass"` 之类标记、导出 PDF 时的背景兜底。

---

## 1. 总体策略

```
Play CDN (runtime)  ──拆除──▶  本地预编译 tailwind.css (静态)
扁平卡片            ──升级──▶  容器级液态玻璃 + 内层半透明面板
单色/纯色背景       ──升级──▶  多色结构壁纸 (body::before aurora)
无降级              ──补齐──▶  -webkit- / @supports / prefers-* 三件套
```

**文件组织（推荐）**：
```
css/
├── tailwind.input.css   # Tailwind 指令入口 + 自定义 @layer（.glass / 壁纸 / 降级），源文件
├── tailwind.css         # 构建产物，提交仓库，HTML 实际引用
└── style.css            # 保留极少量无法用 Tailwind 表达的覆盖（或并入 input 后废弃）
```
HTML 只 `<link rel="stylesheet" href="./css/tailwind.css">`，去掉 `<script src="https://cdn.tailwindcss.com">`。

**技术选型**：Tailwind v3.4.x（CLI 构建成熟稳定；v4 配置模型不同，暂不采用）。

---

## 2. 分阶段步骤

### 阶段 0：前置准备
- [ ] 新建分支：`git checkout -b feat/liquid-glass`
- [ ] 确认本地 Node ≥ 18（`node -v`）
- [ ] 备份当前 `index.html` / `login.html` / `css/style.css`（git 已托管，可直接改）
- [ ] 浏览器准备：Chrome（出折射效果）+ Safari/Firefox（验证降级）

### 阶段 1：Tailwind 本地化（去 CDN，地基）
> 必须先做，否则自定义玻璃 CSS 与 Play CDN 的 runtime 生成会打架。

1. **装依赖**（devDependencies）：
   ```bash
   npm i -D tailwindcss@^3.4.0
   ```
2. **生成配置** `tailwind.config.cjs`（项目 package.json 为 `"type":"module"`，配置用 `.cjs`）：
   ```js
   /** @type {import('tailwindcss').Config} */
   module.exports = {
     content: ['./*.html', './js/**/*.js', './css/**/*.css'],
     theme: {
       extend: {
         // 玻璃用色与圆角可在此扩展，便于 utility 引用
         borderRadius: { glass: '1.7rem' },
         boxShadow: {
           glass: '0 16px 46px rgba(40,60,100,0.20), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55), inset 0 0 34px rgba(255,255,255,0.30)'
         }
       }
     },
     plugins: []
   };
   ```
3. **写入口** `css/tailwind.input.css`：
   ```css
   @tailwind base;
   @tailwind components;
   @tailwind utilities;

   /* 自定义组件层：.glass / 壁纸 / 降级，见阶段 2-4 在此追加 */
   ```
4. **首次构建**：
   ```bash
   npx tailwindcss -i ./css/tailwind.input.css -o ./css/tailwind.css --minify
   ```
5. **改 HTML 引用**（`index.html` 与 `login.html` 同步）：
   - 删除 `<script src="https://cdn.tailwindcss.com"></script>`
   - 把 `<link rel="stylesheet" href="./css/style.css">` 改为 `<link rel="stylesheet" href="./css/tailwind.css">`（若 style.css 仍有用则两个都留，见阶段 5）
   - 保留 Font Awesome CDN（或一并本地化，可选）
6. **加构建脚本**到 `package.json`：
   ```json
   "scripts": {
     "build:css": "tailwindcss -i ./css/tailwind.input.css -o ./css/tailwind.css --minify",
     "watch:css": "tailwindcss -i ./css/tailwind.input.css -o ./css/tailwind.css --watch",
     "build": "node scripts/build-static.js && npm run build:css"
   }
   ```
7. **验证**：本地开静态服务器（`npx http-server -p 8080`）打开，确认样式与原来一致（此步只是换 CDN→本地，视觉不变）。控制台不再有 Tailwind 警告。
8. **确认 `.gitignore`**：已确认只忽略 `dist/`、`build/`，`css/tailwind.css` 可正常提交。✅

> ⚠️ 之后每新增一个 Tailwind class，都要重跑 `npm run build:css`，否则该 class 不在产物里。开发期用 `npm run watch:css`。

### 阶段 2：壁纸层（玻璃折射的「被折射对象」）
> 指南第 5 节铁律：背后必须有高频多色结构，折射才可见。

在 `css/tailwind.input.css` 的 `@layer base`（或直接写在 `@tailwind` 之后）追加：
```css
body::before {
  content: "";
  position: fixed;
  inset: -20%;
  z-index: -2;
  background:
    linear-gradient(135deg, #a9c8ff 0%, transparent 32%),
    linear-gradient(225deg, #ffc2dd 0%, transparent 34%),
    linear-gradient(315deg, #a9ecd9 0%, transparent 36%),
    linear-gradient(45deg, #d9c6ff 0%, transparent 34%),
    linear-gradient(135deg, #bcd4ff, #ffd9b0, #c9b6ff, #a9ecd9);
  background-color: #eef2f8;
  filter: blur(22px) saturate(165%);
  animation: aurora 40s ease-in-out infinite alternate;
  will-change: transform;
}
@keyframes aurora {
  0%   { transform: scale(1.12) translate3d(0, 0, 0); }
  50%  { transform: scale(1.18) translate3d(-2%, 1.5%, 0); }
  100% { transform: scale(1.12) translate3d(0, 0, 0); }
}
```

**⚠️ 指南修订点（层叠上下文）**：`body::before` 用 `position: fixed` 相对视口。排查时若壁纸错位，**先检查 `<html>`/`<body>` 祖先链是否有 `transform`/`filter`/`will-change`/`perspective`/`contain`**——本项目 `index.html` 第 51-57 行有 `html,body{opacity:1!important}`，`opacity` 不创建包含块，安全；但 `body.loaded`、`.loading-overlay` 等需复查不引入 transform。

### 阶段 3：SVG 折射滤镜 + `.glass` 基础类
1. **SVG 滤镜块**：在 `index.html` 和 `login.html` 的 `<body>` 开头插入（零侵入）：
   ```html
   <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
     <filter id="lg-refraction" x="-20%" y="-20%" width="140%" height="140%">
       <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="7" result="noise" />
       <feGaussianBlur in="noise" stdDeviation="2" result="blurredNoise" />
       <feDisplacementMap in="SourceGraphic" in2="blurredNoise" scale="9" xChannelSelector="R" yChannelSelector="G" />
     </filter>
   </svg>
   ```
   > 注意：`index.html` 已有一段学校个性化的 `<script type="module">`，SVG 放它之前、`<body>` 之后即可。
2. **`.glass` 类**（写入 `css/tailwind.input.css` 的 `@layer components`）：
   ```css
   @layer components {
     .glass {
       position: relative;
       background: rgba(255, 255, 255, 0.56);
       border: 1px solid rgba(255, 255, 255, 0.78);
       border-radius: 1.7rem;
       -webkit-backdrop-filter: blur(14px) saturate(180%);
       backdrop-filter: url(#lg-refraction) blur(14px) saturate(180%);
       box-shadow:
         0 16px 46px rgba(40, 60, 100, 0.20),
         inset 0 2px 0 rgba(255, 255, 255, 0.95),
         inset 0 0 0 1px rgba(255, 255, 255, 0.55),
         inset 0 0 34px rgba(255, 255, 255, 0.30);
       overflow: hidden;
     }
     /* 深色玻璃变体：用于原 nav.bg-blue-600 / 侧栏.bg-gray-800 */
     .glass-dark {
       position: relative;
       background: rgba(20, 28, 48, 0.42);
       border: 1px solid rgba(255, 255, 255, 0.18);
       border-radius: 1.7rem;
       -webkit-backdrop-filter: blur(14px) saturate(160%);
       backdrop-filter: url(#lg-refraction) blur(14px) saturate(160%);
       box-shadow:
         0 16px 46px rgba(10, 20, 40, 0.30),
         inset 0 2px 0 rgba(255, 255, 255, 0.18),
         inset 0 0 0 1px rgba(255, 255, 255, 0.10);
       overflow: hidden;
     }
   }
   ```

### 阶段 4：容器级玻璃应用（不嵌套！）
> 指南第 6 节：折射只放**容器级**表面，内层卡片改半透明面板，不带 `backdrop-filter`。

**容器级（加 `.glass` / `.glass-dark`，替换原 `bg-white shadow-md` 等）**：
| 位置 | 原类 | 改为 |
|---|---|---|
| 顶部导航 `nav.bg-blue-600` | 实色蓝 | `class="glass-dark ..."` + 文字保持白色（深色玻璃上白字对比足） |
| 左侧菜单 `div.bg-gray-800` | 实色深灰 | `class="glass-dark ..."` |
| 各 section 容器 `div.bg-white.rounded-lg.shadow-md.p-6` | 实色白 | `class="glass ..."` |
| login.html 登录卡 `.login-container` | 实色 | `class="glass ..."` |
| Modal/弹层（如有） | — | `class="glass ..."` |

**内层卡片（不嵌套玻璃，改半透明面板）**：
```css
@layer components {
  .glass-panel {
    background: rgba(255, 255, 255, 0.66);
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 1rem;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 14px rgba(40,60,100,0.08);
    /* 无 backdrop-filter，避免滤镜相乘 */
  }
}
```
适用于：统计卡片（`bg-blue-500`/`bg-green-500`...）、表单内的 `bg-gray-50` 分组、表格 `thead.bg-gray-100`、概览列表小卡。

> ⚠️ 原统计卡片是彩色实色块（蓝/绿/黄/红/紫），玻璃化后建议统一改为 `.glass-panel` + 保留彩色图标/数字，让彩色壁纸透出，更通透。若业务要保留彩色区分，可用 `rgba(色彩, 0.55)` 半透明彩色面板。

**改法**：在 HTML 给对应容器增删 class。因 utility class 与 `.glass` 同存时，`.glass` 的 `background` 会被 `bg-white` 覆盖（取决于层叠顺序）。建议把容器上的 `bg-white`/`shadow-md`/`rounded-lg` 删掉，改用 `.glass`（圆角、阴影、背景全由 .glass 接管）。布局类（`grid`/`flex`/`p-6`/`gap-*`）保留。

### 阶段 5：无障碍降级 + 特性探测兜底
> 指南第 7、8 节，三件套 + @supports，必做。

写入 `css/tailwind.input.css`：
```css
/* 1. 减少透明效果 */
@media (prefers-reduced-transparency: reduce) {
  .glass, .glass-dark {
    backdrop-filter: blur(14px) saturate(150%);
    -webkit-backdrop-filter: blur(14px) saturate(150%);
  }
  .glass { background: rgba(255, 255, 255, 0.86); }
  .glass-dark { background: rgba(20, 28, 48, 0.86); }
}
/* 2. 增强对比 */
@media (prefers-contrast: more) {
  .glass { border-color: rgba(255,255,255,0.96); }
  .glass-dark { border-color: rgba(255,255,255,0.5); }
}
/* 3. 减少动效（关闭壁纸 aurora） */
@media (prefers-reduced-motion: reduce) {
  body::before { animation: none; }
}
/* 4. 完全不支持 backdrop-filter 的兜底 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: rgba(255, 255, 255, 0.92); }
  .glass-dark { background: rgba(20, 28, 48, 0.92); }
}
```

### 阶段 6：导出 PDF 兜底（项目特有）
> 项目用 html2canvas 导出看板/报告 PDF，玻璃透明背景会导致导出图难看/透出壁纸。

`css/style.css` 已有 `.pdf-capture-mode { background-color: #ffffff !important; }`。改造时确认：
- 导出前给捕获区（`#dashboard-capture-area` / `#pdfContent`）临时加 `.pdf-capture-mode`，强制白底；
- 导出后移除。
- 检查 `js/services/ExportService.js` 与 `js/modules/Dashboard.js` 的 `exportDashboardToPDF`，在 `html2canvas` 调用前后增删该 class（若现有逻辑未覆盖玻璃场景）。

### 阶段 7：性能验证与真机测试
- [ ] **真实 Chrome** 滚动看板/各表单页，确认无闪烁、无卡顿。
- [ ] **Safari** 验证降级为毛玻璃（`-webkit-` 兜底，无 `url()` 折射，预期内）。
- [ ] **Firefox** 验证降级。
- [ ] 若卡顿，按指南第 6 节三板斧：`scale 9→8`、`blur 14→12`、壁纸 `will-change` 仅动画期生效；最后杠杆去掉 `url()` 改纯 `blur() saturate()`。
- [ ] IDE webview 验证：之前加的 error 拦截脚本保留；去 CDN 后 `Script error.` 应彻底消失（拦截脚本作为双保险）。
- [ ] `prefers-reduced-motion` 下壁纸静止、`prefers-reduced-transparency` 下面板不透明，文字可读。

### 阶段 8：部署工作流（服务器零操作）
```bash
# 本地
npm run build:css              # 生成 css/tailwind.css
git add css/tailwind.css css/tailwind.input.css tailwind.config.cjs index.html login.html package.json
git commit -m "feat: 本地化 Tailwind + 液态玻璃视觉重构"
git push

# 服务器
git pull                       # 拉到最新（含 css/tailwind.css 产物）
# Nginx 托管静态文件，无需 reload（静态文件直接生效）；后端若有缓存可 nginx -s reload
```
- 服务器**不装 tailwind、不跑构建**，只拉静态产物。
- 后续改样式：本地 `npm run build:css` → commit → push → 服务器 `git pull`。

---

## 3. 验收清单

- [ ] `index.html` / `login.html` 不再引用 `cdn.tailwindcss.com`
- [ ] `css/tailwind.css` 已提交仓库，HTML 引用本地路径
- [ ] 控制台无 `cdn.tailwindcss.com should not be used in production` 警告
- [ ] IDE webview 无 `Script error.` / `getBoundingClientRect` 噪音
- [ ] SVG `#lg-refraction` 滤镜已加，`id` 唯一
- [ ] 仅容器级用 `url()` 折射，内层卡片用 `.glass-panel`（无 `backdrop-filter`）
- [ ] 壁纸多色有结构，仅 `transform` 动画（无 `background-position`）
- [ ] `-webkit-backdrop-filter` 降级已写
- [ ] `prefers-reduced-transparency` / `prefers-contrast` / `prefers-reduced-motion` 三项降级齐全
- [ ] `@supports not` 兜底已写
- [ ] 祖先链无 `transform`/`filter`/`will-change` 影响 `body::before` 的 `fixed`
- [ ] `will-change: transform` 仅壁纸常驻，未全局预防性添加
- [ ] 导出 PDF 时捕获区强制白底，玻璃不影响导出
- [ ] 业务内容/结构/交互逻辑未被改动
- [ ] 真实 Chrome 滚动无闪烁

---

## 4. 风险与回滚

| 风险 | 对策 |
|---|---|
| Tailwind 本地化后漏构建某 class，样式缺失 | 开发期用 `watch:css`；上线前完整跑一遍 `build:css` 并本地预览全页面 |
| 玻璃在低配机卡顿 | 阶段 7 三板斧；保留「去 `url()` 改纯模糊」作为最终降级 |
| `body::before` 被祖先包含块影响错位 | 复查祖先链 transform/filter；必要时把壁纸从 `body::before` 改到独立 `<div class="bg-aurora">` |
| 深色 nav 玻璃化后白字对比不足 | 用 `.glass-dark` 提高背景不透明度到 0.55+，或文字加 `text-shadow` |
| html2canvas 不支持 `backdrop-filter`，导出玻璃区域空白 | 阶段 6 强制白底兜底（必须做） |
| 回滚 | 单分支改动，`git checkout main -- index.html login.html css/` 即可还原；CSS 产物删除即可 |

---

## 5. 执行顺序建议（最小风险路径）

1. 先做**阶段 1**（Tailwind 本地化）并验证视觉与原来一致 → commit。此步独立可回滚。
2. 再做**阶段 2+3**（壁纸 + SVG + .glass 基础类），先在**一个 section 容器**（如看板）上试 `.glass`，确认折射可见 → commit。
3. 满意后**阶段 4** 批量应用到所有容器 + 内层面板 → commit。
4. **阶段 5+6** 降级与 PDF 兜底 → commit。
5. **阶段 7** 全量验证 → 合并到 main → **阶段 8** 部署。

每阶段独立 commit，出问题可单点回退。

---

## 6. 备注

- 指南明确反模式：不要做成「操作系统皮肤」（加 Dock/交通灯），只做材质质感。
- 若后续要做「平滑模式开关」让用户自选折射/纯模糊，可用 JS 给 `<html>` 打 `data-glass-mode="lite"`，CSS 据此切换 `backdrop-filter` 是否含 `url()`。
- Font Awesome CDN 若也想本地化，可下载到 `css/fontawesome/` 或用 npm `@fortawesome/fontawesome-free`，但非本计划必须项。
