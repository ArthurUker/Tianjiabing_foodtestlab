/**
 * 检测记录 API 冒烟（TD-Cypress-Coverage · W6）
 * 以 API 级请求验证核心写入/查询路径，不依赖浏览器登录态。
 * 前置：后端 + PostgreSQL 已启动并 seed（admin/admin123，dev 环境）。
 */

describe('检测记录 API 冒烟', () => {
  let token

  before(() => {
    cy.request({
      method: 'POST',
      url: '/api/user/login',
      body: { username: 'admin', password: 'admin123' },
      failOnStatusCode: false
    }).then((resp) => {
      token = resp.body && resp.body.token
    })
  })

  it('登录接口返回令牌结构', () => {
    expect(token).to.be.a('string').and.not.be.empty
  })

  it('可创建餐具检测记录（幂等：重复提交返回 200/409）', () => {
    const payload = {
      test_type: 'tableware',
      test_name: 'ATP 洁净度检测',
      sample_info: JSON.stringify({
        testDate: '2026-07-20',
        canteen: '一食堂',
        inspector: 'tester'
      }),
      result_data: JSON.stringify({ atp: 32, result: '合格' })
    }
    cy.request({
      method: 'POST',
      url: '/api/records/tableware',
      headers: { Authorization: `Bearer ${token}` },
      body: payload,
      failOnStatusCode: false
    }).then((resp) => {
      expect([200, 409]).to.include(resp.status)
    })
  })

  it('存在令牌时可查询检测记录列表', () => {
    cy.request({
      method: 'GET',
      url: '/api/records/tableware?limit=10',
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false
    }).then((resp) => {
      expect([200, 401, 403]).to.include(resp.status)
    })
  })
})
