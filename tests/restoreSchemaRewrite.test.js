/**
 * restoreService.rewriteSchemaNames — 影子恢复 SQL schema 名重写单元测试（P1）
 * 覆盖：PG18 形态（schema 无引号）、旧版形态（schema 带引号）、CREATE SCHEMA 语句、
 * 不误伤 school_x_restore（影子名不二次改写）、COPY / ALTER 等引用。
 */
import { rewriteSchemaNames } from '../backend/lib/restoreSqlUtils.js'
import { stripCreateSchema } from '../backend/lib/restoreStagingSql.js'

describe('rewriteSchemaNames', () => {
  test('PG18 形态：schema 无引号引用全部改写', () => {
    const sql = [
      'CREATE SCHEMA school_demo;',
      'CREATE TABLE school_demo."TestRecord" (id text);',
      'COPY school_demo."TestRecord" (id) FROM stdin;',
      'ALTER TABLE ONLY school_demo."TestRecord" ADD CONSTRAINT pk PRIMARY KEY (id);',
    ].join('\n')
    const out = rewriteSchemaNames(sql, 'school_demo', 'school_demo_restore')
    expect(out).toContain('CREATE SCHEMA "school_demo_restore";')
    expect(out).toContain('CREATE TABLE school_demo_restore."TestRecord"')
    expect(out).toContain('COPY school_demo_restore."TestRecord"')
    expect(out).toContain('ALTER TABLE ONLY school_demo_restore."TestRecord"')
    expect(out).not.toContain('school_demo."')
  })

  test('旧版形态：schema 带引号引用改写', () => {
    const sql = 'CREATE TABLE "school_demo"."User" (id text);'
    const out = rewriteSchemaNames(sql, 'school_demo', 'school_demo_restore')
    expect(out).toContain('CREATE TABLE "school_demo_restore"."User"')
  })

  test('不误伤影子名（school_demo_restore 不二次改写）', () => {
    // 若输入已含 restore 名（如注释），school_demo_restore. 不应变成 school_demo_restore_restore.
    const sql = '-- 已存在 school_demo_restore."X" 注释\nCREATE TABLE school_demo."A" (id int);'
    const out = rewriteSchemaNames(sql, 'school_demo', 'school_demo_restore')
    expect(out).not.toContain('school_demo_restore_restore.')
    expect(out).toContain('school_demo_restore."A"')
  })

  test('CREATE SCHEMA 带引号与不带引号均被改写', () => {
    expect(rewriteSchemaNames('CREATE SCHEMA school_demo;', 'school_demo', 'school_demo_restore'))
      .toBe('CREATE SCHEMA "school_demo_restore";')
    expect(rewriteSchemaNames('CREATE SCHEMA "school_demo";', 'school_demo', 'school_demo_restore'))
      .toBe('CREATE SCHEMA "school_demo_restore";')
  })

  test('无 schema 限定的裸语句不受影响', () => {
    const sql = 'SET statement_timeout = 0;\nSELECT pg_catalog.set_config(\'search_path\', \'\', false);'
    expect(rewriteSchemaNames(sql, 'school_demo', 'school_demo_restore')).toBe(sql)
  })
})

/**
 * P3-W3-T01 语义更新（旧断言全部保留，仅追加）：
 * 新恢复引擎先显式 CREATE SCHEMA "<随机暂存名>" 并登记 OID（归属证据），
 * 因此备份 SQL 里被改写出来的 `CREATE SCHEMA "<暂存名>";` 必须在执行前剔除，
 * 否则 psql 报 schema already exists 而中断恢复。
 */
describe('stripCreateSchema（P3-W3-T01 暂存 schema 归属）', () => {
  test('剔除带引号/不带引号的暂存 CREATE SCHEMA 语句，保留其他内容', () => {
    const sql = [
      'SET statement_timeout = 0;',
      'CREATE SCHEMA "school_demo_stg_ab12cd34";',
      'CREATE TABLE school_demo_stg_ab12cd34."User" (id text);',
    ].join('\n')
    const out = stripCreateSchema(sql, 'school_demo_stg_ab12cd34')
    expect(out).not.toContain('CREATE SCHEMA')
    expect(out).toContain('SET statement_timeout = 0;')
    expect(out).toContain('CREATE TABLE school_demo_stg_ab12cd34."User"')
  })

  test('无引号形态同样剔除；只删目标 schema，不动其他 schema 的 CREATE SCHEMA', () => {
    const sql = 'CREATE SCHEMA school_demo_stg_ab12cd34;\nCREATE SCHEMA public;'
    const out = stripCreateSchema(sql, 'school_demo_stg_ab12cd34')
    expect(out).toBe('CREATE SCHEMA public;')
  })

  test('同行多语句：只删目标语句，保留同行其余语句', () => {
    const sql = 'CREATE SCHEMA school_x; CREATE TABLE school_x."A" (id int);'
    const out = stripCreateSchema(sql, 'school_x')
    expect(out).toBe(' CREATE TABLE school_x."A" (id int);')
  })

  test('rewriteSchemaNames + stripCreateSchema 组合：结果不含任何暂存 CREATE SCHEMA（新引擎执行前的形态）', () => {
    const raw = 'CREATE SCHEMA school_demo;\nCREATE TABLE school_demo."A" (id int);\nCOPY school_demo."A" (id) FROM stdin;'
    const rewritten = rewriteSchemaNames(raw, 'school_demo', 'school_demo_stg_ab12cd34')
    const out = stripCreateSchema(rewritten, 'school_demo_stg_ab12cd34')
    expect(out).not.toMatch(/CREATE\s+SCHEMA/i)
    expect(out).toContain('CREATE TABLE school_demo_stg_ab12cd34."A"')
    expect(out).toContain('COPY school_demo_stg_ab12cd34."A"')
  })
})
