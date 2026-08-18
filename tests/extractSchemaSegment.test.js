/**
 * restoreSqlUtils.extractSchemaSegment 单元测试（TD-Backup-Restore-Extract-Bug）
 *
 * 覆盖关键边界：
 *   - PG17 风格头部 `\restrict`/`\unrestrict` psql meta-commands 被丢弃（旧 PG14 不识别）
 *   - 复杂 CHECK 约束（含 `'admin'::text`、`ARRAY[...]` 字符串字面量）不导致括号配对算法失衡
 *   - CREATE FUNCTION 等大块 PL/pgSQL（dollar-quote `$_$...$_$`）被正确整体保留 / 丢弃
 *   - COPY 块结构不会被错切
 *   - 真实备份复现：User 表 + 复杂 CHECK + 紧随其后的 COPY Attachment（截图报错的 schema_hqyz 场景）
 */
import { extractSchemaSegment } from '../backend/lib/restoreSqlUtils.js'

describe('extractSchemaSegment', () => {
  test('基本提取：仅保留目标 schema 的 CREATE TABLE / COPY', () => {
    const sql = [
      'SET statement_timeout = 0;',
      'SELECT pg_catalog.set_config(\'search_path\', \'\', false);',
      '',
      'CREATE SCHEMA public;',
      'CREATE SCHEMA school_demo;',
      'CREATE SCHEMA school_other;',
      '',
      '-- Name: school_demo."Test"; Type: TABLE; Schema: school_demo; Owner: -',
      'CREATE TABLE school_demo."Test" (id text);',
      'COPY school_demo."Test" (id) FROM stdin;',
      '\\.',
      '',
      '-- Name: school_other."Other"; Type: TABLE; Schema: school_other; Owner: -',
      'CREATE TABLE school_other."Other" (id text);',
      'COPY school_other."Other" (id) FROM stdin;',
      'data',
      '\\.',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'school_demo')
    // 必须保留目标 schema 的表和数据
    expect(seg).toContain('CREATE TABLE school_demo."Test"')
    expect(seg).toContain('COPY school_demo."Test"')
    expect(seg).toMatch(/\\\.$/m) // .结尾
    // 必须丢弃其它 schema
    expect(seg).not.toContain('school_other."Other"')
    expect(seg).not.toContain('school_other.')
    expect(seg).not.toContain('CREATE SCHEMA school_other;')
    // 必须保留目标 schema 的 CREATE SCHEMA
    expect(seg).toContain('CREATE SCHEMA school_demo;')
  })

  test('PG17+ 风格头部：\\restrict \\unrestrict \\encoding meta-commands 被丢弃（旧 PG14 不识别）', () => {
    const sql = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '\\restrict ePKvpz2NiOYwj287ZSLD9j3T45M4n661fU9fwqYsc1ivoWg1qaP3irfwYx6sYON',
      '',
      '-- Dumped from database version 14.23',
      '-- Dumped by pg_dump version 14.23',
      '',
      'SET statement_timeout = 0;',
      'SELECT pg_catalog.set_config(\'search_path\', \'\', false);',
      '',
      'CREATE SCHEMA school_demo;',
      '-- Name: school_demo."T"; Type: TABLE; Schema: school_demo; Owner: -',
      'CREATE TABLE school_demo."T" (id text);',
      'COPY school_demo."T" (id) FROM stdin;',
      '\\.',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'school_demo')
    // \\restrict 必须被丢弃（旧 PG14 报错：invalid command \\）
    expect(seg).not.toMatch(/^\\restrict/m)
    // 头部 SET/SELECT 必须保留
    expect(seg).toContain('SET statement_timeout = 0;')
    expect(seg).toContain('SELECT pg_catalog.set_config')
    // 实际表必须保留
    expect(seg).toContain('CREATE TABLE school_demo."T"')
    expect(seg).toContain('COPY school_demo."T"')
  })

  test('复现截图 bug：User 表含复杂 CONSTRAINT 紧随其后的 COPY 块不被错切', () => {
    // 真实 schema_hqyz 备份中的 User 表结构（PG14，含角色 CHECK 约束）
    const sql = [
      'CREATE SCHEMA school_hqyz;',
      '',
      '-- Name: school_hqyz."User"; Type: TABLE; Schema: school_hqyz; Owner: -',
      'CREATE TABLE school_hqyz."User" (',
      '    id text NOT NULL,',
      '    username text NOT NULL,',
      '    role text DEFAULT \'operator\'::text NOT NULL,',
      '    CONSTRAINT user_role_check CHECK ((role = ANY (ARRAY[\'admin\'::text, \'manager\'::text, \'operator\'::text, \'viewer\'::text])))',
      ');',
      '',
      'COPY school_hqyz."User" (id, username, role) FROM stdin;',
      'test_id1\tuser1\tadmin',
      '\\.',
      '',
      'COPY school_hqyz."Attachment" (id) FROM stdin;',
      'att1',
      '\\.',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'school_hqyz')
    // User 表必须完整保留（字段 + 约束 + 末尾 `);`）
    expect(seg).toContain('CREATE TABLE school_hqyz."User" (')
    expect(seg).toContain('CONSTRAINT user_role_check CHECK')
    expect(seg).toMatch(/CONSTRAINT user_role_check CHECK[^\n]*\n\);/)  // 约束完整 + ); 结束
    // User 表的 COPY 块必须完整
    expect(seg).toContain('COPY school_hqyz."User" (id, username, role)')
    expect(seg).toMatch(/COPY school_hqyz\."User"[^\n]*\ntest_id1\tuser1\tadmin\n\\\./)
    // Attachment 紧随其后，必须保留（这是截图错误的核心：它被错切丢数据）
    expect(seg).toContain('COPY school_hqyz."Attachment" (id)')
    expect(seg).toMatch(/COPY school_hqyz\."Attachment"[^\n]*\natt1\n\\\./)
    // 不应孤立出现单个 `\` 行（psql 会报 invalid command \）
    expect(seg).not.toMatch(/^[\\]$/m) // 单独的 \ 行
  })

  test('PL/pgSQL 函数体（dollar-quote）作为整体段保留 / 丢弃', () => {
    const sql = [
      'CREATE SCHEMA school_a;',
      'CREATE SCHEMA school_b;',
      '',
      // 段锚点
      '-- Name: audit_role_change(); Type: FUNCTION; Schema: school_a; Owner: -',
      'CREATE FUNCTION school_a.audit_role_change() RETURNS trigger',
      'LANGUAGE plpgsql AS $_$',
      'BEGIN',
      '  INSERT INTO school_b."AuditLog" VALUES (NEW.id);',  // 注意这里引用了 school_b
      '  RETURN NEW;',
      'END;',
      '$_$;',
      '',
      '-- Name: school_b.audit_role_change(); Type: FUNCTION; Schema: school_b; Owner: -',
      'CREATE FUNCTION school_b.audit_role_change() RETURNS trigger',
      'LANGUAGE plpgsql AS $_$',
      'BEGIN',
      '  RETURN NEW;',
      'END;',
      '$_$;',
    ].join('\n')
    // 提取 school_a 段
    const segA = extractSchemaSegment(sql, 'school_a')
    expect(segA).toContain('CREATE FUNCTION school_a.audit_role_change()')
    expect(segA).toContain('$_$')
    // 函数体内部即便引用了 school_b，仍属于 school_a 段的一部分
    expect(segA).toContain('INSERT INTO school_b."AuditLog" VALUES (NEW.id)')
    expect(segA).not.toContain('CREATE FUNCTION school_b.')
  })

  test('多表连续段：CREATE TABLE 后跟随 ALTER / INDEX 等都要跟在同一段中', () => {
    const sql = [
      'CREATE SCHEMA demo;',
      '',
      '-- Name: demo."T"; Type: TABLE; Schema: demo; Owner: -',
      'CREATE TABLE demo."T" (id text NOT NULL, n int);',
      '',
      '-- Name: CONSTRAINT demo."T_pkey"; Type: CONSTRAINT; Schema: demo; Owner: -',
      'ALTER TABLE ONLY demo."T" ADD CONSTRAINT "T_pkey" PRIMARY KEY (id);',
      '',
      '-- Name: INDEX; Type: INDEX; Schema: demo; Owner: -',
      'CREATE UNIQUE INDEX "T_idx" ON demo."T" (n);',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'demo')
    expect(seg).toContain('CREATE TABLE demo."T"')
    expect(seg).toContain('ADD CONSTRAINT "T_pkey" PRIMARY KEY')
    expect(seg).toContain('CREATE UNIQUE INDEX "T_idx" ON demo."T"')
  })

  test('真实 pg_dump 段格式："Data for Name" + "Type: TABLE DATA" 段（含 COPY 数据）', () => {
    // 实测：pg_dump 14.23 输出中 COPY 数据段的锚点是 `-- Data for Name: ...; Type: TABLE DATA; Schema: ...; Owner: -`
    const sql = [
      'CREATE SCHEMA school_x;',
      '',
      '-- Name: school_x."Attachment"; Type: TABLE; Schema: school_x; Owner: -',
      'CREATE TABLE school_x."Attachment" (id text);',
      '',
      '-- Data for Name: Attachment; Type: TABLE DATA; Schema: school_x; Owner: -',
      'COPY school_x."Attachment" (id) FROM stdin;',
      'row1',
      'row2',
      '\\.',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'school_x')
    // 必须保留 COPY 块（这是修复的核心——COPY 数据不能丢失）
    expect(seg).toContain('COPY school_x."Attachment" (id) FROM stdin;')
    expect(seg).toContain('row1')
    expect(seg).toContain('row2')
    expect(seg).toMatch(/\\\.$/m)
    // 不应丢失 CREATE TABLE
    expect(seg).toContain('CREATE TABLE school_x."Attachment"')
  })

  test('Type 含空格/特殊名（FK CONSTRAINT / TABLE DATA）应被正确归类', () => {
    const sql = [
      'CREATE SCHEMA x;',
      '',
      '-- Name: CONSTRAINT x_pkey; Type: CONSTRAINT; Schema: x; Owner: -',
      'ALTER TABLE ONLY x."T" ADD CONSTRAINT "x_pkey" PRIMARY KEY (id);',
      '',
      '-- Name: CONSTRAINT x_fk; Type: FK CONSTRAINT; Schema: x; Owner: -',
      'ALTER TABLE ONLY x."T" ADD CONSTRAINT "x_fk" FOREIGN KEY (parent_id) REFERENCES x."P"(id);',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'x')
    expect(seg).toContain('PRIMARY KEY (id)')
    expect(seg).toContain('FOREIGN KEY (parent_id)')
  })

  test('pg_dump 多 schema CREATE SCHEMA 输出在同一行时，仍保留目标 schema 声明', () => {
    // PG 全库备份实测会把多个 CREATE SCHEMA 放在同一行，旧实现把整行当非目标丢弃，
    // 导致恢复时 schema "school_hqyz_restore" does not exist。
    const sql = [
      'SET statement_timeout = 0;',
      'SELECT pg_catalog.set_config(\'search_path\', \'\', false);',
      '',
      'CREATE SCHEMA public; CREATE SCHEMA school_hqyz; CREATE SCHEMA school_other;',
      '',
      '-- Name: school_hqyz."User"; Type: TABLE; Schema: school_hqyz; Owner: -',
      'CREATE TABLE school_hqyz."User" (id text);',
      'COPY school_hqyz."User" (id) FROM stdin;',
      'u1',
      '\\.',
    ].join('\n')
    const seg = extractSchemaSegment(sql, 'school_hqyz')
    expect(seg).toContain('CREATE SCHEMA school_hqyz;')
    expect(seg).not.toContain('CREATE SCHEMA public;')
    expect(seg).not.toContain('CREATE SCHEMA school_other;')
    expect(seg).toContain('CREATE TABLE school_hqyz."User"')
    expect(seg).toContain('COPY school_hqyz."User"')
  })
})
