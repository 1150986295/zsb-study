/* =====================================================================
 * EnterEngine —— 统一入场/退场动画引擎（R1 核心，方案逐字规格）
 * 规则：
 *   1. 只动画 opacity / transform，绝不碰 display/height/top/width
 *   2. 播一次即固化：ENTER_SEEN 幂等，元素回切不再重播
 *   3. 级联入场：同级 [data-enter] 递增 70ms 延迟
 *   4. 入场曲线：带回弹的 cubic-bezier
 *   5. 退场：约 200ms，退完再切
 *   6. 所有反馈动效（翻卡/答题/打卡）后续复用本引擎 animateOn()
 * ===================================================================== */
(function (global) {
  'use strict';

  var ENTER_DUR = 460;          // 入场时长
  var LEAVE_DUR = 200;          // 退场时长（方案 ~200ms）
  var STAGGER   = 70;           // 级联递增延迟（方案 60-80ms）
  var EASE_IN   = 'cubic-bezier(0.22, 1.25, 0.36, 1)';  // 回弹入场
  var EASE_OUT  = 'cubic-bezier(0.4, 0, 1, 1)';          // 退场

  // ENTER_SEEN：用 WeakSet 记录已入场元素（DOM 节点级幂等）
  var seen = new WeakSet();

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function EnterEngine() {
    this.screens = {};
    this.current = null;
    this.navSeq = 0;        // 导航代次令牌：只认最后一次切换
    this._leaveAnim = null; // 正在进行的退场动画句柄
  }

  /* 注册所有 section */
  EnterEngine.prototype.register = function (screenEls) {
    var self = this;
    screenEls.forEach(function (el) {
      self.screens[el.dataset.screen] = el;
      // display 只做瞬时显隐（非动画属性），符合规格
      el.style.display = 'none';
    });
  };

  /* 首次/任意时刻：对某个 screen 播放级联入场；已 seen 的元素跳过 */
  EnterEngine.prototype.enter = function (name, done) {
    var el = this.screens[name];
    if (!el) { done && done(); return; }
    var items = [].slice.call(el.querySelectorAll('[data-enter]'));
    if (reducedMotion() || items.length === 0) {
      items.forEach(function (n) { n.style.opacity = 1; n.style.transform = 'none'; });
      done && done();
      return;
    }
    var pending = 0;
    var self = this;
    items.forEach(function (node, i) {
      if (seen.has(node)) {                 // 幂等：已播过，直接固化
        node.style.opacity = 1;
        node.style.transform = 'none';
        return;
      }
      pending++;
      var a = node.animate([
        { opacity: 0, transform: 'translateY(16px) scale(0.985)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' }
      ], {
        duration: ENTER_DUR,
        delay: i * STAGGER,
        easing: EASE_IN,
        fill: 'both'
      });
      a.onfinish = function () {
        node.style.opacity = 1;
        node.style.transform = 'none';
        a.cancel();                         // 清掉动画对象，getAnimations() 归零
        seen.add(node);                     // 打标，回切不再播
        if (--pending === 0) { done && done(); }
      };
    });
    if (pending === 0) { done && done(); }
  };

  /* 退场：约200ms，只动 opacity/transform；返回动画句柄，结束清对象 */
  EnterEngine.prototype.leave = function (name, done) {
    var el = this.screens[name];
    if (!el || reducedMotion()) { done && done(); return null; }
    var a = el.animate([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-10px)' }
    ], { duration: LEAVE_DUR, easing: EASE_OUT, fill: 'both' });
    a.onfinish = function () { a.cancel(); done && done(); };
    return a;
  };

  /* 切换：退场 -> 显隐 -> 入场。
     用 navSeq 代次令牌代替阻塞锁：连点时不吞请求，只认最后一次目标，
     入场不阻塞下一次切换，避免"等 1 秒才能再点"的卡顿。 */
  EnterEngine.prototype.go = function (name) {
    if (name === this.current || !this.screens[name]) { return; }
    var self = this;
    var seq = ++this.navSeq;                 // 递增代次
    var prev = this.current;

    // 取消上一次尚未完成的退场动画，防止旧回调把页面切回去
    if (this._leaveAnim) {
      try { this._leaveAnim.onfinish = null; this._leaveAnim.cancel(); } catch (e) {}
      this._leaveAnim = null;
    }

    var showAndEnter = function () {
      if (seq !== self.navSeq) { return; }   // 已被更新的导航取代，丢弃
      if (prev) { self.screens[prev].style.display = 'none'; }
      var next = self.screens[name];
      next.style.display = 'block';
      next.style.opacity = 1;
      next.style.transform = 'none';
      self.current = name;
      self.enter(name);                       // 入场不阻塞下次切换
    };

    if (prev) {
      // 复位 prev 可能的残留态，保证退场从干净状态起
      this.screens[prev].style.opacity = 1;
      this.screens[prev].style.transform = 'none';
      this._leaveAnim = this.leave(prev, showAndEnter);
    } else {
      showAndEnter();
    }
  };

  /* 首屏：无退场，直接入场 */
  EnterEngine.prototype.boot = function (name) {
    var self = this;
    var el = this.screens[name];
    if (!el) { return; }
    el.style.display = 'block';
    self.current = name;
    self.enter(name);
  };

  /* 通用反馈动效接口：供 R2/R3 的答题/翻卡/打卡复用，仍只 opacity/transform */
  EnterEngine.prototype.animateOn = function (node, keyframes, opts) {
    if (!node || reducedMotion()) { return null; }
    var a = node.animate(keyframes, Object.assign({ duration: 320, easing: EASE_IN }, opts || {}));
    a.onfinish = function () { a.cancel(); };
    return a;
  };

  global.EnterEngine = EnterEngine;
  global.__ENTER_SEEN__ = seen;   // 供自检脚本读取（调试用）
})(window);
