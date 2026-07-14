# FIX P1-07：移除 window.router 冗余全局挂载

## 问题描述
Router.js 将 router 实例挂载到 window.router，任何页面脚本均可通过
全局变量直接操控路由实例，构成全局作用域污染风险。

## 根因分析
- window.router 被赋值 4 处（Router.js:16/438/471 + main.js:159）
- 但从未被读取调用（0 处方法调用）
- 所有调用方已通过 import { router } 获取同一单例
- 属于历史遗留调试代码，形成"双通道"暴露中的冗余通道

## 修复内容
删除 14 行（纯删除，零逻辑变更）：
- 4 处 window.router 赋值语句
- 4 处配套调试日志
- 3 处残留"暴露到全局作用域"注释
- 1 处空 if (typeof window !== 'undefined') {} 块（含其注释）

涉及文件：js/core/Router.js、js/main.js

## 功能影响
零影响。import 单例与 window 挂载指向同一对象，
调用方（main.js、UserManagement.js）通过 import 访问，无感知。

## 技术债登记
- TD-P2-10：main.js 中仍有 7 类其他 window.xxx 全局挂载
  （initAuditLog / loadDashboardData / renderQuickAccessData /
   initDashboard / handleNavigation / isQuickAccessModeOnInit /
   backupRendererScheduled/Executed），待 P2 阶段统一治理

## 提交信息
fix(P1-07): 移除 window.router 冗余全局挂载
哈希：7d14930
