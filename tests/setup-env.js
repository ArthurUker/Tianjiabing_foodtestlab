/**
 * Jest 全局 setup（setupFiles）：在任何测试模块加载前执行。
 *
 * superagent/cuid2（经 supertest 引入）在 Node < 21 且全局缺少 TextEncoder 时
 * 模块初始化即崩溃（ReferenceError: TextEncoder is not defined）。jest 的 jsdom
 * 环境不提供全局 TextEncoder，故在此补 polyfill（node:util 提供同构实现）。
 */
import { TextEncoder, TextDecoder } from 'node:util'

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder
}
