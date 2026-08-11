/**
 * restoreService.rewriteSchemaNames — 影子恢复 SQL schema 名重写单元测试（P1）
 * 覆盖：PG18 形态（schema 无引号）、旧版形态（schema 带引号）、CREATE SCHEMA 语句、
 * 不误伤 school_x_restore（影子名不二次改写）、COPY / ALTER 等引用。
 */
import { rewriteSchemaNames } from '../backend/lib/restoreSqlUtils.js'

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
