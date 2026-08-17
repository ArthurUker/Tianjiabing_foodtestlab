/**
 * appVersion.js —— 系统版本号唯一事实来源 + 版本说明弹窗
 *
 * 全站所有「系统版本」展示统一引用此常量，禁止在页面/模块中硬编码版本号，
 * 否则会出现「登录页 3.1.0 vs 系统 4.0」之类的版本漂移。
 * 与 package.json 的 "version" 字段保持一致；升级版本时只需修改此处 + package.json。
 *
 * 版本说明弹窗：
 *   所有带 data-app-version 的元素会：
 *     1) 文本被自动填充为 window.APP_VERSION；
 *     2) 被设为可点击（cursor:pointer + role=button + title 提示）；
 *     3) 点击后弹出「系统版本说明」弹窗（样式与系统玻璃态/白卡片弹窗保持一致）。
 *
 * 用法：
 *   1) HTML 页面 head 引入：<script src="/js/config/appVersion.js"></script>
 *   2) 展示位置写：<span data-app-version>3.1.0</span>
 *      —— 脚本在 DOM 就绪后自动填充 + 绑定点击弹窗。
 *         span 内静态值作为兜底：脚本未加载/未执行时也显示正确版本，不会空白。
 *   3) JS 模块/脚本直接读 window.APP_VERSION（如登录样式设计器的默认页脚文案）。
 */
(function () {
  'use strict';

  // ★ 系统版本号 —— 升级版本时同步修改 package.json 的 "version" 字段 ★
  var APP_VERSION = '3.1.0';

  window.APP_VERSION = APP_VERSION;

  // ===== 版本说明内容（按系统当前设计简要说明）=====
  // 文案保持简洁，聚焦「系统是什么 + 核心能力 + 当前版本」，避免过长。
  var VERSION_NOTES = {
    title: '食品安全检验管理系统',
    subtitle: '学校食品安全检测一体化管理平台',
    versionLabel: '当前版本',
    description: [
      '面向学校食品安全检测场景的一体化管理 Web 平台，覆盖五类检测（餐具洁净度、果蔬农残、食用油品质、肉蛋农残、病原体）的录入、统计与导出，并内置学校多租户管理、用户权限、审计日志、备份恢复与安全加固能力。'
    ],
    features: [
      { icon: 'fa-clipboard-check', text: '五类检测记录管理：录入、统计、导出、看板' },
      { icon: 'fa-school', text: '多学校租户隔离：平台超管统管，各校独立数据空间' },
      { icon: 'fa-user-shield', text: 'RBAC 权限体系：超管 / 管理者 / 检测员 / 只读 / 访客' },
      { icon: 'fa-history', text: '审计日志：全量高危操作留痕可追溯' },
      { icon: 'fa-database', text: '备份恢复：加密备份 + 完整性校验 + 影子恢复' },
      { icon: 'fa-file-signature', text: '界面定制：登录页主题 / 页脚 / 校徽按校个性化' }
    ],
    footer: '版本号由系统统一维护，全站一致展示。'
  };

  // 简单的 HTML 转义，防止注入（文案均为内部常量，仍做防御）
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 构建版本说明弹窗并挂到 body（惰性创建，首次点击时才生成）
  function showVersionDialog() {
    var existing = document.getElementById('appVersionDialog');
    if (existing) {
      existing.style.display = 'flex';
      return;
    }

    var featuresHtml = VERSION_NOTES.features.map(function (f) {
      return '<li style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">'
        + '<i class="fas ' + esc(f.icon) + '" style="width:18px;text-align:center;color:#4f46e5;margin-top:2px;flex-shrink:0;"></i>'
        + '<span style="font-size:13px;color:#374151;line-height:1.6;">' + esc(f.text) + '</span>'
        + '</li>';
    }).join('');

    var dialog = document.createElement('div');
    dialog.id = 'appVersionDialog';
    // 遮罩 + 弹窗：与系统既有弹窗风格一致（fixed inset-0 bg-black/40 + 白色圆角卡片）
    dialog.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;';
    dialog.innerHTML =
      '<div style="background:#ffffff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);'
      + 'width:100%;max-width:460px;max-height:86vh;overflow-y:auto;padding:24px;">'
      // 头部：图标 + 标题 + 关闭
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
      +   '<div style="display:flex;align-items:center;gap:12px;">'
      +     '<span style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);'
      +       'display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;flex-shrink:0;">'
      +       '<i class="fas fa-shield-alt"></i></span>'
      +     '<div>'
      +       '<h3 style="margin:0;font-size:17px;font-weight:700;color:#111827;line-height:1.3;">' + esc(VERSION_NOTES.title) + '</h3>'
      +       '<p style="margin:2px 0 0;font-size:12px;color:#6b7280;">' + esc(VERSION_NOTES.subtitle) + '</p>'
      +     '</div>'
      +   '</div>'
      +   '<button type="button" id="appVersionDialogClose" aria-label="关闭"'
      +     ' style="background:none;border:none;color:#9ca3af;font-size:20px;cursor:pointer;line-height:1;padding:4px;">'
      +     '<i class="fas fa-times"></i>'
      +   '</button>'
      + '</div>'
      // 当前版本徽章
      + '<div style="margin:16px 0 14px;display:flex;align-items:center;gap:8px;'
      +   'background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.18);border-radius:10px;padding:10px 12px;">'
      +   '<i class="fas fa-tag" style="color:#4f46e5;font-size:13px;"></i>'
      +   '<span style="font-size:13px;color:#4b5563;">' + esc(VERSION_NOTES.versionLabel) + '</span>'
      +   '<span style="font-weight:700;color:#4f46e5;font-size:14px;">' + esc(APP_VERSION) + '</span>'
      + '</div>'
      // 简介
      + '<p style="margin:0 0 14px;font-size:13px;color:#4b5563;line-height:1.8;">' + esc(VERSION_NOTES.description[0]) + '</p>'
      // 核心能力清单
      + '<div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:12px;padding:14px 16px;">'
      +   '<p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6b7280;letter-spacing:0.3px;">核心能力</p>'
      +   '<ul style="margin:0;padding:0;list-style:none;">' + featuresHtml + '</ul>'
      + '</div>'
      // 底部
      + '<p style="margin:14px 0 0;font-size:11px;color:#9ca3af;text-align:center;">' + esc(VERSION_NOTES.footer) + '</p>'
      + '</div>';

    document.body.appendChild(dialog);

    var close = function () { dialog.style.display = 'none'; };
    document.getElementById('appVersionDialogClose').addEventListener('click', close);
    // 点击遮罩关闭
    dialog.addEventListener('click', function (ev) { if (ev.target === dialog) close(); });
    // Esc 关闭
    var escKey = function (ev) {
      if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', escKey); }
    };
    document.addEventListener('keydown', escKey);
  }

  // 填充版本号 + 绑定点击弹窗
  function init() {
    var els = document.querySelectorAll('[data-app-version]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.textContent = APP_VERSION;
      // 设为可点击，提示用户可查看版本说明。
      // 视觉暗示：加一条弱下划线（适配深/浅背景），hover 时加深，让用户感知可点击。
      el.style.cursor = 'pointer';
      el.style.textDecoration = 'underline';
      el.style.textDecorationStyle = 'dotted';
      el.style.textDecorationColor = 'currentColor';
      el.style.textUnderlineOffset = '3px';
      el.style.transition = 'color .15s ease';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      if (!el.getAttribute('title')) {
        el.setAttribute('title', '点击查看系统版本说明');
      }
      // 复用同一弹窗，避免重复绑定
      el.addEventListener('click', showVersionDialog);
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showVersionDialog(); }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 兼容 Node/CommonJS 场景（如脚本内 require）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { APP_VERSION: APP_VERSION };
  }
})();
