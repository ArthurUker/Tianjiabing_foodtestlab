/**
 * 超管 · 内部操作指引（2026-10-28）
 *
 * 背景：现场复测指导原先是仓库里的静态 HTML，直接放 dist 会被公开访问。
 * 现改为**受鉴权接口**返回内容：页面只是一个壳，未登录超管拿不到正文。
 *
 * 挂载：/api/admin/guides（authenticateUser + requirePlatformSuperAdmin）
 * 内容来源：backend/assets/guides/*.html（**不在 dist**，无法通过静态站点直接下载）
 */
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = '[AdminGuides]'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.resolve(__dirname, '..', 'assets', 'guides')

/** 白名单：slug → 文件名（禁止路径穿越，只用固定映射） */
const GUIDES = {
  'pathogen-retest': 'pathogen-retest-guide.html',
}

export function createAdminGuideRoutes({ authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  /** 列出可用指引（供前端渲染入口，不返回正文） */
  router.get('/', (req, res) => {
    res.json({
      success: true,
      data: Object.keys(GUIDES).map((slug) => ({ slug, title: slug === 'pathogen-retest' ? '病原体设备上报 · 复测检查指导' : slug })),
    })
  })

  /** 取正文（HTML 字符串） */
  router.get('/:slug', async (req, res) => {
    const file = GUIDES[req.params.slug]
    if (!file) return res.status(404).json({ success: false, error: '指引不存在' })
    const full = path.join(ASSET_DIR, file)
    try {
      const [html, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
      res.json({ success: true, data: { slug: req.params.slug, html, updatedAt: stat.mtime.toISOString(), bytes: stat.size } })
    } catch (e) {
      console.error(`${TAG} 读取指引失败 ${full}:`, e.message)
      res.status(500).json({ success: false, error: '指引文件不可用' })
    }
  })

  return router
}
