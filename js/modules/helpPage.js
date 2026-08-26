        (function () {
            // ===== FIX-03: 「返回登录」按校构建回链（纯路径方案） =====
            // 路径优先：/<code>/help.html -> code（登录页 helpLink 现生成该形式，Caddy @schoolHelp rewrite 回根 /help.html）；
            // 查询兜底：兼容旧书签 /help.html?school=<code>。
            var _pathMatch = window.location.pathname.match(/^\/([a-z0-9-]+)\//);
            var school = _pathMatch ? _pathMatch[1] : new URLSearchParams(window.location.search).get('school');
            var link = document.getElementById('backToLoginLink');
            if (link && school) {
                link.href = '/' + encodeURIComponent(school) + '/login.html';
            }

            // ===== P-RedesignHelp: 章节点击平滑滚动 + 滚动同步激活 =====
            var navItems = document.querySelectorAll('.help-nav-item');
            var sections = ['account', 'system', 'test', 'contact'].map(function (id) {
                if (id === 'contact') return document.getElementById('helpContact');
                return document.getElementById('section-' + id);
            }).filter(Boolean);

            navItems.forEach(function (it) {
                it.addEventListener('click', function (e) {
                    e.preventDefault();
                    var targetId = it.getAttribute('href').slice(1);
                    var target = document.getElementById(targetId);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // 即时激活态（避免等滚动事件）
                    navItems.forEach(function (n) { n.classList.remove('active'); });
                    it.classList.add('active');
                });
            });

            // IntersectionObserver 同步激活态：哪个章节进入视口最高就激活哪一项
            var observer = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting && entry.intersectionRatio > 0.15) {
                        var key = entry.target.getAttribute('data-section');
                        navItems.forEach(function (n) {
                            n.classList.toggle('active', n.getAttribute('data-section') === key);
                        });
                    }
                });
            }, { threshold: [0.15, 0.4, 0.6], rootMargin: '-100px 0px -50% 0px' });
            sections.forEach(function (s) { if (s) observer.observe(s); });

            // ===== 实时搜索过滤 =====
            var searchEl = document.getElementById('helpSearch');
            var qEls = Array.from(document.querySelectorAll('.help-q'));
            var sectionEls = Array.from(document.querySelectorAll('.help-section'));
            var emptyEl = document.getElementById('helpEmpty');

            function normalize(s) { return (s || '').toLowerCase(); }

            function applyFilter(keyword) {
                var k = normalize(keyword.trim());
                var visibleSections = 0;
                sectionEls.forEach(function (sec) {
                    var qs = sec.querySelectorAll('.help-q');
                    var any = false;
                    qs.forEach(function (q) {
                        var match = k === '' || normalize(q.textContent).indexOf(k) !== -1;
                        q.style.display = match ? '' : 'none';
                        if (match) any = true;
                    });
                    sec.style.display = any ? '' : 'none';
                    if (any) visibleSections++;
                });
                // 空结果提示
                if (emptyEl) emptyEl.hidden = !(k && visibleSections === 0);
            }

            if (searchEl) {
                searchEl.addEventListener('input', function (e) { applyFilter(e.target.value); });
            }

            // ===== 联系我们弹窗 =====
            var modal = document.getElementById('contactModal');
            var modalTitle = document.getElementById('contactModalTitle');
            var modalBody = document.getElementById('contactModalBody');
            var modalClose = document.getElementById('contactModalClose');
            var modalOk = document.getElementById('contactModalOk');

            function openModal(title, html) {
                if (!modal || !modalTitle || !modalBody) return;
                modalTitle.textContent = title;
                modalBody.innerHTML = html;
                modal.classList.remove('hidden');
                modal.setAttribute('aria-hidden', 'false');
                if (modalOk) modalOk.focus();
            }
            function closeModal() {
                if (!modal) return;
                modal.classList.add('hidden');
                modal.setAttribute('aria-hidden', 'true');
            }
            if (modalClose) modalClose.addEventListener('click', closeModal);
            if (modalOk) modalOk.addEventListener('click', closeModal);
            if (modal) {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal || e.target.classList.contains('help-modal-overlay')) closeModal();
                });
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
                });
            }

            // 联系学校管理员
            var ca = document.getElementById('contactAdmin');
            if (ca) {
                ca.addEventListener('click', function (e) {
                    e.preventDefault();
                    var schoolName = school || '当前学校';
                    openModal('联系学校管理员', [
                        '<p>如需账号、权限、人员相关帮助，请联系所在学校的管理员。</p>',
                        '<div class="contact-label">适用问题</div>',
                        '<p class="contact-value">账号开通 / 密码重置 / 角色权限调整 / 学校人员变更等</p>',
                        '<div class="contact-label">联系方式</div>',
                        '<p class="contact-value">请通过贵校内部办公渠道联系相关负责人，或向学校信息管理部门咨询。</p>',
                        '<p class="text-xs text-gray-400 mt-2">当前学校代码：' + (school || '未识别') + '</p>'
                    ].join(''));
                });
            }

            // 联系平台技术支持
            var cs = document.getElementById('contactSupport');
            if (cs) {
                cs.addEventListener('click', function (e) {
                    e.preventDefault();
                    openModal('联系平台技术支持', [
                        '<p>如遇系统故障、数据异常、跨学校问题或其他技术问题，请联系平台技术支持团队。</p>',
                        '<div class="contact-label">邮箱</div>',
                        '<p class="contact-value">support@foodsentinel.example.com</p>',
                        '<div class="contact-label">服务时间</div>',
                        '<p class="contact-value">工作日 09:00 - 18:00</p>',
                        '<p class="text-xs text-gray-400 mt-2">如为紧急故障，请同步抄送学校管理员以加快处理。</p>'
                    ].join(''));
                });
            }

            // ===== viewer 账号自助申请（帮助页公开入口） =====
            (function () {
                var toggle = document.getElementById('viewerApplyToggle');
                var form = document.getElementById('viewerApplyForm');
                var cancel = document.getElementById('viewerApplyCancel');
                var msg = document.getElementById('viewerApplyMsg');
                if (!toggle || !form) return;

                var schoolInput = form.querySelector('[name="schoolCode"]');
                if (schoolInput) schoolInput.value = school || '';

                function showMsg(text, type) {
                    if (!msg) return;
                    msg.textContent = text;
                    msg.className = 'help-form-msg ' + type;
                    msg.classList.remove('hidden');
                }
                function hideMsg() { if (msg) msg.classList.add('hidden'); }

                toggle.addEventListener('click', function () {
                    form.classList.toggle('hidden');
                    hideMsg();
                    if (!form.classList.contains('hidden')) {
                        var first = form.querySelector('input:not([readonly])');
                        if (first) first.focus();
                    }
                });
                if (cancel) {
                    cancel.addEventListener('click', function () {
                        form.classList.add('hidden');
                        form.reset();
                        hideMsg();
                    });
                }

                form.addEventListener('submit', async function (e) {
                    e.preventDefault();
                    hideMsg();

                    var fd = new FormData(form);
                    var payload = {
                        username: String(fd.get('username') || '').trim(),
                        fullName: String(fd.get('fullName') || '').trim(),
                        password: String(fd.get('password') || ''),
                        passwordConfirm: String(fd.get('passwordConfirm') || ''),
                        phone: String(fd.get('phone') || '').trim(),
                        email: String(fd.get('email') || '').trim(),
                        schoolCode: String(fd.get('schoolCode') || '').trim()
                    };

                    if (!payload.schoolCode) {
                        showMsg('无法识别学校代码，请从学校的专属登录链接进入帮助页。', 'error');
                        return;
                    }
                    if (!payload.username || !payload.password || !payload.fullName || !payload.phone) {
                        showMsg('请填写所有必填项。', 'error');
                        return;
                    }
                    if (!/^[a-zA-Z0-9_]{3,32}$/.test(payload.username)) {
                        showMsg('用户名需为 3-32 位字母、数字或下划线。', 'error');
                        return;
                    }
                    if (payload.password.length < 8) {
                        showMsg('密码至少 8 位。', 'error');
                        return;
                    }
                    if (payload.password !== payload.passwordConfirm) {
                        showMsg('两次输入的密码不一致。', 'error');
                        return;
                    }
                    if (!/^1[3-9]\d{9}$/.test(payload.phone)) {
                        showMsg('手机号格式不正确。', 'error');
                        return;
                    }

                    var submitBtn = form.querySelector('button[type="submit"]');
                    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>提交中…'; }

                    try {
                        var res = await fetch('/api/user/application', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                username: payload.username,
                                password: payload.password,
                                email: payload.email || undefined,
                                fullName: payload.fullName,
                                phone: payload.phone,
                                schoolCode: payload.schoolCode
                            })
                        });
                        var data = await res.json().catch(function () { return {}; });
                        if (res.ok) {
                            showMsg('申请已提交，请等待学校管理员审批。', 'success');
                            form.reset();
                            if (schoolInput) schoolInput.value = school || '';
                        } else {
                            showMsg(data.error || '提交失败，请稍后重试。', 'error');
                        }
                    } catch (err) {
                        showMsg('网络异常，请检查网络后重试。', 'error');
                    } finally {
                        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>提交申请'; }
                    }
                });
            })();
        })();
