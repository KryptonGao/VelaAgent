// Node 的类型剥离不会给无后缀的相对导入补上 .ts，测试要先挂上这个解析。
import { register } from "node:module";

await register("./resolve-ts-hook.mjs", {
  parentURL: import.meta.url,
});
