// P3-W0-T01 — @prisma/client 测试替身：只记录调用，绝不连接数据库。
import { record } from './stub-record.mjs'

export class PrismaClient {
    constructor(...args) {
        record('new PrismaClient')
        this._args = args
        this._stub = true
    }
    async $connect() { record('prisma.$connect') }
    async $disconnect() { record('prisma.$disconnect') }
    async $queryRawUnsafe() { record('prisma.$queryRawUnsafe'); return [] }
    async $executeRawUnsafe() { record('prisma.$executeRawUnsafe'); return 0 }
    async $queryRaw() { record('prisma.$queryRaw'); return [] }
    async $executeRaw() { record('prisma.$executeRaw'); return 0 }
    async $transaction(arg) { record('prisma.$transaction'); return typeof arg === 'function' ? arg(this) : [] }
}

export const Prisma = { PrismaClient, TransactionIsolationLevel: {} }
export default { PrismaClient, Prisma }
