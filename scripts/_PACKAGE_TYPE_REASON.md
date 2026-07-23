# 为什么 scripts/package.json 必须保留

仓库根 `package.json` 声明了 `"type": "module"`（ESM）。

但 `scripts/build-static.js` 是 **CommonJS**：它使用 `require()` 与 `__dirname`。

如果删除 `scripts/package.json`，Node 在解析模块类型时会向上查找最近的 `package.json`，
即根目录的 `"type": "module"`，从而把 `scripts/build-static.js` 当作 ESM 处理，
导致运行时抛出：

    ReferenceError: require is not defined in ES module scope

因此 `scripts/package.json`（`{"type":"commonjs"}`）必须提交进仓库，
使 `scripts/*.js` 仍按 CommonJS 处理，不改动脚本内容、不碰部署流水线。

详见文档：`docs/deployment/dev-test-deployment-guide.md` §12.3
（"前端构建报 ReferenceError: require is not defined in ES module scope"）。

> TODO（docs 所有者 W7 处理，勿在此处编辑文档）：
> `docs/PROJECT_CONVENTIONS.md` 约第 208 行仍引用已删除的 `scripts/smoke-guest.mjs`，
> 应在清理遗留脚本时一并更新该描述。
