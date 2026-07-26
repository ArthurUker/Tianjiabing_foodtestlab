/**
 * 预设主题（学校换肤系统）
 * ------------------------------------------------------------
 * 每套主题 = 极光壁纸（4 角渐变 + 洗染层 + 底色）+ 深色玻璃着色 + 强调色。
 * 与 css/tailwind.input.css 中的 :root CSS 变量一一对应，
 * 运行时通过 applyTheme() 覆盖变量即可整体换肤，玻璃质感不丢失。
 *
 * 存储约定：School.theme_color 保存 accent（向后兼容），
 * theme_config.theme 保存完整主题对象 { preset, accent, ... }。
 *
 * 该文件为经典脚本（非 module），通过 window.SchoolThemes 暴露，
 * 便于 admin-schools.html / index.html / login.html 及 iframe 预览共用。
 */
(function (global) {
  'use strict';

  var PRESETS = [
    {
      id: 'morning-mist',
      name: '晨雾',
      desc: '默认 · 清透蓝紫晨光',
      accent: '#1a73e8',
      accentStrong: '#1d4ed8',
      aurora: ['#a9c8ff', '#ffc2dd', '#a9ecd9', '#d9c6ff'],
      wash: ['#bcd4ff', '#ffd9b0', '#c9b6ff', '#a9ecd9'],
      base: '#eef2f8',
      dark: 'rgba(20, 28, 48, 0.42)',
      darkSolid: 'rgb(20, 28, 48)',
    },
    {
      id: 'sonoma-sky',
      name: '晴空',
      desc: '湛蓝天际 · 清爽通透',
      accent: '#0284c7',
      accentStrong: '#0369a1',
      aurora: ['#8ecdf7', '#c7e6ff', '#a5f3fc', '#93c5fd'],
      wash: ['#bae6fd', '#e0f2fe', '#a5d8ff', '#c4e0ff'],
      base: '#eaf4fb',
      dark: 'rgba(12, 42, 72, 0.44)',
      darkSolid: 'rgb(12, 42, 72)',
    },
    {
      id: 'sequoia-dusk',
      name: '红杉暮色',
      desc: '暖橙入夜 · 沉稳大气',
      accent: '#ea580c',
      accentStrong: '#c2410c',
      aurora: ['#ffc59e', '#ffb1c9', '#fcd9a8', '#d8b4fe'],
      wash: ['#ffd8b8', '#ffc2dd', '#e9c8ff', '#ffe3c2'],
      base: '#f8f0ea',
      dark: 'rgba(58, 30, 22, 0.46)',
      darkSolid: 'rgb(58, 30, 22)',
    },
    {
      id: 'emerald-vale',
      name: '翡翠谷',
      desc: '青山薄雾 · 自然生机',
      accent: '#059669',
      accentStrong: '#047857',
      aurora: ['#9ce8c8', '#d3f5c9', '#a7e8e0', '#c8f0d8'],
      wash: ['#b5ecd4', '#dff5c8', '#a9e8dc', '#c2f2d0'],
      base: '#ecf6f0',
      dark: 'rgba(10, 46, 38, 0.46)',
      darkSolid: 'rgb(10, 46, 38)',
    },
    {
      id: 'lavender-dream',
      name: '薰衣草',
      desc: '紫雾流光 · 优雅浪漫',
      accent: '#7c3aed',
      accentStrong: '#6d28d9',
      aurora: ['#cdb8ff', '#f3c6ff', '#b8c6ff', '#e6d3ff'],
      wash: ['#d8c6ff', '#f0d0ff', '#c4c8ff', '#e9d9ff'],
      base: '#f3f0fa',
      dark: 'rgba(40, 24, 70, 0.46)',
      darkSolid: 'rgb(40, 24, 70)',
    },
    {
      id: 'rose-quartz',
      name: '蔷薇石英',
      desc: '玫瑰粉金 · 柔和细腻',
      accent: '#e11d48',
      accentStrong: '#be123c',
      aurora: ['#ffb8c9', '#ffd9c2', '#fecdd8', '#f5c2e7'],
      wash: ['#ffc9d4', '#ffe0cc', '#fbd0e8', '#ffd4de'],
      base: '#faf0f1',
      dark: 'rgba(66, 20, 34, 0.46)',
      darkSolid: 'rgb(66, 20, 34)',
    },
    {
      id: 'glacier',
      name: '冰川',
      desc: '冷冽青蓝 · 纯净通透',
      accent: '#0891b2',
      accentStrong: '#0e7490',
      aurora: ['#a5f0f5', '#c9ecff', '#d4f7ee', '#b6e3ff'],
      wash: ['#bdeef2', '#d8f1ff', '#c8f5ea', '#cfe9ff'],
      base: '#edf6f8',
      dark: 'rgba(8, 46, 58, 0.44)',
      darkSolid: 'rgb(8, 46, 58)',
    },
    {
      id: 'golden-hour',
      name: '金色时刻',
      desc: '琥珀暖阳 · 温暖明亮',
      accent: '#d97706',
      accentStrong: '#b45309',
      aurora: ['#ffd9a0', '#ffe7b8', '#ffc9a3', '#f5e0a9'],
      wash: ['#ffe2b0', '#ffedc4', '#ffd6ad', '#fae8b8'],
      base: '#faf4e9',
      dark: 'rgba(64, 40, 10, 0.46)',
      darkSolid: 'rgb(64, 40, 10)',
    },
    {
      id: 'aurora-borealis',
      name: '极光',
      desc: '青绿紫交织 · 灵动梦幻',
      accent: '#0d9488',
      accentStrong: '#0f766e',
      aurora: ['#96e6d8', '#b0c8ff', '#c9b6ff', '#a9ecc4'],
      wash: ['#a9e8dc', '#c0d0ff', '#d5c2ff', '#b8f0d0'],
      base: '#edf5f4',
      dark: 'rgba(10, 40, 44, 0.46)',
      darkSolid: 'rgb(10, 40, 44)',
    },
    {
      id: 'sakura',
      name: '樱花',
      desc: '樱粉云霞 · 轻盈柔美',
      accent: '#ec4899',
      accentStrong: '#db2777',
      aurora: ['#ffc4dc', '#ffe0ea', '#fcd0f0', '#ffd9d0'],
      wash: ['#ffd2e4', '#ffe6ee', '#f8d8f4', '#ffe0d8'],
      base: '#fbf1f4',
      dark: 'rgba(70, 24, 46, 0.44)',
      darkSolid: 'rgb(70, 24, 46)',
    },
    {
      id: 'graphite',
      name: '石墨',
      desc: '中性灰阶 · 专业克制',
      accent: '#475569',
      accentStrong: '#334155',
      aurora: ['#c6d0de', '#dde3ec', '#cbd5e1', '#d8dee9'],
      wash: ['#cfd8e3', '#e2e8f0', '#c8d2de', '#dbe2ea'],
      base: '#eef1f5',
      dark: 'rgba(30, 38, 52, 0.50)',
      darkSolid: 'rgb(30, 38, 52)',
    },
    {
      id: 'midnight',
      name: '午夜',
      desc: '深海蓝黑 · 高级神秘',
      accent: '#3b82f6',
      accentStrong: '#2563eb',
      aurora: ['#5d7bb8', '#7a6fae', '#4c6a9e', '#6d84c0'],
      wash: ['#6b83b5', '#8577ad', '#57699c', '#7a8fc4'],
      base: '#c3cbdd',
      dark: 'rgba(10, 16, 34, 0.55)',
      darkSolid: 'rgb(10, 16, 34)',
    },
  ];

  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  /** hex(#rrggbb) -> rgba 字符串 */
  function hexToRgba(hex, alpha) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return null;
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  /** hex 调暗/调亮 percent（-100 ~ 100） */
  function shade(hex, percent) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return hex;
    function adj(x) {
      var v = parseInt(x, 16) + Math.round(255 * percent / 100);
      return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    }
    return '#' + adj(m[1]) + adj(m[2]) + adj(m[3]);
  }

  /**
   * 由任意 accent 颜色派生一套「自定义」主题（无预设时的兜底）：
   * 保留默认极光壁纸，仅将导航玻璃与强调色染成 accent。
   */
  function themeFromAccent(accent) {
    var def = PRESETS[0];
    return {
      preset: null,
      name: '自定义',
      accent: accent,
      accentStrong: shade(accent, -14),
      aurora: def.aurora,
      wash: def.wash,
      base: def.base,
      dark: hexToRgba(shade(accent, -55), 0.48) || def.dark,
      darkSolid: shade(accent, -55),
    };
  }

  /**
   * 从学校配置解析主题对象。
   * cfg 结构：{ themeColor, customization: { theme_config: '<json字符串>' } }
   * 优先 theme_config.theme.preset；其次完整 theme 对象；最后 themeColor 兜底。
   */
  function resolveTheme(cfg) {
    if (!cfg) return null;
    var theme = null;
    try {
      var cust = cfg.customization || {};
      var tc = cust.theme_config;
      if (typeof tc === 'string') tc = JSON.parse(tc);
      if (tc && tc.theme) theme = tc.theme;
    } catch (e) { /* 解析失败走兜底 */ }

    if (theme && theme.preset) {
      var p = getPreset(theme.preset);
      if (p) return p;
    }
    if (theme && theme.accent && theme.aurora) return theme;
    if (cfg.themeColor) return themeFromAccent(cfg.themeColor);
    return null;
  }

  /**
   * 把主题应用到目标 document（覆盖 :root CSS 变量）。
   * theme 为 null 时恢复默认（移除覆盖）。
   */
  function applyTheme(doc, theme) {
    var root = (doc || document).documentElement;
    var VARS = ['--aurora-1', '--aurora-2', '--aurora-3', '--aurora-4',
      '--aurora-w1', '--aurora-w2', '--aurora-w3', '--aurora-w4',
      '--aurora-base', '--glass-dark-bg', '--glass-dark-solid',
      '--accent', '--accent-strong'];
    if (!theme) {
      VARS.forEach(function (v) { root.style.removeProperty(v); });
      return;
    }
    var aurora = theme.aurora || [];
    var wash = theme.wash || aurora;
    root.style.setProperty('--aurora-1', aurora[0] || '#a9c8ff');
    root.style.setProperty('--aurora-2', aurora[1] || '#ffc2dd');
    root.style.setProperty('--aurora-3', aurora[2] || '#a9ecd9');
    root.style.setProperty('--aurora-4', aurora[3] || '#d9c6ff');
    root.style.setProperty('--aurora-w1', wash[0] || '#bcd4ff');
    root.style.setProperty('--aurora-w2', wash[1] || '#ffd9b0');
    root.style.setProperty('--aurora-w3', wash[2] || '#c9b6ff');
    root.style.setProperty('--aurora-w4', wash[3] || '#a9ecd9');
    root.style.setProperty('--aurora-base', theme.base || '#eef2f8');
    root.style.setProperty('--glass-dark-bg', theme.dark || 'rgba(20, 28, 48, 0.42)');
    root.style.setProperty('--glass-dark-solid', theme.darkSolid || 'rgb(20, 28, 48)');
    root.style.setProperty('--accent', theme.accent || '#1a73e8');
    root.style.setProperty('--accent-strong', theme.accentStrong || shade(theme.accent || '#1a73e8', -14));
  }

  /** 生成预设卡片缩略壁纸的 CSS background 值（与 body::before 同构） */
  function swatchBackground(theme) {
    var a = theme.aurora, w = theme.wash || theme.aurora;
    return 'linear-gradient(135deg, ' + a[0] + ' 0%, transparent 45%),' +
      'linear-gradient(225deg, ' + a[1] + ' 0%, transparent 48%),' +
      'linear-gradient(315deg, ' + a[2] + ' 0%, transparent 50%),' +
      'linear-gradient(45deg, ' + a[3] + ' 0%, transparent 48%),' +
      'linear-gradient(135deg, ' + w[0] + ', ' + w[1] + ', ' + w[2] + ', ' + w[3] + ')';
  }

  global.SchoolThemes = {
    PRESETS: PRESETS,
    getPreset: getPreset,
    resolveTheme: resolveTheme,
    applyTheme: applyTheme,
    themeFromAccent: themeFromAccent,
    swatchBackground: swatchBackground,
    hexToRgba: hexToRgba,
    shade: shade,
  };
})(typeof window !== 'undefined' ? window : globalThis);
