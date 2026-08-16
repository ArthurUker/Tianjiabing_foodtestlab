    import { analyzeDetergentImage, drawOverlay, formatConcentrationList } from '/js/utils/detergentColorimetry.js';

    const concentrations = [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];

    // DOM
    const fileInput = document.getElementById('fileInput');
    const uploadZone = document.getElementById('uploadZone');
    const canvas = document.getElementById('canvas');
    const canvasWrap = document.getElementById('canvasWrap');
    const resultPanel = document.getElementById('resultPanel');
    const resultGrid = document.getElementById('resultGrid');
    const qcSection = document.getElementById('qcSection');
    const distanceTable = document.querySelector('#distanceTable tbody');
    const blocksTable = document.querySelector('#blocksTable tbody');
    const sampleInfo = document.getElementById('sampleInfo');
    const btnSample = document.getElementById('btnSample');
    const btnClear = document.getElementById('btnClear');
    const resultLegend = document.getElementById('resultLegend');

    let lastImg = null; // 上次图片（HTMLImageElement）
    let lastResult = null;
    let manualOverride = null; // FIX-17: 人工判定覆盖值（null=未覆盖，使用算法主判）

    // 嵌入模式（被主系统 iframe 打开时 ?embed=1）：隐藏独立页面元素、识别后显示"回填"按钮
    const isEmbed = new URLSearchParams(location.search).get('embed') === '1';
    if (isEmbed) {
      document.querySelector('header.hero').style.display = 'none';
      document.querySelector('.panel:nth-of-type(2)').style.display = 'none'; // 拍摄SOP隐藏（主系统点位表单里已有提示）
      document.querySelector('.panel:nth-of-type(3)').style.display = 'none'; // 图例
      const uploadZoneEl = document.getElementById('uploadZone');
      if (uploadZoneEl) uploadZoneEl.querySelector('p:nth-of-type(2)').textContent = '识别完成后点击下方「确认并回填」返回检测表单';
      const sampleBtn = document.getElementById('btnSample');
      if (sampleBtn) sampleBtn.style.display = 'none'; // 嵌入模式不展示合成测试图
    }

    // 页面打开自动跑一次合成测试图，省去冷启动步骤（嵌入模式跳过，等用户传图）
    window.addEventListener('DOMContentLoaded', () => {
      if (!isEmbed) setTimeout(() => btnSample.click(), 200);
    });

    // ============= 上传 =============
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) loadFile(f);
    });
    uploadZone.addEventListener('dragover', e => {
      e.preventDefault(); uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', e => {
      e.preventDefault(); uploadZone.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    function loadFile(f) {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => { lastImg = img; runOnce(); };
        img.onerror = () => alert('图片加载失败');
        img.src = ev.target.result;
      };
      reader.readAsDataURL(f);
    }

    btnClear.addEventListener('click', () => {
      lastImg = null; lastResult = null;
      canvas.style.display = 'none';
      canvasWrap.classList.add('placeholder');
      canvasWrap.innerHTML = '<i class="fas fa-image"></i>';
      resultPanel.style.display = 'none';
      resultLegend.style.display = 'none';
      btnClear.disabled = true;
    });

    // ============= 合成测试图 =============
    btnSample.addEventListener('click', () => {
      // 画一张"合格版"的合成图：水平 7 色块 + 右侧一根含 0.05 色液体的样品管
      const W = 800, H = 480;
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      const ctx = tmp.getContext('2d');

      // 背景：略偏黄的纸
      ctx.fillStyle = '#f5f1e3';
      ctx.fillRect(0, 0, W, H);

      // 比色卡矩形底
      const cardX = 80, cardY = 220, cardW = 560, cardH = 90;
      ctx.fillStyle = '#fdfdf8';
      ctx.fillRect(cardX - 8, cardY - 8, cardW + 16, cardH + 36);

      // 7 个色块
      const blockColors = [
        [220, 220, 210],   // 0
        [200, 220, 215],   // 0.01
        [180, 215, 200],   // 0.05
        [150, 200, 200],   // 0.1
        [85, 145, 200],    // 0.5
        [50, 110, 200],    // 1.0
        [30, 80, 180],     // 2.0
      ];
      const bW = cardW / 7;
      for (let i = 0; i < 7; i++) {
        const [r, g, b] = blockColors[i];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(cardX + i * bW, cardY, bW - 2, cardH);
        // 浓度数字
        ctx.fillStyle = '#475569';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(concentrations[i].toString(), cardX + i * bW + bW / 2, cardY + cardH + 22);
      }

      // 离心管（右侧上方）
      const tubeX = cardX + cardW + 40;
      const tubeY = cardY - 130;
      const tubeW = 38, tubeH = 180;
      // 管身
      ctx.fillStyle = 'rgba(220, 230, 235, 0.85)';
      ctx.beginPath();
      ctx.ellipse(tubeX + tubeW / 2, tubeY + tubeH, tubeW / 2, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(tubeX, tubeY, tubeW, tubeH);
      ctx.fillStyle = 'rgba(180, 195, 205, 0.95)';
      ctx.fillRect(tubeX, tubeY, tubeW, 18);
      // 液体（在 0.05 色附近）
      const liqY0 = tubeY + 30;
      const liqY1 = tubeY + tubeH - 10;
      ctx.fillStyle = 'rgb(180, 215, 200)';
      ctx.fillRect(tubeX + 4, liqY0, tubeW - 8, liqY1 - liqY0);
      // 圆头
      ctx.fillStyle = 'rgba(220, 230, 235, 0.85)';
      ctx.beginPath();
      ctx.ellipse(tubeX + tubeW / 2, tubeY, tubeW / 2, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      // 管壁高光
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tubeX + 6, tubeY + 8);
      ctx.lineTo(tubeX + 6, tubeY + tubeH - 6);
      ctx.stroke();

      // 转 Image 加载回调
      const dataURL = tmp.toDataURL('image/png');
      const img = new Image();
      img.onload = () => { lastImg = img; runOnce(); };
      img.src = dataURL;
    });

    // ============= 主流程 =============
    function runOnce() {
      if (!lastImg) return;
      btnClear.disabled = false;
      resultLegend.style.display = 'block';

      // 等比例放入 canvas
      const MAX_W = 1200;
      let w = lastImg.naturalWidth, h = lastImg.naturalHeight;
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
      canvas.width = w; canvas.height = h;
      canvasWrap.classList.remove('placeholder');
      canvasWrap.innerHTML = '';
      canvasWrap.appendChild(canvas);
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d');
      ctx.drawImage(lastImg, 0, 0, w, h);

      // 调用算法
      manualOverride = null; // FIX-17: 新一次识别重置人工覆盖
      const result = analyzeDetergentImage(canvas, { concentrations });
      lastResult = result;

      // 叠加绘制
      drawOverlay(canvas, result);

      // 渲染结果
      renderResult(result);
    }

    // FIX-17: 人工判定覆盖——算法识别不准时，允许操作员按肉眼判读手动选择比色级别。
    // 级别列表从算法色卡参考浓度动态生成，保证与算法内部级别完全一致。
    function renderManualOverride(result) {
      const section = document.getElementById('manualOverrideSection');
      if (!section) return;
      const levels = [...new Set((result.sortedDistances || []).map(d => Number(d.concentration)))].sort((a, b) => a - b);
      if (levels.length === 0) { section.style.display = 'none'; return; }
      const active = manualOverride != null ? manualOverride : result.mainValue;
      section.style.display = 'block';
      section.innerHTML = `
        <div class="label" style="font-size:12px;color:var(--c-muted);margin-bottom:6px;">
          <i class="fas fa-hand-pointer"></i> 人工判定覆盖（选择后以人工结果为准）：
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${levels.map(c => `<button type="button" class="manual-level-btn ${Number(active) === c ? 'active' : ''}" data-level="${c}">${c} mg/L</button>`).join('')}
          ${manualOverride != null ? '<button type="button" class="manual-level-btn reset" data-level="reset">↺ 还原算法结果</button>' : ''}
        </div>`;
      section.querySelectorAll('.manual-level-btn').forEach(btn => {
        btn.onclick = () => {
          const v = btn.dataset.level;
          manualOverride = (v === 'reset') ? null : Number(v);
          renderResult(result);
        };
      });
    }

    function renderResult(result) {
      resultPanel.style.display = 'block';

      if (!result.ok) {
        resultGrid.innerHTML = `
          <div class="result-card fail" style="grid-column: span 4;">
            <div class="label">识别失败 · 阶段 [${result.stage}]</div>
            <div class="value" style="font-size:14px;">${result.humanMessage}</div>
          </div>
        `;
        qcSection.innerHTML = result.hint
          ? `<div class="qc-note info"><i class="fas fa-info-circle"></i> 调试信息: ${result.hint}</div>` +
            (result.debug ? `<details><summary>详细调试数据</summary><pre style="font-size:11px;background:#f8fafc;padding:8px;border-radius:4px;overflow:auto;max-height:200px;">${JSON.stringify(result.debug, null, 2)}</pre></details>` : '')
          : '';
        distanceTable.innerHTML = `<tr><td colspan="3" style="color:var(--c-muted)">无（识别未成功）</td></tr>`;
        blocksTable.innerHTML = `<tr><td colspan="4" style="color:var(--c-muted)">无</td></tr>`;
        sampleInfo.innerHTML = `<p style="color:var(--c-muted);">无</p>`;
        return;
      }

      // 主判值（FIX-17: 支持人工覆盖，manualOverride 非 null 时以人工判定为准）
      const mainV = manualOverride != null ? manualOverride : result.mainValue;
      const mainValueText = manualOverride != null ? String(manualOverride) : result.mainValueText;
      const judgeClass = mainV === 0 ? 'pass'
        : mainV <= 0.05 ? 'pass'
        : mainV <= 0.1 ? 'warn'
        : 'fail';
      const judgeText = judgeClass === 'pass' ? '合格'
        : judgeClass === 'warn' ? '警戒' : '不合格';

      resultGrid.innerHTML = `
        <div class="result-card main">
          <div class="label">主判定${manualOverride != null ? '（人工覆盖）' : ''}</div>
          <div class="value">${mainValueText} mg/L</div>
        </div>
        <div class="result-card ${judgeClass}">
          <div class="label">判定等级</div>
          <div class="value" style="font-size:18px;">${judgeText}</div>
        </div>
        <div class="result-card">
          <div class="label">参考值（插值）</div>
          <div class="value">${result.refinedValue} mg/L</div>
        </div>
        <div class="result-card">
          <div class="label">置信度</div>
          <div class="value">${(result.confidence * 100) | 0}%</div>
        </div>
        <div class="result-card">
          <div class="label">ΔE（主判）</div>
          <div class="value">${result.deltaE}</div>
        </div>
        <div class="result-card">
          <div class="label">色卡 7 色块</div>
          <div class="value">已识别</div>
        </div>
        <div class="result-card">
          <div class="label">离心管方向</div>
          <div class="value" style="font-size:14px;">${result.tubeZone}</div>
        </div>
        <div class="result-card">
          <div class="label">样品 RGB</div>
          <div class="value" style="font-size:12px;">${result.sampleColor.map(v => v | 0).join(', ')}</div>
        </div>
      `;

      // 质控
      let qcHtml = '';
      if (result.qc.ok && result.qc.notes.length === 0) {
        qcHtml = `<div class="qc-note info"><i class="fas fa-check-circle"></i> 质控通过 · 亮度 ${result.qc.brightness}</div>`;
      } else {
        result.qc.notes.forEach(n => {
          const icon = n.level === 'error' ? 'fa-times-circle'
            : n.level === 'warn' ? 'fa-exclamation-triangle' : 'fa-info-circle';
          qcHtml += `<div class="qc-note ${n.level}"><i class="fas ${icon}"></i> ${n.text}</div>`;
        });
      }
      // FIX-17: 低置信度提示（置信度 < 60% 或算法疑似异常时建议人工复核）
      if ((result.confidence || 0) < 0.6 || result.anomalySuspected) {
        qcHtml += `<div class="qc-note warn"><i class="fas fa-exclamation-triangle"></i> 本次识别置信度较低，建议结合下方「人工判定覆盖」复核结果</div>`;
      }
      qcSection.innerHTML = qcHtml;

      // FIX-17: 渲染人工判定覆盖按钮组
      renderManualOverride(result);

      // 距离明细
      distanceTable.innerHTML = result.sortedDistances.map((d, i) => {
        const cls = i === 0 ? 'best' : '';
        return `<tr class="${cls}"><td>${d.concentration} mg/L</td><td>${d.deltaE}</td><td>#${i + 1}</td></tr>`;
      }).join('');

      // 色块颜色（推断色块无实测色，显示占位）
      blocksTable.innerHTML = result.blocks.map(b => {
        if (b.inferred || !b.color || !b.lab) {
          return `<tr><td>${b.blockIdx + 1}</td><td>${b.concentration} mg/L</td><td colspan="2" style="color:var(--c-muted);">推断位置（未取色）</td></tr>`;
        }
        const [R, G, Bl] = b.color.map(v => v | 0);
        const { L, a, b: bStar } = b.lab;
        return `<tr><td>${b.blockIdx + 1}</td><td>${b.concentration} mg/L</td><td>rgb(${R},${G},${Bl})</td><td>${L.toFixed(1)}, ${a.toFixed(1)}, ${bStar.toFixed(1)}</td></tr>`;
      }).join('');

      // 样品信息
      sampleInfo.innerHTML = `
        <p style="margin: 4px 0;">区域: ${result.tubeZone} · 像素: ${result.tube.w}×${result.tube.h}</p>
        <p style="margin: 4px 0;">实测 RGB: ${result.sampleColor.map(v => v | 0).join(', ')}</p>
        <p style="margin: 4px 0;">实测 Lab: L*${result.sampleLab.L.toFixed(1)}, a*${result.sampleLab.a.toFixed(1)}, b*${result.sampleLab.b.toFixed(1)}</p>
        <p style="margin: 4px 0;">插值可用: ${result.refinementAvailable ? '是' : '否'}</p>
      `;

      // 嵌入模式：显示"确认并回填"按钮，记录结果供回填
      const embedActions = document.getElementById('embedActions');
      if (isEmbed && embedActions) {
        embedActions.style.display = 'block';
        const btn = document.getElementById('btnConfirmResult');
        // 解除旧监听（每次渲染重建）
        btn.onclick = null;
        btn.onclick = () => {
          const payload = {
            type: 'DETERGENT_RESULT',
            value: mainV,
            valueText: mainValueText,
            judge: judgeText,
            deltaE: result.deltaE,
            confidence: result.confidence,
            refinedValue: result.refinedValue,
            manualOverride: manualOverride != null, // FIX-17: 标记是否人工覆盖
          };
          window.parent.postMessage(payload, '*');
          // 提示已发送
          btn.innerHTML = '<i class="fas fa-check"></i> 已回填，请回到原页面';
          btn.disabled = true;
          setTimeout(() => { if (btn && btn.parentElement) btn.parentElement.parentElement.style.display = 'none'; }, 800);
        };
      }
    }
