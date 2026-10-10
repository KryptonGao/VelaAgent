import type { InteractionMode, UiPreference } from "@vela/shared";

/**
 * Intelligent UI 的能力说明：只在允许的偏好与模式下注入系统提示。
 * 语法由 packages/shared 的校验器兜底，这里只是告诉模型「可以怎么写」。
 * 模型写不出合法 UI 时界面会降级为原始文字，所以说明里强调「正文必须自己能读懂」。
 */

const example = [
  '{"op":"begin","id":"bill-split","version":1,"title":"账单平摊"}',
  '{"op":"state","name":"amount","kind":"number","initial":240,"min":0}',
  '{"op":"state","name":"people","kind":"number","initial":5,"min":1}',
  '{"op":"node","id":"root","type":"column","props":{}}',
  '{"op":"node","id":"amountInput","parent":"root","type":"number_input","props":{"label":"总额","unit":"元","bind":"amount"}}',
  '{"op":"node","id":"peopleInput","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}',
  '{"op":"node","id":"each","parent":"root","type":"stat","props":{"label":"每人金额","unit":"元","digits":2,"value":{"op":"round","args":[{"op":"divide","args":[{"ref":"amount"},{"ref":"people"}]},2]}}}',
  '{"op":"commit"}',
].join("\n");

const syntax = `## Intelligent UI（可选的交互式回答）

回答里可以嵌入原生交互界面。界面是声明式数据，不是代码：不要输出 HTML、JavaScript、JSX、CSS 或任何脚本，界面不会执行它们。

### 什么时候用
- 纯文本、一句命令、简短解释、代码片段：直接用文字，不要生成界面。
- 适合界面：多个对象的比较（表格）、需要调参数看结果的计算器、分组分类后要筛选的清单、分步骤的教学演示。
- 界面只是回答的一部分：先用文字说明结论、假设和每个控件的用途，再放界面。不要用一个巨型界面替换整段回答，不要编造「可信度 xx%」之类的指标。
- 界面里的数据必须来自你已经知道或已经用工具读到的内容。不确定的数值标明是估计，不要伪造来源；写了 source 也会被显示为「未验证」。

### 格式
用围栏 \`\`\`vela-ui 包住，每行一个 JSON 对象（NDJSON），按顺序：
1. {"op":"begin","id":"<唯一id>","version":1,"title":"<标题，可选>"} 必须是第一行。
2. {"op":"state","name":"<名字>","kind":"number|string|boolean","initial":<初始值>} 可选：min/max/step（number）、maxLength/options（string）。
3. {"op":"derive","name":"<名字>","expr":<表达式>} 可选：派生值，可被其它表达式用 {"ref":"名字"} 引用，不能循环依赖。
4. {"op":"node","id":"<id>","parent":"<父节点id>","type":"<组件>","props":{...}} 第一个 node 是根（不写 parent，用 column/card 等容器），之后每个节点的父节点必须已经出现。
5. {"op":"commit"} 最后一行。缺少 commit 的界面会被标为「未完成」。

规则：整个 JSON 必须在一行内；先输出会先显示，所以按「骨架 → 内容」的顺序写；一个块最多 200 个节点、深度 12、50 个状态；名字用字母开头的字母数字下划线；要在文字里展示这种语法本身时，用四个反引号的外层围栏包住，或不写 begin，这样不会被当成界面。

### 组件（type 与主要 props）
- 文本：text{text,tone?} heading{text,level?1-3} caption{text} code{code,language?}
- 布局：column / row / grid{columns?} / divider / card{title?,description?}（容器：column、row、grid、card、tabs、collapsible）
- 数据：table{columns:[{key,label,sortable?,align?,unit?,digits?}],rows:[{<key>:值,detail?:"展开说明"}],searchable?,filter?:{bind,column,allValue?},defaultSort?:{column,direction}} stat{label,value,unit?,digits?,description?} progress{label,value,max?} list{items:[字符串或{text,detail}],ordered?}
- 选择：tabs{bind,label,options} segmented / select / radio{bind,label,options,description?}，options 是字符串或 {value,label}；bind 的状态必须是 string
- 输入：number_input{bind,label,unit?} slider{bind,label,unit?}（用状态的 min/max/step）input{bind,label,placeholder?} checkbox{bind,label}
- 操作：button{label,variant?,action} collapsible{title,defaultOpen?}
- 反馈：loading / empty{title} / error{title}
- 所有组件都可以带 show：一个表达式，结果为 true 才显示（例如 tabs 下的各面板按所选页签显示）。
- 数据类组件可带 status（ok|loading|stale|error|empty）和 source{label,url?}。

### 表达式
字面量（数字、字符串、布尔、null）、{"ref":"状态或派生值名"}、或 {"op":...,"args":[...]}。可用 op：add subtract multiply divide round floor ceil（可带位数）abs min max compare(a,"lt|lte|gt|gte|eq|neq",b) if(条件,是,否) and or not format(数,位数?,"number|fixed|percent") concat。
除数可能为零时用 if 守卫。表达式不能读时间、文件、网络或剪贴板。

### 动作（button.action）
set_state{name,value} toggle{name} copy{text} open_external{url，仅 http/https} submit_to_agent{text,include?}。
- 滑块、页签、筛选、排序、勾选都在本地即时生效，不会打扰你，也不需要按钮。
- 只有需要你继续工作时才用 submit_to_agent：用户点击并确认后，会把当前参数作为一条新消息发给你。
- 界面不能调用工具、改文件或执行命令。

### 示例（用户问「5 个人平摊 240 元，每人多少钱」）
先用一句话给出答案和假设，然后：
\`\`\`vela-ui
${example}
\`\`\`
`;

const autoNote = "按需使用：多数回答保持纯文字，只有界面明显比文字更好用时才生成。";
const visualNote = "这位用户偏好可视化：比较、计算、参数探索类的问题优先用界面；但简单问答、命令和代码仍然只用文字。";
const textOnlyNote = "用户关闭了 Intelligent UI。不要输出 vela-ui 围栏，即使之前的消息里出现过也不要模仿；用 Markdown 表格、列表和文字回答。";

/** 返回要追加到系统提示的文字；不需要时返回 null。 */
export function intelligentUiInstructions(preference: UiPreference, mode: InteractionMode): string | null {
  // Plan 要产出 <proposed_plan> 文档；Goal 要产出验证报告。两者保持纯 Markdown，互不干扰。
  if (mode !== "agent") return null;
  if (preference === "text_only") return textOnlyNote;
  return `${syntax}\n${preference === "visual_first" ? visualNote : autoNote}`;
}

export const intelligentUiExample = example;
