/* =====================================================================
 * store.js —— R2/R2.5 数据层：持久化 + SM-2 简化记忆引擎
 * 边界：只负责数据与调度，不做任何 DOM 渲染（渲染在 app.js）
 * 依赖：浏览器 localStorage（不可用时自动降级到内存，保证不白屏）
 * 命名空间统一 zsb:，便于一键清空做验收
 * ===================================================================== */
(function (global) {
  'use strict';

  var NS = 'zsb:';

  /* ---------- localStorage 安全封装（损坏/禁用时降级内存） ---------- */
  var mem = {};                       // 内存兜底
  var writeErrors = [];               // 写入失败记录（供页面提示用户）
  function rawGet(k) {
    try { return global.localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
  }
  function rawSet(k, v) {
    mem[k] = v;
    try {
      global.localStorage.setItem(k, v);
    } catch (e) {
      // 不再静默：记录失败，页面可读取并提示用户数据未落盘
      if (writeErrors.length < 200) writeErrors.push({ key: k, at: Date.now(), msg: String(e && e.message || e) });
    }
  }
  function storageWritable() {
    try {
      var probe = NS + '__wtest__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return writeErrors.length === 0;
    } catch (e) { return false; }
  }
  function read(key, def) {
    var s = rawGet(NS + key);
    if (s == null) return def;
    try {
      var v = JSON.parse(s);
      return (v === null || v === undefined) ? def : v;   // reset 写入 'null' 时回退默认值
    } catch (e) { return def; }
  }
  function write(key, val) { rawSet(NS + key, JSON.stringify(val)); return val; }

  /* ---------- 日期工具（本地时区，YYYY-MM-DD） ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return fmt(new Date()); }
  function parse(s) {
    var p = String(s).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  // b - a 的天数（按自然日，忽略时分秒）
  function diffDays(a, b) {
    return Math.round((parse(b) - parse(a)) / 86400000);
  }
  function addDays(s, n) {
    var d = parse(s); d.setDate(d.getDate() + n); return fmt(d);
  }
  function dateOffset(s, n) { return addDays(s, n); } // 语义别名

  /* ---------- 稳定题目 ID（题库无 id 字段） ---------- */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function qid(q) {
    return 'q' + hashStr((q.subject || '') + '|' + (q.stem || '')).toString(36);
  }
  function topicKey(q) { return (q.subject || '') + '|' + (q.topic || ''); }

  /* =====================================================================
   * Store —— 答题日志 / 错题本 / 打卡 / 统计
   * ===================================================================== */
  var Store = {};

  Store.qid = qid;
  Store.topicKey = topicKey;
  Store.today = today;

  /* ---------- 存储健康与导出（数据备份卡用） ---------- */
  Store.storageWritable = storageWritable;
  Store.getWriteErrors = function () { return writeErrors.slice(); };
  Store.clearWriteErrors = function () { writeErrors = []; };
  // 打包全部学习记录为一个可序列化的对象，含元数据
  Store.exportData = function () {
    return {
      app: '专升本每日修炼',
      version: 1,
      exportedAt: new Date().toISOString(),
      answers: Store.answers(),
      wrongs: Store.wrongs(),
      checkins: Store.checkins(),
      reviewLog: Store.reviewLog(),
      memory: Memory.all(),
      study: Study ? Study.all() : read('study', {}),
      pomo: Store.Pomo ? { records: Store.Pomo.records(), session: Store.Pomo.session(), anchor: read('pomo-anchor', '') } : null,
      seenTopics: read('seen', {}),
      examDate: Store.getExamDate() || EXAM_FALLBACK,
      plans: (function () {
        var out = {};
        for (var i = 0; i < (global.localStorage ? global.localStorage.length : 0); i++) {
          var k = global.localStorage.key(i);
          if (k && k.indexOf(NS + 'plan:') === 0) out[k.slice(NS.length)] = read(k.slice(NS.length), null);
        }
        return out;
      })()
    };
  };

  /*
   * 导入备份（R14）。mode: 'overwrite' 覆盖 / 'merge' 合并
   * 校验 app 标识，防导入错误文件；返回 { ok, msg, answers, wrongs }
   */
  Store.importData = function (data, mode) {
    mode = mode === 'merge' ? 'merge' : 'overwrite';
    if (!data || typeof data !== 'object') return { ok: false, msg: '文件内容无法解析' };
    if (data.app !== '专升本每日修炼') return { ok: false, msg: '这不是本站导出的备份文件' };
    if (mode === 'overwrite') {
      Store._saveAnswers(Array.isArray(data.answers) ? data.answers : []);
      Store._saveWrongs(data.wrongs && typeof data.wrongs === 'object' ? data.wrongs : {});
      write('checkins', data.checkins && typeof data.checkins === 'object' ? data.checkins : {});
      write('rlog', data.reviewLog && typeof data.reviewLog === 'object' ? data.reviewLog : {});
      Memory._save(data.memory && typeof data.memory === 'object' ? data.memory : {});
      write('study', data.study && typeof data.study === 'object' ? data.study : { doneWords: {}, doneTopics: {}, days: {} });
      if (data.pomo && typeof data.pomo === 'object') {
        write('pomo-records', Array.isArray(data.pomo.records) ? data.pomo.records : []);
        write('pomo-session', data.pomo.session || null);
        write('pomo-anchor', data.pomo.anchor || '');
      }
      write('seen', data.seenTopics || {});
      if (data.examDate) Store.setExamDate(String(data.examDate));
      if (data.plans && typeof data.plans === 'object') {
        Object.keys(data.plans).forEach(function (k) { write('plan:' + k, data.plans[k]); });
      }
    } else {
      // 合并：两边都不丢
      var seen = {};
      var merged = [];
      (Store.answers() || []).concat(Array.isArray(data.answers) ? data.answers : []).forEach(function (a) {
        if (!a || !a.qid) return;
        var key = a.qid + '|' + (a.ts || a.date || '');
        if (seen[key]) return;
        seen[key] = 1; merged.push(a);
      });
      merged.sort(function (x, y) { return (x.ts || 0) - (y.ts || 0); });
      Store._saveAnswers(merged);

      var wrong = Store.wrongs(), bw = data.wrongs || {};
      Object.keys(bw).forEach(function (k) {
        var cur = wrong[k], inc = bw[k];
        if (!cur) { wrong[k] = inc; return; }
        cur.wrongCount = Math.max(cur.wrongCount || 0, inc.wrongCount || 0);
        cur.correctStreak = Math.max(cur.correctStreak || 0, inc.correctStreak || 0);
        cur.mastered = !!(cur.mastered && inc.mastered);
        if ((inc.lastAt || '') > (cur.lastAt || '')) { cur.lastAt = inc.lastAt; }
        wrong[k] = cur;
      });
      Store._saveWrongs(wrong);

      var ck = Store.checkins(), bck = data.checkins || {};
      Object.keys(bck).forEach(function (k) { ck[k] = true; });
      write('checkins', ck);

      var rl = Store.reviewLog(), brl = data.reviewLog || {};
      Object.keys(brl).forEach(function (k) { rl[k] = Math.max(rl[k] || 0, brl[k]); });
      write('rlog', rl);

      var mem = Memory.all(), bmem = data.memory || {};
      Object.keys(bmem).forEach(function (k) {
        var cur = mem[k], inc = bmem[k];
        if (!cur) { mem[k] = inc; return; }
        mem[k] = (inc.interval || 0) > (cur.interval || 0) ? inc : cur;
      });
      Memory._save(mem);

      var st = Study ? Study.all() : { doneWords: {}, doneTopics: {}, days: {} }, bst = data.study || {};
      ['doneWords', 'doneTopics'].forEach(function (f) {
        st[f] = st[f] || {}; var b = bst[f] || {};
        Object.keys(b).forEach(function (k) { if (!st[f][k]) st[f][k] = b[k]; });
      });
      st.days = st.days || {}; var bd = bst.days || {};
      Object.keys(bd).forEach(function (k) {
        if (!st.days[k]) st.days[k] = bd[k];
        else if (typeof st.days[k] === 'object' && typeof bd[k] === 'object') {
          Object.keys(bd[k]).forEach(function (k2) { st.days[k][k2] = Math.max(st.days[k][k2] || 0, bd[k][k2]); });
        }
      });
      if (Study) Study._save(st);

      var pr = Store.Pomo ? Store.Pomo.records() : [], bpr = (data.pomo && data.pomo.records) || [];
      var pk = {};
      pr.forEach(function (r) { pk[(r.date || '') + '|' + (r.index != null ? r.index : r.slot) + '|' + (r.doneAt || r.ts || '')] = 1; });
      (Array.isArray(bpr) ? bpr : []).forEach(function (r) {
        var k = (r.date || '') + '|' + (r.index != null ? r.index : r.slot) + '|' + (r.doneAt || r.ts || '');
        if (!pk[k]) { pk[k] = 1; pr.push(r); }
      });
      if (Store.Pomo) Store.Pomo._setRecords(pr);

      var sn = read('seen', {}), bsn = data.seenTopics || {};
      Object.keys(bsn).forEach(function (k) { if (!sn[k]) sn[k] = bsn[k]; });
      write('seen', sn);
      if (!Store.getExamDate() && data.examDate) Store.setExamDate(String(data.examDate));
    }
    return {
      ok: true,
      msg: mode === 'merge' ? '合并完成' : '覆盖导入完成',
      answers: Array.isArray(data.answers) ? data.answers.length : 0,
      wrongs: data.wrongs ? Object.keys(data.wrongs).length : 0
    };
  };
  var EXAM_FALLBACK = '';

  Store.answers = function () { return read('log', []); };
  Store._saveAnswers = function (a) {
    if (!Array.isArray(a)) a = [];
    return write('log', a.slice(-2000));   // 防止无限膨胀
  };

  Store.wrongs = function () { return read('wrong', {}); };
  Store._saveWrongs = function (w) { return write('wrong', w || {}); };

  // R12 错因分类（跨科通用五类）
  Store.CAUSES = [
    { key: 'concept', label: '概念不清' },
    { key: 'calc',    label: '计算失误' },
    { key: 'read',    label: '审题偏差' },
    { key: 'memory',  label: '记不牢' },
    { key: 'guess',   label: '凭感觉' }
  ];
  Store.isWrong = function (q) { return !!Store.wrongs()[qid(q)]; };

  // 给错题标注/取消错因（同一题再点同码则取消）
  Store.setWrongCause = function (q, cause) {
    var w = Store.wrongs(), id = qid(q), e = w[id];
    if (!e) return null;
    var valid = Store.CAUSES.some(function (c) { return c.key === cause; });
    if (!valid) return null;
    e.cause = (e.cause === cause) ? '' : cause;
    e.causeAt = today();
    Store._saveWrongs(w);
    return e.cause;
  };
  // 按错因统计未掌握错题
  Store.causeStats = function () {
    var out = {}, unlabeled = 0;
    Store.CAUSES.forEach(function (c) { out[c.key] = 0; });
    Store.activeWrongs().forEach(function (e) {
      if (e.cause && out[e.cause] != null) out[e.cause]++;
      else unlabeled++;
    });
    out._unlabeled = unlabeled;
    return out;
  };

  /*
   * 记录一次答题。level 三档：2=记住(答对) / 1=模糊 / 0=忘了(答错)
   * 同时：写日志、更新错题本、驱动 SM-2 记忆档案。
   */
  Store.logAnswer = function (q, level) {
    level = (level === 2 || level === 1) ? level : 0;
    var id = qid(q), tk = topicKey(q), d = today();
    var log = Store.answers();
    log.push({ qid: id, subject: q.subject, topic: q.topic, level: level, correct: level === 2, date: d, ts: Date.now() });
    Store._saveAnswers(log);

    // 错题本：非"记住"则收录/累加；"记住"则累加连续答对，满 3 次移出（掌握）
    var wrong = Store.wrongs();
    if (level !== 2) {
      var e = wrong[id] || { qid: id, subject: q.subject, topic: q.topic, stem: q.stem, wrongCount: 0, correctStreak: 0, addedAt: d, mastered: false };
      e.wrongCount += (level === 0 ? 1 : 0);
      e.correctStreak = 0;
      e.mastered = false;
      e.lastAt = d;
      wrong[id] = e;
    } else if (wrong[id]) {
      wrong[id].correctStreak += 1;
      wrong[id].lastAt = d;
      if (wrong[id].correctStreak >= 3) {
        wrong[id].mastered = true;        // 保留一条"已掌握"记录，错题页可过滤
      }
    }
    Store._saveWrongs(wrong);

    // SM-2 档案更新（记忆引擎在下方 Memory 对象）
    Memory.touch(q, level);
    return { id: id, level: level, topicKey: tk };
  };

  Store.activeWrongs = function () {
    var w = Store.wrongs(), out = [];
    Object.keys(w).forEach(function (k) { if (!w[k].mastered) out.push(w[k]); });
    return out;
  };

  /* ---------- 当日计划快照（判定三组是否全部完成） ---------- */
  Store.setPlan = function (date, plan) { return write('plan:' + date, plan); };
  Store.getPlan = function (date) { return read('plan:' + date, null); };
  // 当日已答题目 qid 集合
  Store.answeredToday = function (d) {
    d = d || today();
    var set = {};
    Store.answers().forEach(function (a) { if (a.date === d) set[a.qid] = a.level; });
    return set;
  };

  Store.removeWrong = function (q) {
    var w = Store.wrongs(); delete w[qid(q)]; Store._saveWrongs(w);
  };
  Store.resetWrongs = function () { Store._saveWrongs({}); };

  /* ---------- 打卡 ---------- */
  Store.checkins = function () { return read('checkins', {}); };
  Store.isChecked = function (d) { return !!Store.checkins()[d || today()]; };
  Store.checkin = function (d) {
    d = d || today();
    var c = Store.checkins(), isNew = !c[d];
    if (isNew) { c[d] = true; write('checkins', c); }
    return isNew;
  };
  // 连续打卡天数：今天没打则从昨天起算（当天尚可补卡）
  Store.streak = function () {
    var c = Store.checkins(), d = today(), n = 0;
    if (!c[d]) d = dateOffset(d, -1);
    while (c[d]) { n++; d = dateOffset(d, -1); }
    return n;
  };
  Store.checkinDates = function () { return Object.keys(Store.checkins()).sort(); };

  /* ---------- 复习日志（记忆曲线数据） ---------- */
  Store.reviewLog = function () { return read('rlog', {}); };
  Store._bumpReview = function (d) {
    var r = Store.reviewLog(); r[d] = (r[d] || 0) + 1; write('rlog', r);
  };

  /* ---------- 统计 ---------- */
  Store.stats = function () {
    var log = Store.answers(), by = {}, total = 0, correct = 0;
    log.forEach(function (a) {
      var s = a.subject || 'other';
      if (!by[s]) by[s] = { done: 0, correct: 0 };
      by[s].done++; total++;
      if (a.correct) { by[s].correct++; correct++; }
    });
    Object.keys(by).forEach(function (s) {
      by[s].rate = by[s].done ? Math.round(by[s].correct / by[s].done * 100) : 0;
    });
    // 近 7 日练习量
    var days = [], base = today();
    for (var i = 6; i >= 0; i--) days.push(dateOffset(base, -i));
    var seven = days.map(function (d) {
      return { date: d, count: log.filter(function (a) { return a.date === d; }).length };
    });
    return {
      totalDone: total,
      totalCorrect: correct,
      rate: total ? Math.round(correct / total * 100) : 0,
      bySubject: by,
      wrongCount: Store.activeWrongs().length,
      sevenDays: seven,
      streak: Store.streak()
    };
  };

  /* =====================================================================
   * Study —— 每日背诵进度（单词 / 考点）
   * 记录：已标记"记住"的词 key、考点 key；每日完成标记
   * ===================================================================== */
  var Study = {};
  Study.all = function () { return read('study', { doneWords: {}, doneTopics: {}, days: {} }); };
  Study._save = function (s) { return write('study', s || { doneWords: {}, doneTopics: {}, days: {} }); };
  Study.markWord = function (key) {
    var s = Study.all(); s.doneWords = s.doneWords || {}; s.doneWords[key] = today(); Study._save(s);
  };
  Study.markTopic = function (key) {
    var s = Study.all(); s.doneTopics = s.doneTopics || {}; s.doneTopics[key] = today(); Study._save(s);
  };
  Study.isWordDone = function (key) { return !!(Study.all().doneWords || {})[key]; };
  Study.isTopicDone = function (key) { return !!(Study.all().doneTopics || {})[key]; };
  Study.setDayDone = function (d, ok) {
    var s = Study.all(); s.days = s.days || {}; s.days[d] = ok ? today() : null; Study._save(s);
  };
  Study.isDayDone = function (d) { return !!(Study.all().days || {})[d]; };
  Store.Study = Study;

  /* =====================================================================
   * Pomo —— R11 番茄钟（独立统计，不碰答题/进度口径）
   * 45 分钟专注 + 10 分钟休息；每天 3 个番茄：数学2+英语1，计算机隔天轮换。
   * 时间戳计时：切后台/锁屏继续，刷新恢复；完成记录以 sid 幂等去重。
   * ===================================================================== */
  var FOCUS_MS = 45 * 60 * 1000;
  var BREAK_MS = 10 * 60 * 1000;
  var FOCUS_MIN = 45;
  var SUB_NAME = { math: '数学', english: '英语', cs: '计算机' };

  var Pomo = {};
  Pomo.FOCUS_MS = FOCUS_MS;
  Pomo.BREAK_MS = BREAK_MS;
  Pomo.FOCUS_MIN = FOCUS_MIN;

  Pomo.records = function () { var r = read('pomo-records', []); return Array.isArray(r) ? r : []; };
  Pomo._setRecords = function (r) { return write('pomo-records', Array.isArray(r) ? r : []); };
  Pomo.session = function () { return read('pomo-session', null); };
  Pomo._setSession = function (s) { return write('pomo-session', s || null); };
  Pomo.anchor = function () {
    var a = read('pomo-anchor', '');
    if (!a) { a = today(); write('pomo-anchor', a); }
    return a;
  };
  Pomo.subjectName = function (k) { return SUB_NAME[k] || k || '专注'; };

  // 当日 3 个番茄的科目序列：计算机隔天轮换，无计算机日为数学2+英语1
  Pomo.slots = function (dateStr) {
    dateStr = dateStr || today();
    var idx = diffDays(Pomo.anchor(), dateStr);
    var hasCS = (((idx % 2) + 2) % 2) === 0;   // anchor 当天含计算机，之后隔天
    return hasCS ? ['math', 'english', 'cs'] : ['math', 'math', 'english'];
  };

  Pomo.start = function (subject, slot) {
    var now = Date.now();
    var s = {
      mode: 'focus', subject: subject || 'math', slot: slot || 0, date: today(),
      sid: 'p' + now + '_' + Math.floor(Math.random() * 10000),
      startAt: now, endAt: now + FOCUS_MS, paused: false, pausedLeft: 0
    };
    Pomo._setSession(s);
    return s;
  };
  Pomo.pause = function () {
    var s = Pomo.session(); if (!s || s.paused) return s;
    s.pausedLeft = Math.max(0, s.endAt - Date.now()); s.paused = true;
    Pomo._setSession(s); return s;
  };
  Pomo.resume = function () {
    var s = Pomo.session(); if (!s || !s.paused) return s;
    s.endAt = Date.now() + s.pausedLeft; s.paused = false;
    Pomo._setSession(s); return s;
  };
  Pomo.abandon = function () { Pomo._setSession(null); };
  Pomo.skipBreak = function () {
    var s = Pomo.session(); if (s && s.mode === 'break') Pomo._setSession(null);
  };

  // 时钟推进：返回 {event, remain, session, done}。完成专注写记录（sid 幂等）并转休息。
  Pomo.tick = function (now) {
    now = now || Date.now();
    var s = Pomo.session();
    if (!s) return null;
    if (s.paused) return { event: 'paused', remain: Math.max(0, s.pausedLeft), session: s };
    if (now < s.endAt) return { event: 'tick', remain: s.endAt - now, session: s };
    if (s.mode === 'focus') {
      var recs = Pomo.records();
      if (!recs.some(function (r) { return r.sid === s.sid; })) {
        recs.push({ sid: s.sid, date: s.date, subject: s.subject, slot: s.slot,
                    startAt: s.startAt, endedAt: now, dur: FOCUS_MIN });
        Pomo._setRecords(recs.slice(-1000));
      }
      var ns = { mode: 'break', subject: s.subject, slot: s.slot, date: s.date, sid: s.sid,
                 startAt: now, endAt: now + BREAK_MS, paused: false, pausedLeft: 0 };
      Pomo._setSession(ns);
      return { event: 'focus-done', remain: BREAK_MS, session: ns, done: s };
    }
    Pomo._setSession(null);
    return { event: 'break-done', remain: 0, session: null, done: s };
  };

  Pomo.countOn = function (d) {
    d = d || today();
    return Pomo.records().filter(function (r) { return r.date === d; }).length;
  };
  Pomo.stats = function () {
    var recs = Pomo.records(), td = today();
    var dayCount = recs.filter(function (r) { return r.date === td; }).length;
    var dt = parse(td), dow = dt.getDay() || 7, monday = dateOffset(td, -(dow - 1));
    var weekCount = recs.filter(function (r) { return r.date >= monday && r.date <= td; }).length;
    var by = {};
    recs.forEach(function (r) { var k = r.subject || 'math'; by[k] = (by[k] || 0) + 1; });
    return {
      today: dayCount, goal: 3,
      week: weekCount, total: recs.length,
      minutes: recs.length * FOCUS_MIN,
      hours: Math.round(recs.length * FOCUS_MIN / 6) / 10,
      bySubject: by, slots: Pomo.slots(td)
    };
  };
  Pomo.reset = function () {
    write('pomo-records', []);
    write('pomo-session', null);
    write('pomo-anchor', '');
  };
  Store.Pomo = Pomo;

  /* ---------- R3.7 今日已看讲解考点（晨读段进度用，按日期存） ---------- */
  Store.markSeenTopic = function (s, t) {
    var seen = read('seen', {}), d = today();
    var arr = seen[d] || [];
    var key = s + '|' + t;
    if (arr.indexOf(key) === -1) { arr.push(key); seen[d] = arr; write('seen', seen); }
  };
  Store.seenTopicsToday = function () {
    return read('seen', {})[today()] || [];
  };

  /* ---------- R6.3 考试日配置（用户可改，reset 不清） ---------- */
  Store.getExamDate = function () { return read('examdate', ''); };
  Store.setExamDate = function (s) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) { write('examdate', s); return true; }
    return false;
  };

  Store.reset = function () {
    write('log', []);
    write('wrong', {});
    write('checkins', {});
    write('rlog', {});
    write('memory', {});
    write('study', { doneWords: {}, doneTopics: {}, days: {} });
    write('seen', {});
    if (Store.Pomo) Store.Pomo.reset();
    // 清空所有 plan 快照键
    try {
      var keys = [];
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(NS + 'plan:') === 0) keys.push(k);
      }
      keys.forEach(function (k) { global.localStorage.removeItem(k); });
    } catch (e) {}
    mem = {};
    writeErrors = [];
  };

  /* =====================================================================
   * Memory —— SM-2 简化记忆引擎（方案 R2.5 逐条实现）
   * 档案键 = subject|topic；每条：上次复习日/interval/ease/streak/highRisk
   * ===================================================================== */
  var Memory = {};

  Memory.all = function () { return read('memory', {}); };
  Memory._save = function (m) { return write('memory', m || {}); };
  Memory.get = function (q) { return Memory.all()[topicKey(q)] || null; };

  function newCard(q) {
    return {
      id: topicKey(q), subject: q.subject, topic: q.topic,
      lastReview: today(), interval: 1, ease: 2.5,
      streak: 0, wrongCount: 0, highRisk: false, reps: 0
    };
  }

  /*
   * 调度核心（纯函数）：输入档案 + 档位(2记住/1模糊/0忘了) + 今天日期 → 新档案
   * 规则（方案原文）：
   *   答对 interval=min(interval×ease,30)，ease+0.05（封顶3.0），streak+1
   *   模糊 interval=interval×1.2（向上取整，至少1）
   *   答错 interval=1，streak清零，ease-0.2（下限1.3），wrongCount+1
   *   到期日 = 上次复习日 + interval
   */
  Memory.schedule = function (card, level, day) {
    day = day || today();
    var c = Object.assign({}, card);
    if (level === 2) {
      c.interval = Math.min(Math.max(1, Math.round(c.interval * c.ease)), 30);
      c.ease = Math.min(3.0, Math.round((c.ease + 0.05) * 100) / 100);
      c.streak = (c.streak || 0) + 1;
    } else if (level === 1) {
      c.interval = Math.max(1, Math.round(c.interval * 1.2));
      // 模糊：不重置连续答对，也不改变 ease
    } else {
      c.interval = 1;
      c.streak = 0;
      c.ease = Math.max(1.3, Math.round((c.ease - 0.2) * 100) / 100);
      c.wrongCount = (c.wrongCount || 0) + 1;
    }
    c.lastReview = day;
    c.reps = (c.reps || 0) + 1;
    // 高危：同一 topic 累计错 ≥2 次 → 标记；连对 3 次 → 移出
    if (c.wrongCount >= 2 && level === 0) c.highRisk = true;
    if (c.streak >= 3) { c.highRisk = false; c.wrongCount = 0; }
    c.due = dateOffset(day, c.interval);
    return c;
  };

  Memory.touch = function (q, level) {
    var all = Memory.all(), k = topicKey(q);
    var card = all[k] || newCard(q);
    all[k] = Memory.schedule(card, level, today());
    Memory._save(all);
    Store._bumpReview(today());
    return all[k];
  };

  // 到期判定：diffDays(lastReview, today) >= interval
  function isDue(card, day) {
    return diffDays(card.lastReview || day, day || today()) >= (card.interval || 1);
  }
  Memory.isDue = isDue;
  Memory.dueDate = function (card) { return dateOffset(card.lastReview, card.interval); };

  // 今日到期列表：interval 小的优先；一次最多 limit 条，高危考点优先插入
  Memory.due = function (limit) {
    limit = limit || 4;
    var day = today(), all = Memory.all(), arr = [];
    Object.keys(all).forEach(function (k) {
      var c = all[k];
      if (isDue(c, day)) arr.push(c);
    });
    arr.sort(function (a, b) {
      if (!!b.highRisk !== !!a.highRisk) return b.highRisk ? 1 : -1;  // 高危优先
      return (a.interval - b.interval) || (a.reps - b.reps);
    });
    return arr.slice(0, limit);
  };
  Memory.dueCount = function () {
    var day = today(), all = Memory.all(), n = 0;
    Object.keys(all).forEach(function (k) { if (isDue(all[k], day)) n++; });
    return n;
  };
  Memory.highRisk = function () {
    var all = Memory.all(), out = [];
    Object.keys(all).forEach(function (k) { if (all[k].highRisk) out.push(all[k]); });
    return out;
  };

  // 记忆曲线：近 days 天每天"实际复习数量"（含答题触发的复习）
  Memory.curve = function (days) {
    days = days || 30;
    var log = Store.reviewLog(), base = today(), out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = dateOffset(base, -i);
      out.push({ date: d, count: log[d] || 0 });
    }
    return out;
  };

  // 验收辅助：手工改动某档案上次复习日（制造"5天前"场景）
  Memory.setLastReview = function (q, date, interval) {
    var all = Memory.all(), k = topicKey(q);
    var c = all[k] || newCard(q);
    c.lastReview = date;
    if (typeof interval === 'number') c.interval = interval;
    c.due = dateOffset(date, c.interval || 1);
    all[k] = c; Memory._save(all);
    return c;
  };

  global.ZSB = global.ZSB || {};
  global.ZSB.Store = Store;
  global.ZSB.Memory = Memory;
  global.ZSB.date = { today: today, addDays: addDays, diffDays: diffDays, offset: dateOffset };
})(window);
