// js/utils/embed.js
//
// 洗涤剂残留识别（detergent-image-demo.html）被主系统以 iframe 嵌入时，
// 通过 postMessage 把识别结果回传给父页面。本模块提供两个小工具：
//   - isEmbedded():  是否处于 iframe 嵌入模式（URL 带 ?embed=1）
//   - postToParent(result, type): 把结果投递给父窗口
//
// 父页面（js/modules/Tableware.js）监听 'DETERGENT_RESULT' 消息。

/** 是否以嵌入模式运行（主系统 iframe 打开并带 ?embed=1） */
export function isEmbedded() {
  try {
    return new URLSearchParams(window.location.search).get('embed') === '1';
  } catch (_) {
    return false;
  }
}

/**
 * 把识别结果回传给父窗口。
 * @param {object} result  结果对象（如 { concentration, rawText }）
 * @param {string} [type]  消息类型，默认 'detergent'；内部统一包装为 DETERGENT_RESULT
 */
export function postToParent(result, type = 'detergent') {
  const payload = { type: 'DETERGENT_RESULT', source: type, ...result };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
      return true;
    }
  } catch (e) {
    console.warn('[embed] postToParent 失败', e);
  }
  try {
    sessionStorage.setItem('detergent_result', JSON.stringify(payload));
  } catch (_) { /* ignore */ }
  return false;
}
