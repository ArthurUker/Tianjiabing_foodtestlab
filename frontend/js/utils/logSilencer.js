// ====== 生产环境日志降噪 + 跨域脚本错误抑制 ======
// 必须在 head 同步加载（早于 main.js 等 module defer 执行），避免调试日志在生产刷屏。
// 开启真实调试：URL 加 ?debug=true 或 localStorage.setItem('app_debug','true')。
// 抽离自 index.html 原 116-172 行内联 script（行为逐字保持一致）。
;(function () {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    var debugByQuery = new URLSearchParams(location.search).get('debug') === 'true';
    var debugByStorage = localStorage.getItem('app_debug') === 'true';
    var enableDebug = isLocal || debugByQuery || debugByStorage;
    if (enableDebug) return;

    var raw = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };

    console.log = function () { /* 生产降噪：静默 */ };
    console.info = function () { /* 生产降噪：静默 */ };
    console.debug = function () { /* 生产降噪：静默 */ };

    console.warn = function () {
        var text = String(arguments[0] || '');
        if (text.indexOf('cdn.tailwindcss.com should not be used in production') !== -1) return;
        raw.warn.apply(console, arguments);
    };

    console.error = function () {
        var text = String(arguments[0] || '');
        // 浏览器扩展自动填充在页面输入框注入时的噪音，不影响系统功能
        if (text.indexOf('Untrusted event') !== -1) return;
        raw.error.apply(console, arguments);
    };

    // 抑制跨域 CDN 脚本（Tailwind Play CDN 等）在受限渲染环境下的内部异常噪音。
    // 项目自身 JS 均为同源 ES module，不会产生 "Script error."；该类错误不影响功能。
    window.addEventListener('error', function (e) {
        var msg = String(e.message || '');
        var isCrossOriginScript = msg === 'Script error.' || (e.filename === '' && e.lineno === 0);
        // 项目代码无 getBoundingClientRect 调用，任何该错误必来自 CDN 内部
        var isNullBounding = msg.indexOf('getBoundingClientRect') !== -1 && !e.filename;
        if (isCrossOriginScript || isNullBounding) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);
})();
