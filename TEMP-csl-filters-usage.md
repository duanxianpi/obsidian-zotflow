# CSL 模板 Filter 用法(临时笔记)

> `citation` / `bibliography` 两个 filter,仅注册在 **library-note 模板引擎**上
> ——source note 模板和 citation 模板(footnote/wikilink/pandoc)共用这个引擎,
> 都能用;local template 不可用。
> 对应实现:`src/worker/services/library-template.ts`(commit 213408e + ebdf838 + e07442a)

## 数据来源

- Sync 时通过 Zotero API `include=data,csljson` 存下服务端转换好的 CSL-JSON,
  挂在 IDB item 的非索引字段 `csljson` 上(attachment/note/annotation 无此字段)。
- 老数据(本次改动前 sync 的)首次被 filter 引用时**懒回填**:单条拉取补存,一次性成本;
  离线时报结构化错误("run a sync")。
- 也可以手动全量刷新:命令 **"Update CSL citation data for all items"**
  (后台 task,分块 100 条/批,Activity Center Tasks 页可看进度/取消)。
- 模板里也能直接读:`{{ item.csljson.title }}`。

## citation — 单个或列表,输出一条引用(簇)

```liquid
{{ item | citation }}                          →  (Doe, 2020)
{{ item | citation: "ieee" }}                  →  [1]           (位置参数 = style 简写)
{{ item | citation: style: "apa", locale: "de-DE", format: "text" }}
{{ items | citation }}                         →  (Doe, 2020; Roe, 2021)   单个引用簇
```

列表渲染成**一个 cluster**(合并/排序/分号由 citeproc 按 style 规则处理),
不是逐条渲染再拼接——想要各自独立的引用才用 for 循环。

### annotation 糖:自动带页码

管道里放 annotation 时,自动引用它所标注的文献条目(annotation → attachment → 顶层 item),
`pageLabel` 作为 page locator,"p."/"pp." 单复数由 citeproc + locale 决定:

```liquid
{{ annotation | citation }}                    →  (Doe, 2020, p. 5)
{{ annotation | citation: "chicago-note-bibliography" }}
                                               →  Doe, *Title* (2020), 5.
{{ annotations | citation }}                   →  (Doe, 2020, p. 5; Roe, 2021, p. 12)
```

列表里可以混放 item 和 annotation,locator 逐元素生效。
孤儿 annotation(无父 attachment)或 standalone attachment 的 annotation 会报明确错误。

## bibliography — 收列表(单个也行),输出参考文献表

```liquid
{{ items | bibliography }}
{{ items | bibliography: style: "apa", join: "\n\n" }}
{{ item  | bibliography: "ieee" }}             →  [1] A. Author, …(单条也可)
```

**必须整批传入**:排序和编号是 citeproc 对整个列表算的,
用 for 循环逐条渲染会导致 numbered style 每条都输出 `[1]`、排序失效。

## 参数一览(全部可选)

| 参数 | 默认值 | 说明 |
|---|---|---|
| 位置参数 / `style:` | 设置里的默认 style | style id,如 `"ieee"`、`"apa"` |
| `locale:` | style 声明的 default-locale → en-US | BCP-47,如 `"zh-CN"` |
| `format:` | 设置里的默认 format | `text` / `html` / `markdown` / `markdown-pure` |
| `join:` | `"\n\n"` | 仅 bibliography:条目间分隔符 |

未知参数名、非法 format 会直接报错(带支持列表)。
style 依赖链未闭合(缺 parent / locale)时报可操作错误,不静默降级——
去 Activity Center 补装即可。

## 实用配方

### 脚注工作流

Note 类 style(Chicago full note 等):`citation` 输出的就是完整脚注体:

```liquid
[^{{ item.citationKey }}]: {{ item | citation: "chicago-note-bibliography" }}
```

Numbered style(IEEE):单 item 渲染**编号恒为 `[1]`**(每次调用独立渲染),
所以可以确定性地裁掉,编号交给 Obsidian 脚注自动排:

```liquid
[^{{ item.citationKey }}]: {{ item | bibliography: "ieee" | remove_first: "[1] " }}
```

非 numbered style 没有 `[1]` 前缀,`remove_first` 匹配不到就原样输出,不会误伤。

### 相关文献列表

```liquid
{% assign cited = item.relatedItems | where: "resolved", true %}
{% if cited.size > 0 %}
## References
{{ cited | bibliography: style: "apa" }}
{% endif %}
```

## 已知局限

- Filter 每次调用是独立渲染,**作者消歧不跨调用生效**
  (同姓作者不会自动变成 "J. Doe" / "M. Doe";ibid. 类位置感知也不适用)。
- 显式 `locator:` kwarg 未实现(方案 2 跳过),页码目前只从 annotation 糖进;
  要加就是 `parseCslRenderArgs` 里加两个 case。
