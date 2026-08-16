        (function () {
            // ===== FIX-03: 「返回登录」按校构建回链（保留原修复） =====
            var school = new URLSearchParams(window.location.search).get('school');
            var link = document.getElementById('backToLoginLink');
            if (link && school) {
                link.href = '/' + encodeURIComponent(school) + '/login.html?school=' + encodeURIComponent(school);
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

            // ===== 联系支持：温和占位（无后端支持接口前不做实际行为，留有未来 hook 点） =====
            var cs = document.getElementById('contactSupport');
            if (cs) {
                cs.addEventListener('click', function (e) {
                    e.preventDefault();
                    alert('请通过学校 IT 部门或超管联系平台技术支持。\n（系统暂未开放直接提交工单接口）');
                });
            }
        })();
