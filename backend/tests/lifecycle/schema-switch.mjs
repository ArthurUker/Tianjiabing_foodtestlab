// P3-LIFECYCLE-AB-R3 · A/B schema 切换 → prisma generate（两段部署的 client 生成器）
// 用法：node backend/tests/lifecycle/schema-switch.mjs A|B
//   A：principal_id String? + optional relation（nullable client）
//   B：principal_id String  + required  relation（required client）
// 只改 schema.prisma 中 AuditLog 的这两行；其它内容不动；生成后打印 dmmf.isRequired 与实际行。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const mode = (process.argv[2] || '').toUpperCase()
if (!['A', 'B'].includes(mode)) { console.error('用法：schema-switch.mjs A|B'); process.exit(2) }
const SCHEMA = 'backend/prisma/schema.prisma'
let text = fs.readFileSync(SCHEMA, 'utf8')

const A_PRINCIPAL = '  principal_id  String?'
const B_PRINCIPAL = '  principal_id  String'
const A_REL = '  principal     AuditPrincipal? @relation(fields: [principal_id], references: [id], onDelete: Restrict)'
const B_REL = '  principal     AuditPrincipal  @relation(fields: [principal_id], references: [id], onDelete: Restrict)'

if (mode === 'B') {
  if (!text.includes(A_PRINCIPAL) || !text.includes(A_REL)) {
    if (text.includes(B_PRINCIPAL.trimEnd() + '\n') || text.includes(B_REL)) { console.log('已是 B 版'); }
    else { console.error('当前不是 A 版（无法切到 B）'); process.exit(3) }
  } else {
    text = text.replace(A_PRINCIPAL, B_PRINCIPAL).replace(A_REL, B_REL)
    fs.writeFileSync(SCHEMA, text)
  }
} else {
  if (!text.includes(B_PRINCIPAL) || !text.includes(B_REL)) {
    if (text.includes(A_PRINCIPAL)) { console.log('已是 A 版'); }
    else { console.error('当前不是 B 版（无法切回 A）'); process.exit(3) }
  } else {
    text = text.replace(B_PRINCIPAL, A_PRINCIPAL).replace(B_REL, A_REL)
    fs.writeFileSync(SCHEMA, text)
  }
}

const gen = execFileSync('npx', ['prisma', 'generate'], { cwd: 'backend', encoding: 'utf8' })
const idx = crypto.createHash('sha256').update(fs.readFileSync('backend/node_modules/.prisma/client/index.js')).digest('hex')
const { Prisma } = await import('@prisma/client')
const field = Prisma.dmmf.datamodel.models.find((m) => m.name === 'AuditLog').fields.find((f) => f.name === 'principal_id')
console.log(JSON.stringify({ mode, isRequired: field?.isRequired === true, clientIndexSha256: idx, generateTail: String(gen).trim().split('\n').slice(-1)[0] }))
