import { spawnSync } from 'node:child_process';
if (!process.env.COLLOIDAL_TEST_DATABASE_URL) throw new Error('集成测试必须显式设置COLLOIDAL_TEST_DATABASE_URL，禁止默认连接业务库');
if (process.argv.includes('--browser') && !process.env.COLLOIDAL_BROWSER_MODULE) throw new Error('浏览器端到端验证需要COLLOIDAL_BROWSER_MODULE及合成夹具');
const result = spawnSync(process.execPath, ['--test', 'backend/tests/colloidal/http.integration.test.mjs'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
