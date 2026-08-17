/**
 * appVersion.js —— 系统版本号唯一事实来源
 *
 * 全站所有「系统版本」展示统一引用此常量，禁止在页面/模块中硬编码版本号，
 * 否则会出现「登录页 3.1.0 vs 系统 4.0」之类的版本漂移。
 * 与 package.json 的 "version" 字段保持一致；升级版本时只需修改此处 + package.json。
 *
 * 用法：
 *   1) HTML 页面 head 引入：<script src="/js/config/appVersion.js"></script>
 *   2) 展示位置写：<span data-app-version>3.1.0</span>
 *      —— 本脚本在 DOM 就绪后自动填充为 window.APP_VERSION。
 *         span 内静态值作为兜底：脚本未加载/未执行时也显示正确版本，不会空白。
 *   3) JS 模块/脚本直接读 window.APP_VERSION（如登录样式设计器的默认页脚文案）。
 */
(function () {
  'use strict';

  // ★ 系统版本号 —— 升级版本时同步修改 package.json 的 "version" 字段 ★
  var APP_VERSION = '3.1.0';

  window.APP_VERSION = APP_VERSION;

  function fill() {
    var els = document.querySelectorAll('[data-app-version]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = APP_VERSION;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fill);
  } else {
    fill();
  }

  // 兼容 Node/CommonJS 场景（如脚本内 require）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { APP_VERSION: APP_VERSION };
  }
})();
