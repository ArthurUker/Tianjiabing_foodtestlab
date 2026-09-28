// P3-W0-T01 — stub invocation recorder.
// 每个测试替身在被调用时把名称追加到 P3W0_STUB_MARKER 指定的文件。
// 启动负例断言 marker 文件不存在或为空 → 证明副作用（Prisma/后台任务）未发生。
import fs from 'node:fs'

export function record(name) {
    const marker = process.env.P3W0_STUB_MARKER
    if (!marker) return
    try {
        fs.appendFileSync(marker, `${name}\n`)
    } catch {
        // marker 写入失败不影响被测进程；测试侧会因缺少记录而失败，属于预期暴露
    }
}
