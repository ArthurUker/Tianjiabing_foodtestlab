// P3-W0-T01-R1 — dotenv 测试替身：把 config() 的查找限定到测试指定的合成文件。
//
// 与真实 dotenv 的区别仅在"从哪里加载"：
//   - config() 只读取 options.path 或环境变量 P3W0_DOTENV_PATH 指向的合成文件；
//     路径未设置 → 记录并抛错（fail-closed，不落到默认的 cwd/.env 查找）。
//   - parse() 与其它导出保持真实实现（round-trip 测试依赖真实语义）。
import { record } from './stub-record.mjs'
import realDotenv from '../../../node_modules/dotenv/lib/main.js?real'

function restrictedConfig(options = {}) {
    const target = (options && options.path) || process.env.P3W0_DOTENV_PATH
    if (!target) {
        record('dotenv.config BLOCKED:no-path')
        throw new Error('dotenv.config is restricted in this test runner: set P3W0_DOTENV_PATH to a synthetic file (default cwd/.env lookup is intentionally blocked)')
    }
    record('dotenv.config:allowed')
    return realDotenv.config({ ...options, path: target })
}

export const parse = realDotenv.parse
export const populate = realDotenv.populate
export const configDotenv = restrictedConfig
export { restrictedConfig as config }

export default {
    ...realDotenv,
    config: restrictedConfig,
}
