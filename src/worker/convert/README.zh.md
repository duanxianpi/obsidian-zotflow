# 转换流水线

Zotero 笔记 HTML ↔ Obsidian Markdown。完全运行在 Web Worker 中，不依赖 DOM。

> 英文版见 [README.md](./README.md)。两份内容等价；改动时请同步更新。

两种格式互不为超集。Zotero 的笔记 schema 是一个固定的 ProseMirror 文档模型；
Obsidian 的 markdown 是 CommonMark 加 GFM 再加若干 Obsidian 专有形式。这个模块的
大部分工作，是逐个语法地决定——当一方无法表达另一方刚说的东西时，该怎么办。

---

## 1. 范围与词汇

每种语法归入三种策略之一。这个词出现在每个 feature 文件的头部注释里，值得严格
区分：

| 策略 | 含义 | 例子 |
| --- | --- | --- |
| **map（映射）** | 两边都有这个构造，做转换即可 | `<strong>` ↔ `**bold**` |
| **preserve（保留）** | 一方没有这个构造，但另一方的写法能作为惰性内容存活。完整往返 | `[[Note]]` 对 Zotero 而言就是纯文本 |
| **degrade（降级）** | 既不能表示也不能保留。信息丢失，且是刻意的、一次性的 | 围栏的 `` ```python `` info string |

降级必须**被记录**，绝不能是静默的——见 `model/nodes.ts` 里的 `OpaqueReason` 和
下面的「已知 gap」一节。

区分 preserve 和 degrade 是新增 feature 时最有用的一个问题，因为 preserve 几乎
总是可用、也几乎总是更好：**Zotero 会逐字保存它不认识的文本**，所以任何能作为
文本存活的东西就能永远存活。

---

## 2. 两条流水线

`html-to-md.ts` 和 `md-to-html.ts` 只做编排——两个文件加起来几百行，重构前是
1211 行。它们**不包含任何语法决策**。所有这类决策都在 `features/` 里，一种语法
一个文件，两个方向都写在该文件内。

### html → md（`html2mdWithProcessors`）

```
html 字符串
  │
  ├─ processors.parseHtml                 rehype-parse，fragment 模式
  ├─ （抽出外层 <div data-schema-version>，见 §7）
  │
  ├─ runCleanHast(tree, ctx)              feature 阶段 1   HAST
  ├─ rehype-remark                        feature 阶段 2   HAST → mdast
  │      newlines: true
  │      handlers: buildHastHandlers(ctx)
  ├─ runTransformMdastIn(tree, ctx)       feature 阶段 3   mdast
  ├─ processors.stringifyMarkdown         feature 阶段 4   mdast → 字符串
  │      handlers: buildStringifyHandlers(ctx)
  ├─ runPostSerializeMd(md, ctx)          feature 阶段 5   字符串（最后手段）
  │
  └─ 前置 `<!-- ZF_NOTE_META … -->`
```

`newlines: true` 是承重的：它保留段落内手写的换行，使 `<p>123\n[[link]]\n123</p>`
往返后仍是三行，而不是塌成一行。

### md → html（`md2htmlWithProcessors`）

```
md 字符串
  │
  ├─ matchLeadingNoteMeta                 剥掉 `ZF_NOTE_META`，留下属性
  ├─ processors.parseMarkdown             remark-parse + GFM（§6）+ math
  │
  ├─ runTransformMdastOut(tree, ctx)      feature 阶段 1   mdast
  ├─ processors.mdastToHast               feature 阶段 2   mdast → HAST
  │      remark-rehype，allowDangerousHtml
  ├─ runTransformHast(tree, ctx)          feature 阶段 2   HAST
  ├─ processors.stringifyHtml             HAST → 字符串
  ├─ runPostSerializeHtml(html, ctx)      feature 阶段 3   字符串（最后手段）
  │
  └─ 用抽出的属性包回 `<div …>`
```

**任何东西都不得在解析前改写原始 markdown 字符串。** 这是硬性规则，不是偏好。
micromark 先解析出块级和行内结构，于是 `code` 和 `inlineCode` 成为独立的节点
类型，feature 的各个 pass 根本不会访问它们。全字符串正则分不清正文和围栏内部；
这里曾经有五处这样的 pass，它们**不可逆地**损坏了每一条讲解 markdown 语法的
笔记——因为它们注入的哨兵在 `<pre>` 里被 HTML 转义了，restore pass 就再也匹配
不上。

同一条规则也解释了为什么 `postSerializeMd` / `postSerializeHtml` 存在但几乎不用：
它们是留给完全没有 AST 表示的东西的（比如任何 handler 都够不着的序列化器转义）。
目前只有两个 feature 用到，且都写明了理由。

---

## 3. Feature 契约

见 `features/types.ts`。feature 只实现自己需要的 hook，由 registry 负责组合。

这里的变化轴是 **feature**，不是流水线阶段——加一个 Obsidian 语法意味着回答
「它怎么出去、怎么回来」，所以这两个答案应该挨在一起。按阶段切分正是之前把
task list 摊到两个文件四个调用点的原因，那种结构下「改了一处忘了其余」是默认
结果。

八个 hook，每个方向四个，对应文档经过的每一种表示：

```
html → md :  HAST ──→ (handlers) ──→ mdast ──→ markdown 字符串
             cleanHast  hastHandlers   transformMdastIn / stringifyHandlers
                                       postSerializeMd

md → html :  mdast ──→ HAST ──→ html 字符串
             transformMdastOut  transformHast  postSerializeHtml
```

| Hook | 作用于 | 用途 |
| --- | --- | --- |
| `cleanHast` | 解析后的笔记 HAST | 在任何东西读它之前规范化 Zotero 的 HTML |
| `hastHandlers` | 按 HTML 标签 | 一个 Zotero 元素在 mdast 里变成什么 |
| `transformMdastIn` | mdast（入站） | 需要看整棵树而不只是单个标签的处理 |
| `stringifyHandlers` | 按 mdast 节点类型 | 一个节点如何写成 markdown |
| `postSerializeMd` | markdown 字符串 | 仅限最后手段 |
| `transformMdastOut` | mdast（出站） | 生成 HTML 前在 markdown 侧的改写 |
| `transformHast` | HAST（出站） | 把 HTML 塑造成 Zotero 期望的形状 |
| `postSerializeHtml` | html 字符串 | 仅限最后手段 |

`FeatureContext` 是 feature 可以据以变化的全部内容：`annotationImageFolder`、
`strictLineBreaks`、`linkCitationSpans`。

### `PASS`

一个 HTML 标签可能承载多个不相关的 feature。Zotero 的一个 `<span>` 可能是
math、citation payload、annotation payload、highlight、strike mark、颜色 mark，
或者只是个包装。因此同一标签的 handler 按 registry 顺序串成链，不认领该节点的
handler 返回 `PASS`。

`PASS` 是 symbol 而不是 `undefined`，因为 `hast-util-to-mdast` 把 `undefined`
读作「此节点不产生任何东西」，会**静默删除内容**。如果所有 feature 都弃权，就
回落到 rehype-remark 自己的默认 handler。

---

## 4. 顺序

registry 在 `features/index.ts`。顺序是契约的一部分，真正重要的约束都记录在那里。
摘要：

| 约束 | 原因 |
| --- | --- |
| `note-structure` 必须第一 | 下游一切都假定树已被清理 |
| `citation-links` 在 payload 类 feature 之前 | 它注入的 anchor 必须在这些 span 被逐字捕获之前进到 span 里 |
| `math` 在 `zotero-payloads` / `span-unwrap` 之前 | 否则 `<span class="math">` 会被通用 span 处理吞掉 |
| `math` 在 `code-block` 之前（出站） | 代码扁平化会抹掉 `<code class="… math-display">` |
| `zotero-payloads` 在 `marks` 之前 | 同时带 annotation payload 和 strike 样式的 span 必须保住 payload |
| `span-unwrap` 是 span 认领者中的最后一个 | 它是无条件兜底 |
| `callout` 在 `obsidian-syntax` 之前 | 两者都改写段落的首个 text 节点 |

当前顺序：

```
note-structure → citation-links → math → zotero-payloads → marks →
span-unwrap → annotation-image → table → list → task-list →
callout → obsidian-syntax → code-block → line-breaks → link
```

---

## 5. 自定义 mdast 节点

见 `model/nodes.ts`。Markdown 对 Zotero 笔记里的若干东西没有语法，而 Obsidian
有些语法 CommonMark 不认识。两者过去都是靠裸 `{ type: "html" }` 节点偷渡的——
这让一个节点类型同时承担三份不相干的工作：Zotero payload 透传、Obsidian 语法的
转义旁路，以及一个 `value` 其实是 *markdown* 的载体。下游完全无法区分，于是一次
有损降级和一次刻意保留长得一模一样。

| 节点 | 承载 | 归属 |
| --- | --- | --- |
| `zoteroOpaqueHtml` | 一段逐字保留的 Zotero HTML，附带 `OpaqueReason` | `zotero-payloads.ts`、`table.ts` |
| `zoteroAnnotationImage` | 原始 `<img>` 标签、抽出的 PNG 路径、宽度 | `annotation-image.ts` |
| `obsidianRaw` | 必须不带转义抵达 vault 的 Obsidian 行内语法 | `obsidian-syntax.ts`、`callout.ts` |
| `u` / `sub` / `sup`（`InlineHtmlMark`） | phrasing **容器**，使嵌套 mark 得以存活 | `marks.ts` |

`OpaqueReason` 取值为 `citation`、`annotation`、`styled-table`、`colored-text`、
`unknown-zotero-node` 之一。它的存在是为了让降级**可归因**。

`InlineHtmlMark` 是 `Parent` 而不是 `Literal`，这一点是关键：
`<u><a href>link</a></u>` 过去只保留 `toText()`，URL 就丢了。

`inlineMath` / `math` 来自 `mdast-util-math`，刻意不在此重复声明。

---

## 6. 手工组合的 GFM

见 `gfm.ts`。`remark-gfm` 把脚注支持打包在内且无法单独关闭，而 ZotFlow **绝不能**
解析脚注：Zotero 的 schema 没有脚注节点，`[^1]` 会变成 `<sup><a>`、`[^1]:` 会变成
`<section data-footnotes>`，两者 `html2md` 都无法逆转。

手工组合 GFM 并直接**省略** footnote 扩展，`[^1]` 就成了普通文本。它随后无需任何
哨兵即可逐字往返，而 micromark 的块级／行内结构保证了它在代码里原封不动。

启用：autolink literal、strikethrough、table、task-list-item。
省略：footnote，以及 `tagfilter`（它会阉割裸 HTML，而 ZotFlow 刻意要逐字往返
Zotero 的裸 HTML）。

这个教训可以推广：**解析一个目的地无法表示的东西，比不解析更糟。** 脚注哨兵
hack 正是损坏代码围栏的元凶。在考虑引入任何新的 micromark 扩展之前，先权衡这一点。

---

## 7. `ZF_NOTE_META`

Zotero 笔记 HTML 外面裹着 `<div data-schema-version data-citation-items>`。
Markdown 表达不了这个包装，所以 `html2md` 把该 div 的属性序列化进一个前置 HTML
注释，`md2html` 再据此重建包装。

由流水线本身处理而非交给 feature，因为解包会产生一个调用方必须往外传的值。

该标记的单一真相源是 `src/utils/note-meta.ts`——`matchLeadingNoteMeta`、
`stripLeadingNoteMeta`、`formatNoteMeta`、`createNoteMetaScanner`。

过去有四个调用点各自持有这个正则的副本，而且已经漂移了：转换器接受两种 legacy
拼写，而两个 UI matcher 不接受，于是 legacy 格式的笔记会把 meta 行渲染成可见、
可编辑的正文。

匹配锚定在偏移量 0，这正是它安全的原因——不同于那些语法 pass，它不可能与文档内容
发生冲突。

---

## 8. 转义策略

这是本模块最微妙的部分，已经是**五个**内容销毁 bug 的来源。**在写任何逐字输出
payload 的 handler 之前，请先读这一节。**

`mdast-util-to-markdown` 会转义文本，使其不能被重新读作 markdown。
`state.unsafe` **不是一张全局表**：每一条都声明了自己适用的 construct，`safe()`
只保留对当前 `state.stack` 而言在作用域内的那些。

`obsidianRaw` 存在的理由是 Obsidian 语法**必须**能被重新读出来——`[[Note]]` 得
以 wikilink 的形式回来，而不是 `\[\[Note]]`。最直观的实现是原样返回
`node.value`。这是错的，而且代价高昂：它退出了**每一条**规则，包括那些与方括号
毫无关系的：

```
{character: '|',  inConstruct: 'tableCell'}   ← 忽略它，把 `[[Beta|Gamma]]`
                                                 撕成了两个单元格
{character: '\n', inConstruct: 'tableCell'}   ← 忽略它，把一个表格行
                                                 裂成了两行
```

两者都被写回了 Zotero，并且每次同步都继续变异。**发现一条补一条是不可能收敛的**
——这个集合是 `state.unsafe` 里的任意内容，而扩展还会往里加。

所以策略被反转了。handler 现在调用 `state.safe()`，并用 `isContainerScoped` 过滤
`state.unsafe`：

- **内容规则**——作用域为 `phrasing`，或通过 `atBreak` 而完全没有 construct——
  防止一段文本被重新读作 markdown。而这恰恰是这些节点想要的。**丢弃。**
- **容器规则**——`tableCell`、`titleQuote`、`destinationLiteral` 等——防止撑破
  所在的构造。它们与 Obsidian 语法无关，只关乎不破坏文档。**保留。**

改为按字符列举是行不通的，这次尝试作为测试用例保留了下来。`[`、`!`、`#` 确实是
这些形式的组成部分，但转义 `&`、`_` 或 `~` 同样会破坏它们：Obsidian 逐字匹配
wikilink 目标，所以 `[[A\&B]]` 找不到笔记 `A&B`。那个列表没有自然边界。而按作用域
划分有——`phrasing` 是「这是行内文本」的通用作用域，所以只写了它的规则**按定义**
就是内容规则。

`isContainerScoped` 和 `safeInContainer` 放在 `features/types.ts`，因为另外三个
handler 同样逐字输出 phrasing 内容、因而共享这个问题——payload span、标注图片和
行内数学**都能落进表格单元格**：

| Handler | Payload |
| --- | --- |
| `obsidianRaw` | Obsidian 语法 |
| `zoteroOpaqueHtml` | 序列化后的 Zotero 元素 |
| `zoteroAnnotationImage` | `<img>` 标签，外加一个字面 `\|` 宽度分隔符 |
| `inlineMath` | LaTeX —— **例外，见下** |

前三个用 `safeInContainer`。对它们而言 markdown 的转义是**可逆的**：GFM 表格解析器
会在读取行内 HTML **之前**把 `\|` 还原成 `|`，所以 payload 完好抵达。

**行内数学是例外，刻意不转义**，尽管单元格里的 `$a|b$` 会撕裂整行。两个 tokenizer
的行为相反：

```
| `a \| b` |  ->  inlineCode 值 "a | b"    （已反转义）
| $a \| b$ |  ->  inlineMath 值 "a \| b"   （反斜杠保留）
```

remark-math 把 `$…$` 当逐字内容，所以写进单元格的转义永远不会被移除，每一遍都多
一个反斜杠。入站时把 `\|` 还原成 `|` 也不行——`\|` 是 LaTeX 的范数符号。改用
Zotero 自己的 `<span class="math">$…$</span>` 形式则在第三个地方失败：raw span
内部的 `$…$` 会被**再次识别成数学**并套上第二层 `<span class="math">`，每轮翻倍。
完整分析在 `features/math.ts`；gap 记录在 §12。

### 另一种形状：变换遇上裸 HTML

`list.ts` 按 Zotero 编辑器的形状塑造 `<li>` / `<td>` 内容，把每段文本包进
`<span>`。而 remark **不会**把行内 HTML 保留成一个节点——`<span …>text</span>`
到达时是三个兄弟节点：`raw` 开标签、`text`、`raw` 闭标签——所以中间那段文本仅从
类型上看与裸文本run 无法区分。

包装它等于把一个 `<span>` 塞进了**被保留的元素内部**。下一轮入站会把该元素连同
这层新增一起逐字捕获，把它固化进 payload；再下一轮又加一层：Zotero 侧创作的列表里
的一个引用，**每同步一次就多一层嵌套，没有上限**。现在 `rawNesting` 会跟踪每段
raw 片段留下几层未闭合，深度大于 0 的文本一律不动。

这条教训和转义那条是同一个：**任何假定自己面对的是裸内容的变换，在有不透明
payload 被拼接进来的地方都会出错**，而且在某个东西累积起来之前，失败是静默的。

---

## 9. Feature 目录

| 文件 | 语法 | 策略 | Hook |
| --- | --- | --- | --- |
| `note-structure.ts` | 文档形状：`<br>` 周围的杂散空白、根部游离的行内元素、空段落、双重编码的数字字符引用 | — | `cleanHast`、`transformHast` |
| `citation-links.ts` | payload span 外的可点击 `obsidian://zotflow` anchor | 仅显示 | `cleanHast`、`postSerializeHtml` |
| `math.ts` | `<span class="math">` ↔ `$x$`，`<pre class="math">` ↔ `$$x$$` | map | `hastHandlers`、`stringifyHandlers`、`transformHast` |
| `zotero-payloads.ts` | citation / annotation / 颜色 span | preserve | `hastHandlers`、`stringifyHandlers` |
| `marks.ts` | `<u>`、`<sub>`、`<sup>`、strike | map | `hastHandlers`、`stringifyHandlers`、`transformHast` |
| `annotation-image.ts` | 抽出的标注 PNG | preserve（以 alt 文本为载体） | `hastHandlers`、`stringifyHandlers`、`transformMdastOut` |
| `table.ts` | GFM 表格；带样式的表格；无表头表格 | map / preserve | `hastHandlers`、`stringifyHandlers` |
| `list.ts` | `<li>` 修复，`<li>`/`<td>` 的 span 塑形 | map | `hastHandlers`、`transformHast` |
| `task-list.ts` | `- [x]` / `- [ ]` | preserve | `transformMdastIn`、`transformMdastOut` |
| `callout.ts` | `> [!note]`、折叠标记、嵌套 | preserve | `transformMdastIn` |
| `obsidian-syntax.ts` | `[[…]]`、`![[…]]`、`[^1]`、`^[…]`、`#tag` | preserve | `transformMdastIn`、`stringifyHandlers` |
| `code-block.ts` | 围栏与行内代码 | map（info string 降级） | `stringifyHandlers`、`transformHast` |
| `line-breaks.ts` | `<br>` ↔ 换行，取决于 `strictLineBreaks` | map | `hastHandlers`、`transformMdastOut` |
| `link.ts` | 字面 autolink、destination 中的 `&`、`rel` | map | `stringifyHandlers`、`postSerializeMd`、`transformHast` |

`element.ts` 不是 feature——它提供针对 hast 松散类型 `properties` 的带类型读取器
（`classNames`、`hasClass`、`styleStr`）。

两个较复杂条目的补充说明：

**`table.ts`** 通过**嵌套的** `toMarkdown` 调用来序列化，因为 GFM table 扩展掌握
着对齐和填充逻辑，而普通 handler 够不着它。它把合并后的完整 handler 集合减去
`table` 自身传下去（传 `table` 会让嵌套调用对着传给它的那个节点重新进入本
handler，造成无限递归）。这也是 `stringifyHandlers` 里按引用捕获 `allHandlers`
的原因——到序列化时每个 feature 都已贡献完毕，因此单元格内容在表格里和在别处
表现一致。

**`obsidian-syntax.ts`** 使用手写的从左到右扫描，而不是一个带多个分支的正则。
这些形式的括号规则**确实不同**——`^[…]` 内部可以嵌一个 `[[…]]`，其余几种一个
括号都不能有——用单个模式表达需要嵌套量词，其回溯行为难以界定。单次扫描没有这个
问题：每个字符只访问一次。

---

## 10. Processors

见 `processors.ts`。`ConvertService` 持有冻结的 `unified()` 实例并在所有笔记间
复用；流水线只需要五个操作：`parseHtml`、`parseMarkdown`、`mdastToHast`、
`stringifyHtml`、`stringifyMarkdown`。

直接声明这五个操作、而不是到处传 `Processor` 值，是为了让每一步的树类型保持具体。
unified 的 `Processor` 对其输入输出树是泛型的，而共享复用的实例必须宽松到能覆盖
所有情况——这会在每个调用点抹掉树类型，并在每处强迫一次 cast。这些 cast 现在只
存在于唯一一个地方：`ConvertService` 的构造函数。

### 类型

本模块没有 `any`。剩下两个，都具名且有文档：

- `features/types.ts` 里的 `stringifyAs<T>()`，因为 `mdast-util-to-markdown`
  把 handler 的 node 类型定为 `any`（handler 按节点类型索引，无法泛型窄化）。
  这个 cast 被收敛到这一个 helper 里：调用方声明自己注册时用的节点类型，从而
  得到一个受检的函数体。
- `features/list.ts` 里的 `LooseItemChild`，用于 rehype-remark 产出的中间树——
  一个混杂了文本和行内数学的 `<li>` 会让 phrasing content 直接挂在 item 下，
  而 mdast 公开的类型没有建模这种状态。

`npm run lint:convert` 以 `--max-warnings 0` 守住本模块，并在 `npm test` 中最先
运行。仓库其余部分约有 1174 个问题，短期内不可能清零，所以全仓 gate 不是选项——
但没有 gate，一个清零的模块会漂回去。要回退，从 `test` script 里删掉
`npm run lint:convert && `。

---

## 11. 测试

| 命令 | 它在问什么 |
| --- | --- |
| `npm run test:convert` | `test-html-roundtrip.mjs`（66 项）与 `test-md-roundtrip.mjs`（116 项）——「feature X 的行为符合设计吗？」 |
| `npm run test:obsidian-syntax` | 183 个用例 × 2 种换行模式 × 双向——「没人想到过的语法会怎么样？」 |
| `npm run lint:convert` | 本模块 eslint 零问题 |

三者都包含在 `npm test` 中。

### 语法矩阵

`scripts/test-obsidian-syntax.mjs` 是一张**存活矩阵**，不是单元测试。Obsidian
文档化的每种语法都作为独立片段喂进去，再按输出结果分类。**那里的空白是这个测试
的目的，而不是它的疏漏。**

用例通过声明源格式来选定方向：

```
md    Obsidian 创作   md → html → md → html → md
html  Zotero 创作     html → md → html → md → html
```

两个方向都重要，而且**不是镜像**。只有第二个方向才会遇到真实的 citation payload、
标注 span、带样式的表格和 wrapper div——span 累积和 payload-在单元格里 这两个 bug
就是在那里发现的。跑的是**三轮**而不是两轮往返，这样「规范化一次然后稳定」和
「漂移得足够慢、慢到两轮检查会误判为稳定」就能区分开。

判定，从坏到好：

| 判定 | 含义 |
| --- | --- |
| `DRIFT` | 往返不是不动点——内容每次同步都继续变异。**永远算失败**，无论记录的预期是什么 |
| `BROKEN` | 稳定，但缺失了必需的 token，或出现了 `\` 转义 |
| `CANONICAL` | 稳定且语义完好，但非逐字节相同（`-` 项目符号变成 `*`、实体被解析） |
| `VERBATIM` | 去掉行尾空白后逐字节相同 |

每个用例都记录一个 reviewed 过的 `expect`，因此该文件同时是回归闸门：比预期差是
失败，比预期好会提示更新，而符合 `expect: "broken"` 的用例是**已记录的 gap**。
gap 进一步按 `gap: "by-design" | "bug"` 划分——schema 限制是需要记录的事实，
pipeline 限制是待办的工作。

两种 `strictLineBreaks` 设置都会被覆盖。这个开关映射的是**同一个** vault 设置，
生产环境下由 `vaultConfig` 同时传给两个方向，所以混搭是不可能出现的配置。给
`md2html` 和 `html2md` 传不同的值，正是过去让 `<br>` 处理看起来坏掉（而其实没有）
的原因。

### 幂等性

md harness 断言的是 `g(f(g(f(x)))) == g(f(x))`，而不是 `f(g(f(x))) == f(x)`。

往返被允许**规范化一次**——项目符号变成 `*`、`&nbsp;` 变成 U+00A0——因为手写的
测试输入本来就不必已经是规范形式。绝不允许发生的是**漂移**：每一遍都多长一个
反斜杠的转义、反复重新编码的实体、不断累积的 `<span>`。在第一遍就要求相等会把
这两者混为一谈，并对任何手写输入报错。

---

## 12. 已知 gap

由矩阵负责保持诚实；运行 `npm run test:obsidian-syntax` 查看当前列表。

**受限于 Zotero 的 schema——这里无事可做。**

| Gap | 细节 |
| --- | --- |
| 围栏 info string | Zotero schema 里的 `codeBlock` 只有 `dir` 和 `indent` 两个 attr；`parseDOM` 不读别的，`toDOM` 发出 `<pre style dir data-indent>`。已对照 `note-editor/src/core/schema/nodes.js` 确认 |
| ` ```mermaid ` | 同一成因，但后果可见：丢了标签后 Obsidian 会把源码渲染成普通代码块，而不是图表 |
| YAML frontmatter | 没有组合 `remark-frontmatter`；Zotero 笔记无处存放它，而 vault 笔记自身的 properties 在转换器之外处理 |

`<pre class="math">` 能存活，**仅仅**是因为 `math_display` 在 Zotero schema 里是
一个**独立节点**，其 `parseDOM: [{tag: 'pre.math'}]`——ProseMirror 会选更具体的
规则。裸 `<pre>` 上的 class 不会存活。`<pre data-language>` 能挺过存储（`data-*`
在 TinyMCE 白名单里），但只要笔记在 Zotero 自己的编辑器里被编辑就会丢失，而且
Zotero 自己的 markdown 解析器（`fence: { block: 'codeBlock' }`）同样会丢掉语言。

**主动决定不做。** 这些是能保住的，但经过权衡后决定不做。它们和 bug 分开列，
免得一个已经拍板的决定被读成待办工作；完整理由写在对应的矩阵用例里。

| Gap | 为什么不做 |
| --- | --- |
| `- [/]`、`- [?]` —— Tasks 插件状态 | 是插件语法而非 Obsidian 自身语法；不销毁内容（`\[/]` 渲染成 `[/]`）；而且不同于 `#tag`，这个豁免**无法从 CommonMark 推导**——`[` 到处都要转义，因为 `[foo]` 会不会变成链接取决于文档别处有没有定义，而序列化器看不到那里。结构上正确的修法（像 GFM 处理 `[x]` 那样把标记从文本里提升出去）需要注册 `listItem` handler，那会顶掉未导出的 `listItemWithTaskListItem` |
| 未被引用的 `[label]: url` | 直接删除，确实是真丢失——但**被引用**的定义是无损的（变成同目标的行内链接），而标签打错时链接文字仍在，被孤立的那个引用**在 Obsidian 里本来也不是链接**。于是只剩「故意囤着留以后用」这一种。真正支持引用语法只会更糟：未解析的 `[text][ref]` 到 Zotero 会变成纯文本，而不是能点的 `<a href>` |

**受限于流水线。**

| Gap | 细节 |
| --- | --- |
| `[[x*y*z]]` | `md2html` 把 `*y*` 解析成 emphasis，于是 wikilink 以三个兄弟节点的形式回来——text、`emphasis`、text——而逐 text 节点工作的扫描永远拼不回它。只有真正的 `[[…]]` micromark construct（在 tokenize 阶段优先于 emphasis）才能解决这一类。相比之下下划线是安全的（`[[a_b_c]]`），因为 CommonMark 不允许词内 `_` 强调 |
| 单元格里的 `$a\|b$` | 行内数学里的裸 `\|` 落在单元格里会撕裂整行并丢掉后一格。**只能从 Zotero 侧到达**——markdown 表达不出来，因为那个竖线会先结束单元格。三种候选修法各自换来另一种损坏；见 §8 和 `features/math.ts` |

**已经发布的行为变更**，列在此处以免把一次性同步 diff 误认成 bug：

- task marker 从 `<li>[x] <span>text</span>` 改为 `<li><span>[x] text</span>`，
  与 Zotero 自家编辑器的输出一致；
- `![[…]]` 现在被保留，而不再展开为 `![](…)`。已经同步成 `![](…)` 的旧笔记
  维持原样。

---

## 13. 新增 feature

1. **先决定策略**——map、preserve 还是 degrade（§1）。preserve 的可用性远比看上去
   高，因为 Zotero 会逐字保存它不认识的文本。
2. **建一个文件**放进 `features/`，两个方向都写在里面。
3. **只实现你需要的 hook。** 如果你发现自己想用 `postSerializeMd`，停下来检查一下
   树能不能表达它——字符串 pass 分不清正文和代码围栏内部。
4. **在 `features/index.ts` 里注册。** 如果顺序有讲究，在注释块里说明原因；如果
   没讲究，也把这一点说出来。
5. **在 `scripts/_test-obsidian-syntax-entry.ts` 里加矩阵用例**，至少包含一个
   对抗用例。`wikilink-punctuation` 这个用例的存在，是因为它否决了一个看起来
   很合理的设计；`table-break-plain` 对照组的存在，是为了让失败能够被归因。
6. **跑 `npm test`。** `lint:convert` 必须保持零。

### 不变量

破坏这些，本模块就不再可信：

- 不得在解析前对 markdown 做全字符串改写。
- 不得新增 `any`。现存两个，都具名且有文档。
- `DRIFT` 永不可接受，无论预期如何。
- 降级必须记录原因。
- 不要为目的地无法表示的东西引入解析器扩展（§6）。
- `strictLineBreaks` 是同一个 vault 设置——绝不要用不同的值测试或调用两个方向。
