---
name: design-to-editable-html
description: 对照海报、菜单、价目表等参考图与同尺寸背景图，只生成背景图缺少的可编辑文字和线段；背景图已有文字保持原样，并按需导出 HTML、图片、PDF、PSD、SVG。
---

# 设计图转可编辑 HTML

版本 `2026.09.29-13`。**背景图保持原样，已有文字不抹、不覆盖、不补同样的图层；只生成参考图中有、背景图中没有的文字和线段。** 成品是能在浏览器里改字、拖动、导出的单文件 HTML。图层仅有点文本 `point`、段落 `para`、线段 `line`；数据格式见 [scene-schema.md](references/scene-schema.md)。

## 默认流程

在**可写的项目工作目录**执行。把 `<SKILL>` 换成本文件所在的技能目录；其余尖括号换成实际路径。统一从 `launch.ps1` 启动：它会把所需脚本与资源复制到当前目录的 `.codex-skill-runtime/design-to-editable-html`，随后从该副本启动 Node。无需先尝试直接运行安装目录中的 `.cjs`，也无需手工复制或排查 `EPERM`。当前 Codex Windows 沙箱里的 Chrome 导出也由脚本自动适配。

1. 量图：

   `powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL>/scripts/launch.ps1" run --ref "<参考图>" --board "<背景图>" --out "<输出目录>" --name "<稿名>"`

   首次还有 `?` 文字时，程序停下并生成 `scene.json`、`blocks.json`、`sheet*.png`。
2. 制作填字清单：

   `powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL>/scripts/launch.ps1" fill --scene "<输出目录>/scene.json" --dump-out "<输出目录>/填字.txt"`

   对照 `sheet*.png` 把清单中的 `?` 改成真实文案，保留行首坐标；同时看每个字号档属于宋体、黑体、圆体、楷体、隶书、仿宋哪一类，记成 `L1:楷体,L2:仿宋`。菜单中粘成一团的「菜名……价格」照此写，程序会拆成两个文字层和一条点线。不要凭 OCR 猜测无法辨认的字。
3. 重跑第 1 条命令，末尾加 `--map "<输出目录>/填字.txt" --font-groups "L1:楷体,L2:仿宋"`（按实际类别填写每档）。程序直接用固定字体映射、建稿和比较还原度；不逐家渲染整页比字体。查看渲染图与差异热图，核对文字、价格、缺层、重影和对齐，再交付 HTML 与 `scene.json`。额外产物仅在用户需要时加 `--exports jpg,pdf,text,psd,svg` 中的对应项。

参考图里竖排的文字，在 `scene.json` 对应文字层写 `"direction":"vertical"`（可在 HTML 属性面板「文本方向」切换）；竖排从上到下、换列从右到左。导出 PSD 时保留原文并写成 Photoshop 可编辑的竖排文字层。竖排段落的 `h` 是单列高度，`w` 是总列宽；具体坐标见 [scene-schema.md](references/scene-schema.md)。

字体映射固定为：宋体→思源宋体，未安装则宋体；黑体→思源黑体，未安装则黑体；圆体→幼圆；楷体→楷体；隶书→隶书；仿宋→仿宋。若没有提供 `--font-groups`，脚本会一次比对六类代表字形并直接映射；低置信度时需回看裁图，不能把自动类别当作已核准。

## 仅在相关时处理

- 参考图是 JPG 且探测漏字：给 `run` 加 `--T 45`，必要时试 `--T 60`，并复核裁图。
- 同版式重做：给 `run` 加 `--from "<上一版.html 或 scene.json>"` 沿用已核对的文案和字体；要改字体类别则加 `--font-groups "L1:楷体,L2:仿宋"`，要重新自动识别则加 `--reclassify-fonts`。
- 两图里相同的字属于背景图，直接保留，不生成新层，也不要求用户抹掉。只核对参考图比背景图多出的字。若只有参考图、没有背景图，应先取得背景图，避免把原有文字重复生成。
- 自动类别低置信度或风格明显不符时，对照裁图人工改 `--font-groups`。复杂版式与旧故障记录见 [legacy-operations.md](references/legacy-operations.md)；其中逐家 `fontpick` 属于旧流程，当前默认不用。
