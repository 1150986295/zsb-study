/* =====================================================================
 * app.js —— R2/R2.5 应用层：今日计划引擎 + 答题闭环 + 记忆引擎接入
 * 边界：只做渲染与交互；动画一律走 engine.animateOn（不动 R1 引擎结构）
 * 今日计划以日期字符串为种子；记忆档案只影响晨读位/错题位，套题10道不变
 * ===================================================================== */
(function () {
  'use strict';

  var EXAM_DATE_DEFAULT = '2027-04-17';   // 占位默认值（可在"我的"页改）
  function examDate() { return Store.getExamDate() || EXAM_DATE_DEFAULT; }
  var QBANK = [];
  var QM = {};                     // qid -> 题目
  var WORDS = [];                  // 词库
  var TOPICS = {};                 // 考点讲解：'subject|topic' -> {def,points,trap}
  var Study = window.ZSB.Store.Study;
  var Store = window.ZSB.Store, Memory = window.ZSB.Memory, D = window.ZSB.date;
  var engine = null;

  var SUBJ_CN = { english: '英语', math: '数学', cs: '计算机' };
  var SUBJECTS = ['english', 'math', 'cs'];
  var focusTopic = null;   // R3：从晨读/知识卡跳转时聚焦的考点 {s,t}
  var focusFlip = false;   // R3.5：看讲解进入时，聚焦卡是否直接翻到讲解面
  var knowPrioOnly = false; // R6.1：知识页只看重点考点开关

  /* ---------- 确定性随机 ---------- */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function todayStr() { return D.today(); }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* R6.1 重点考点徽章：core 核心高频 / high 常考 / normal 不显示。
     依据来自 topics.json 的 priority（真题数+四川考纲核心模块+关联题量三因子）。 */
  function prioBadge(sub, topic, compact) {
    var t = TOPICS[sub + '|' + topic];
    if (!t || !t.priority || t.priority === 'normal') return '';
    var isCore = t.priority === 'core';
    var cls = isCore ? 'prio-core' : 'prio-high';
    var txt = isCore ? '★ 核心高频' : '☆ 常考';
    if (compact) txt = isCore ? '★高频' : '☆常考';
    var tip = esc(t.prioReason || '');
    return '<span class="prio-badge ' + cls + '" title="' + tip + '">' + txt + '</span>';
  }
  /* R3.8 LaTeX→Unicode 轻量降级：KaTeX 加载失败/未包裹时保证不出现裸 \frac \partial $ */
  function latexFallback(node) {
    if (!node) return;
    var walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
    var texts = [], t;
    while ((t = walk.nextNode())) texts.push(t);
    texts.forEach(function (tn) {
      var s = tn.nodeValue;
      if (!s || s.indexOf('$') === -1 && s.indexOf('\\') === -1) return;
      // 去掉 $ 定界符
      s = s.replace(/\$\$/g, '').replace(/\$/g, '');
      s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
           .replace(/\\dfrac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
           .replace(/\\partial/g, '∂').replace(/\\int/g, '∫')
           .replace(/\\ln/g, 'ln').replace(/\\lim/g, 'lim')
           .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
           .replace(/\\sum/g, '∑').replace(/\\infty/g, '∞')
           .replace(/\\times/g, '×').replace(/\\cdot/g, '·')
           .replace(/\\le/g, '≤').replace(/\\ge/g, '≥')
           .replace(/\\neq/g, '≠').replace(/\\to/g, '→')
           .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β')
           .replace(/\\pi/g, 'π').replace(/\\theta/g, 'θ')
           .replace(/\\Delta/g, 'Δ').replace(/\\left/g, '').replace(/\\right/g, '')
           .replace(/\^\{([^{}]+)\}/g, '^$1')
           .replace(/_\{([^{}]+)\}/g, '_$1')
           .replace(/\\[a-zA-Z]+/g, '');
      tn.nodeValue = s;
    });
  }
  function mathRender(node) {
    if (!node) return;
    if (!window.katex || !window.renderMathInElement) { latexFallback(node); return; }
    try {
      window.renderMathInElement(node, {
        delimiters: [{ left: '$', right: '$', display: false }],
        throwOnError: false, ignoredTags: ['script', 'noscript', 'style']
      });
      // R3.8：只清理仍在 .katex 之外的裸定界符文本节点，避免误伤已渲染公式
      var stray = [];
      var w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false), n;
      while ((n = w.nextNode())) {
        if (n.parentElement && n.parentElement.closest('.katex')) continue;
        if (/\$|\\frac|\\partial|\\sqrt|\\int|\\ln|\\lim/.test(n.nodeValue)) stray.push(n);
      }
      stray.forEach(function (tn) {
        var s = tn.nodeValue;
        // 仍含 LaTeX 命令串 → 走完整兜底转 Unicode；只含 $ → 去掉定界符
        if (/\\frac|\\partial|\\sqrt|\\int|\\ln|\\lim|\\\\/.test(s)) {
          tn.nodeValue = s.replace(/\$\$/g, '').replace(/\$/g, '')
            .replace(/\\dfrac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
            .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
            .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
            .replace(/\\partial/g, '∂').replace(/\\int/g, '∫')
            .replace(/\\ln/g, 'ln').replace(/\\lim/g, 'lim')
            .replace(/\\times/g, '×').replace(/\\cdot/g, '·')
            .replace(/\\le/g, '≤').replace(/\\ge/g, '≥').replace(/\\neq/g, '≠')
            .replace(/\\to/g, '→').replace(/\\pi/g, 'π').replace(/\\infty/g, '∞')
            .replace(/\\left/g, '').replace(/\\right/g, '')
            .replace(/\\([a-zA-Z]+)/g, '');
        } else {
          tn.nodeValue = s.replace(/\$\$/g, '').replace(/\$/g, '');
        }
      });
    } catch (e) { latexFallback(node); }
  }
  // 可客观判定的题型
  function isJudgeable(q) { return q.type === 'choice' || q.type === 'judge' || q.type === 'multi_choice' || q.type === 'blank'; }
  function answerOf(q) { return String(q.answer == null ? '' : q.answer).trim(); }
  function normAns(s) {
    return String(s == null ? '' : s)
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\s+/g, '')
      .replace(/^[（(]|[）)]$/g, '')
      .replace(/[.,;。；，]$/, '')
      .toLowerCase();
  }
  function judge(q, picked) {
    var a = answerOf(q);
    if (q.type === 'multi_choice') {
      var p = [].slice.call(picked).sort().join('');
      var k = a.replace(/[^A-Da-d]/g, '').toUpperCase().split('').sort().join('');
      return p === k;
    }
    return normAns(picked) === normAns(a);
  }
  function qid(q) { return Store.qid(q); }

  /* ---------- 题库 / 词库 / 考点讲解 加载 ---------- */
  function loadBank(cb) {
    Promise.all([
      fetch('data/questions.json?v=202611242333').then(function (r) { if (!r.ok) throw new Error('questions HTTP ' + r.status); return r.json(); }),
      fetch('data/words.json?v=202611242333').then(function (r) { if (!r.ok) throw new Error('words HTTP ' + r.status); return r.json(); }),
      fetch('data/topics.json?v=202611242333').then(function (r) { if (!r.ok) throw new Error('topics HTTP ' + r.status); return r.json(); })
    ]).then(function (arr) {
      QBANK = arr[0]; WORDS = arr[1] || []; TOPICS = arr[2] || {};
      QBANK.forEach(function (q) { QM[qid(q)] = q; });
      buildTopicList();
      cb(null);
    }).catch(function (e) { cb(e); });
  }

  /* =====================================================================
   * R6.2 自适应强度（Duolingo Birdbrain/IRT 思路，日级、确定性）
   * - 只看"截至昨天"的历史正确率，当天答题不污染当天计划 → 同日刷新一致
   * - 近3日正确率 ≥85% 加练×1.2；<60% 减负×0.8（并让错题回顾多留位）
   * - 每周日固定弹性日 ×0.7（放松度，防疲劳）
   * - 强度只调题量，不改随机种子（题目选取逻辑不变）
   * ===================================================================== */
  var PLAN_BASE = { morning: 4, support: 12, mix: 22, review: 4 };
  function intensityFor(dateStr) {
    var log = Store.answers();
    // 近3日（不含当天）答题正确率
    var d0 = new Date(dateStr);
    function dsBack(n) {
      var x = new Date(d0); x.setDate(x.getDate() - n);
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    }
    var validDates = { }; for (var k = 1; k <= 3; k++) validDates[dsBack(k)] = 1;
    var recent = log.filter(function (a) { return validDates[a.date]; });
    var rate = null;
    if (recent.length >= 5) {
      var c = recent.filter(function (a) { return a.correct; }).length;
      rate = Math.round(c / recent.length * 100);
    }
    var isRest = d0.getDay() === 0;   // 周日弹性日
    if (isRest) {
      return { level: 'rest', factor: 0.7, label: '弹性日',
               reason: '周日放松日 · 减量30%，保持手感即可', rate: rate, isRest: true };
    }
    if (rate === null) {
      return { level: 'standard', factor: 1, label: '标准',
               reason: '数据积累中 · 按标准强度', rate: rate, isRest: false };
    }
    if (rate >= 85) {
      return { level: 'boost', factor: 1.2, label: '加练',
               reason: '近3日正确率 ' + rate + '% · 适度加量', rate: rate, isRest: false };
    }
    if (rate < 60) {
      return { level: 'ease', factor: 0.8, label: '减负',
               reason: '近3日正确率 ' + rate + '% · 减量并强化错题', rate: rate, isRest: false };
    }
    return { level: 'standard', factor: 1, label: '标准',
             reason: '近3日正确率 ' + rate + '% · 保持节奏', rate: rate, isRest: false };
  }
  function scaled(n, factor, min) { return Math.max(min == null ? 1 : min, Math.round(n * factor)); }

  /* =====================================================================
   * 今日计划引擎：同源分流，套题10道用独立种子，记忆档案变化不影响它
   * ===================================================================== */
  function buildPlan(dateStr) {
    var INTEN = intensityFor(dateStr);
    var N_MIX = scaled(PLAN_BASE.mix, INTEN.factor, 8);
    var N_SUP = scaled(PLAN_BASE.support, INTEN.factor, 6);
    var N_MORN = scaled(PLAN_BASE.morning, INTEN.factor, 2);
    var N_REV = scaled(PLAN_BASE.review, INTEN.factor, 2);
    // R14：练习池 = 全量题库。解答题/翻译题走"看答案自评"链路（questionHTML 已支持），
    // 自评 level 0/1 自动进错题本与 SM-2 复习队列，数学主体不再被排除
    var practiceable = QBANK.slice();
    var seed = hashStr(dateStr);

    // 03 混合套题：独立种子流，三科搭配（记忆档案不参与）
    var mixRng = mulberry32(hashStr(dateStr + '|mix'));
    var mix = [];
    SUBJECTS.forEach(function (s) {
      var pool = practiceable.filter(function (q) { return q.subject === s; });
      mix = mix.concat(shuffle(pool, mixRng).slice(0, Math.ceil(N_MIX / 3) + 1));
    });
    mix = shuffle(mix, mulberry32(hashStr(dateStr + '|mix2'))).slice(0, N_MIX);
    if (mix.length < N_MIX) {
      mix = mix.concat(shuffle(practiceable.filter(function (q) { return mix.indexOf(q) === -1; }), mixRng).slice(0, N_MIX - mix.length));
    }

    // 01 晨读知识点：到期记忆档案 + 高危考点优先（最多4条，R2.5），不足2条用三科轮换确定性补齐
    var due = Memory.due(4).filter(function (c) { return c.topic; });
    var highRiskCards = Memory.highRisk().filter(function (c) {
      return c.topic && !due.some(function (d) { return d.id === c.id; });   // 未到期的也纳入（高危需重点复习）
    });
    var morningSrc = due.concat(highRiskCards).slice(0, 4);
    var morning = morningSrc.map(function (c) {
      return { s: c.subject, t: c.topic, due: c.due ? true : false, highRisk: c.highRisk, interval: c.interval };
    });
    if (morning.length < N_MORN) {
      var mRng = mulberry32(hashStr(dateStr + '|morning'));
      var topics = [];
      QBANK.forEach(function (q) {
        if (!topics.some(function (x) { return x.s === q.subject && x.t === q.topic; })) {
          topics.push({ s: q.subject, t: q.topic, due: false });
        }
      });
      // 三科轮换：保证补充进来的尽量覆盖不同科目
      var extra = shuffle(topics, mRng).filter(function (x) {
        return !morning.some(function (m) { return m.s === x.s && m.t === x.t; });
      }).slice(0, N_MORN - morning.length);
      morning = morning.concat(extra);
    }
    morning = morning.slice(0, N_MORN);

    // 02 配套练习：围绕晨读考点各取3道，共12（独立种子）；全量池可抽到解答题自评
    var sRng = mulberry32(hashStr(dateStr + '|support'));
    var support = [];
    morning.forEach(function (m) {
      var pool = practiceable.filter(function (q) { return q.subject === m.s && q.topic === m.t; });
      support = support.concat(shuffle(pool, sRng).slice(0, 3));
    });
    if (support.length < N_SUP) {
      support = support.concat(shuffle(practiceable.filter(function (q) { return support.indexOf(q) === -1; }), sRng).slice(0, N_SUP - support.length));
    }
    support = support.slice(0, N_SUP);

    // 04 错题回顾：按遗忘曲线（SM-2 记忆档案）到期优先，最多4道
    //    到期错题先推；高危优先；逾期越久越靠前；不足4道时用未到期错题按最近做错时间兜底
    var active = Store.activeWrongs();
    function wrongCard(w) { var q = QM[w.qid]; return q ? Memory.get(q) : null; }
    var dueWrongs = [], pendingWrongs = [];
    active.forEach(function (w) {
      var c = wrongCard(w);
      if (c && Memory.isDue(c, dateStr)) dueWrongs.push({ w: w, c: c });
      else pendingWrongs.push(w);
    });
    dueWrongs.sort(function (a, b) {
      if (!!b.c.highRisk !== !!a.c.highRisk) return b.c.highRisk ? 1 : -1;   // 高危优先
      return String(a.c.due || a.c.lastReview).localeCompare(String(b.c.due || b.c.lastReview)); // 逾期久的优先
    });
    var reviewSrc = dueWrongs.map(function (x) { return x.w; });
    if (reviewSrc.length < N_REV) {
      var rest = pendingWrongs.sort(function (a, b) {
        return String(b.lastAt || b.addedAt).localeCompare(String(a.lastAt || a.addedAt));
      });
      reviewSrc = reviewSrc.concat(rest);
    }
    var review = reviewSrc.slice(0, N_REV).map(function (w) { return QM[w.qid]; }).filter(Boolean);

    return { date: dateStr, morning: morning, support: support, mix: mix, review: review, intensity: INTEN };
  }

  /* =====================================================================
   * 20 周章节计划：把全库按科目均分成 20 份，每周合并三科 → 题量均衡、
   * 每周三科都有。章节作为题的天然顺序切片展示；同一章节可跨周出现。
   * 纯函数：只依赖 QBANK，确定性，不写 localStorage。
   * ===================================================================== */
  var WEEK_COUNT = 20;
  var weekPlanCache = null;
  var planWeek = 1;             // 当前展示的周（1..20）
  var openChapters = {};        // 'week|sub|topic' -> true 展开态

  function buildWeekPlan() {
    if (weekPlanCache) return weekPlanCache;
    var bySub = {};
    SUBJECTS.forEach(function (s) { bySub[s] = QBANK.filter(function (q) { return q.subject === s; }); });
    // 每科按题库顺序切成 20 份（纯题数均匀切片，保证每周每科至少 1 题）
    var slices = {};
    SUBJECTS.forEach(function (s) {
      var arr = bySub[s], n = arr.length, prev = 0, weeks = [];
      for (var w = 0; w < WEEK_COUNT; w++) {
        var end = Math.round(n * (w + 1) / WEEK_COUNT);
        if (end <= prev) end = prev + 1;
        // 给后面的周留至少各 1 题
        var reserve = (WEEK_COUNT - 1 - w);
        if (n - end < reserve) end = n - reserve;
        if (w === WEEK_COUNT - 1) end = n;
        weeks.push(arr.slice(prev, end));
        prev = end;
      }
      slices[s] = weeks;
    });
    // 组装每周：{week, subjects:[{sub, chapters:[{topic,questions}]}], total}
    var weeks = [];
    for (var w = 0; w < WEEK_COUNT; w++) {
      var subs = [], total = 0;
      SUBJECTS.forEach(function (s) {
        var qs = slices[s][w];
        // 按章节顺序分组（保留题序）
        var chapters = [], map = {};
        qs.forEach(function (q) {
          var t = q.topic || '未分类';
          if (!map[t]) { map[t] = { topic: t, questions: [] }; chapters.push(map[t]); }
          map[t].questions.push(q);
        });
        total += qs.length;
        subs.push({ sub: s, chapters: chapters, count: qs.length });
      });
      weeks.push({ week: w + 1, subjects: subs, total: total });
    }
    weekPlanCache = weeks;
    return weeks;
  }

  // 当前周：距考试天数→周序（越近周序越大），限制在 1~20
  function currentWeekByExam() {
    var days = Math.ceil((new Date(examDate()) - new Date(todayStr())) / 86400000);
    if (!(days > 0)) return WEEK_COUNT;
    var weeksLeft = Math.ceil(days / 7);
    var w = WEEK_COUNT - weeksLeft + 1;
    return Math.max(1, Math.min(WEEK_COUNT, w));
  }

  // 某周日期范围（从今天起按周顺推展示用，非真实日历锚点）
  function weekRangeText(w) {
    var start = D.addDays(todayStr(), (w - 1) * 7);
    var end = D.addDays(start, 6);
    return start.slice(5).replace('-', '/') + ' — ' + end.slice(5).replace('-', '/');
  }

  function renderPlan() {
    var weeks = buildWeekPlan();
    var wk = weeks[planWeek - 1];
    if (!wk) return;
    // 距考试天数
    var days = Math.ceil((new Date(examDate()) - new Date(todayStr())) / 86400000);
    var cdEl = document.getElementById('planCountdown');
    if (cdEl) cdEl.textContent = days > 0 ? '距考试 ' + days + ' 天' : '考试加油';
    // 周标题与"本周"标记
    document.getElementById('weekCur').textContent = planWeek;
    var cur = currentWeekByExam();
    var tag = document.getElementById('weekCurTag');
    if (planWeek === cur) { tag.hidden = false; tag.textContent = '本周'; }
    else if (planWeek < cur) { tag.hidden = false; tag.textContent = '已过'; }
    else { tag.hidden = false; tag.textContent = '未开始'; }
    document.getElementById('weekRange').textContent = weekRangeText(planWeek);
    document.getElementById('weekPrev').disabled = planWeek <= 1;
    document.getElementById('weekNext').disabled = planWeek >= WEEK_COUNT;
    // 本周进度：该周题目中今日之前/当日已答的数量（按 qid 命中全部答题日志）
    var answeredSet = {};
    Store.answers().forEach(function (a) { answeredSet[a.qid] = true; });
    var weekQids = [];
    wk.subjects.forEach(function (s) {
      s.chapters.forEach(function (c) { c.questions.forEach(function (q) { weekQids.push(qid(q)); }); });
    });
    var doneN = weekQids.filter(function (id) { return answeredSet[id]; }).length;
    document.getElementById('weekProgText').textContent = doneN + ' / ' + wk.total + ' 题';
    document.getElementById('weekProgFill').style.width = (wk.total ? Math.round(doneN / wk.total * 100) : 0) + '%';
    // 周跳转快选（1..20，点击切周）
    document.getElementById('weekJump').innerHTML = weeks.map(function (x) {
      return '<button class="wj-chip' + (x.week === planWeek ? ' on' : '') + (x.week === cur ? ' cur' : '') +
             '" data-w="' + x.week + '">' + x.week + '</button>';
    }).join('');
    // 章节树
    var html = '';
    wk.subjects.forEach(function (s) {
      html += '<div class="wk-sub wk-sub-' + s.sub + '">' +
              '<div class="wks-hd"><span class="badge" data-sub="' + s.sub + '">' + SUBJ_CN[s.sub] + '</span>' +
              '<span class="wks-count">' + s.count + ' 题 · ' + s.chapters.length + ' 章节</span></div>';
      s.chapters.forEach(function (c) {
        var ck = planWeek + '|' + s.sub + '|' + c.topic;
        var open = !!openChapters[ck];
        var cDone = c.questions.filter(function (q) { return answeredSet[qid(q)]; }).length;
        html += '<div class="wk-chapter' + (open ? ' open' : '') + '">' +
                '<button class="wkc-hd" data-ck="' + esc(ck) + '"><span class="wkc-caret">' + (open ? '▾' : '▸') + '</span>' +
                '<span class="wkc-name">' + esc(c.topic) + '</span>' +
                '<span class="wkc-prog">' + cDone + '/' + c.questions.length + '</span></button>';
        if (open) {
          html += '<div class="wkc-body">' + c.questions.map(function (q, i) {
            var done = answeredSet[qid(q)];
            return '<button class="wkc-q' + (done ? ' done' : '') + '" data-qid="' + esc(qid(q)) + '">' +
                   '<span class="wq-n">' + (i + 1) + '</span><span class="wq-stem">' + esc(q.stem.slice(0, 42)) + '</span>' +
                   (done ? '<span class="wq-done">✓</span>' : '') + '</button>';
          }).join('') + '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    });
    document.getElementById('weekChapters').innerHTML = html;
  }

  // 计划页事件绑定（在 bindTabs 里调用一次）
  function bindPlan() {
    document.getElementById('weekPrev').addEventListener('click', function () {
      if (planWeek > 1) { planWeek--; renderPlan(); }
    });
    document.getElementById('weekNext').addEventListener('click', function () {
      if (planWeek < WEEK_COUNT) { planWeek++; renderPlan(); }
    });
    document.getElementById('weekJump').addEventListener('click', function (e) {
      var b = e.target.closest('.wj-chip'); if (!b) return;
      planWeek = +b.dataset.w; renderPlan();
    });
    document.getElementById('weekChapters').addEventListener('click', function (e) {
      var hd = e.target.closest('.wkc-hd');
      if (hd) { var k = hd.dataset.ck; openChapters[k] = !openChapters[k]; renderPlan(); return; }
      var qb = e.target.closest('.wkc-q');
      if (qb) {
        // 点题目→进入练习页并筛出该题所在考点
        var q = QM[qb.dataset.qid];
        if (q) { focusTopic = { s: q.subject, t: q.topic }; focusFlip = false; switchTab('practice'); }
      }
    });
  }

  /* =====================================================================
   * 每日背诵排期：30 新词 + 4 新考点 + 艾宾浩斯到期复习
   * 间隔序列 1/2/4/7/15 天；排期完全由 dateStr 决定，同日刷新一致
   * ===================================================================== */
  var EBBINGHAUS = [1, 2, 4, 7, 15];
  var TOPIC_LIST = [];   // [{s,t,key}] 按题库顺序去重
  function buildTopicList() {
    var seen = {}, out = [];
    QBANK.forEach(function (q) {
      var key = q.subject + '|' + q.topic;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ s: q.subject, t: q.topic, key: key });
    });
    TOPIC_LIST = out;
  }
  function wordKey(w) { return 'w:' + w; }
  function topicKey2(t) { return 't:' + t.s + '|' + t.t; }

  // 第 n 天学前 offset 个位置的内容（用于计算"几天前学了什么"）
  function dailySlice(dateStr, offset, pool, count) {
    var d = D.offset(dateStr, -offset);
    var rng = mulberry32(hashStr('study|' + d));
    var idxs = [];
    for (var i = 0; i < pool.length; i++) idxs.push(i);
    var picked = shuffle(idxs, rng);   // shuffle 返回新数组，必须接收
    return picked.slice(0, count).map(function (i) { return pool[i]; });
  }

  function buildDailyStudy(dateStr) {
    var WORDS_N = 30, TOPICS_N = 4;
    // 新学：从全库按日期种子取，避开最近 5 天已取过的（减少重复）
    var recentWords = {}, recentTopics = {};
    for (var k = 1; k <= 5; k++) {
      dailySlice(dateStr, k, WORDS, WORDS_N).forEach(function (w) { recentWords[w.w] = 1; });
      dailySlice(dateStr, k, TOPIC_LIST, TOPICS_N).forEach(function (t) { recentTopics[t.key] = 1; });
    }
    var wordPool = WORDS.filter(function (w) { return !recentWords[w.w] && !Study.isWordDone(wordKey(w.w)); });
    if (wordPool.length < WORDS_N) wordPool = WORDS.filter(function (w) { return !Study.isWordDone(wordKey(w.w)); });
    if (wordPool.length < WORDS_N) wordPool = WORDS.slice();
    var newWords = dailySlice(dateStr, 0, wordPool, WORDS_N);

    var topicPool = TOPIC_LIST.filter(function (t) { return !recentTopics[t.key] && !!TOPICS[t.key] && !Study.isTopicDone(topicKey2(t)); });
    if (topicPool.length < TOPICS_N) topicPool = TOPIC_LIST.filter(function (t) { return !!TOPICS[t.key] && !Study.isTopicDone(topicKey2(t)); });
    if (topicPool.length < TOPICS_N) topicPool = TOPIC_LIST.filter(function (t) { return !!TOPICS[t.key]; });
    var newTopics = dailySlice(dateStr, 0, topicPool, TOPICS_N);

    // 艾宾浩斯到期复习：1/2/4/7/15 天前学过的内容
    var reviewWords = [], reviewTopics = [], seenW = {}, seenT = {};
    EBBINGHAUS.forEach(function (gap) {
      dailySlice(dateStr, gap, WORDS, WORDS_N).forEach(function (w) {
        if (!seenW[w.w]) { seenW[w.w] = 1; reviewWords.push(w); }
      });
      dailySlice(dateStr, gap, TOPIC_LIST, TOPICS_N).forEach(function (t) {
        if (!seenT[t.key]) { seenT[t.key] = 1; reviewTopics.push(t); }
      });
    });
    return {
      date: dateStr, newWords: newWords, newTopics: newTopics,
      reviewWords: reviewWords.slice(0, 15), reviewTopics: reviewTopics.slice(0, 10)
    };
  }

  /* =====================================================================
   * 每日背诵渲染（词卡可翻面看释义/例句；考点可跳讲解；支持标记记住）
   * ===================================================================== */
  function renderStudy(ds) {
    var plan = buildDailyStudy(ds);
    var box = document.getElementById('studyBox');
    if (!box) return;
    document.getElementById('studyTag').textContent = plan.newWords.length + '词+' + plan.newTopics.length + '考点';

    var html = '<div class="study-sub">新单词 · 点击卡片看释义</div><div class="word-grid">';
    plan.newWords.forEach(function (w, i) {
      var done = Study.isWordDone(wordKey(w.w));
      html += '<div class="word-card' + (done ? ' learned' : '') + '" data-act="word-flip" data-w="' + esc(w.w) + '">' +
              '<div class="wc-front"><span class="wc-w">' + esc(w.w) + '</span><span class="wc-ph">' + esc(w.ph) + '</span></div>' +
              '<div class="wc-back"><div class="wc-m">' + esc(w.m) + '</div><div class="wc-eg">' + esc(w.eg) + '</div>' +
              '<div class="wc-egcn">' + esc(w.egCn) + '</div>' +
              '<button class="wc-ok' + (done ? ' done' : '') + '" data-act="word-learned" data-w="' + esc(w.w) + '">' + (done ? '✓ 已记住' : '记住了') + '</button></div>' +
              '</div>';
    });
    html += '</div>';

    html += '<div class="study-sub">新考点 · 先看讲解再做题</div><div class="study-topics">';
    plan.newTopics.forEach(function (t) {
      var done = Study.isTopicDone(topicKey2(t));
      var tk = t.s + '|' + t.t;
      html += '<div class="st-topic"><span class="q-sub st-sub" data-sub="' + esc(t.s) + '">' + esc(SUBJ_CN[t.s] || t.s) + '</span>' +
              '<span class="st-name">' + esc(t.t) + '</span>' +
              '<button class="st-go" data-act="study-topic" data-sub="' + esc(t.s) + '" data-topic="' + esc(t.t) + '">看讲解 →</button>' +
              (done ? '<span class="st-done">✓</span>' : '') + '</div>';
    });
    html += '</div>';

    var rv = plan.reviewWords.length + plan.reviewTopics.length;
    html += '<div class="study-review" data-act="study-review-toggle">' +
            '<span class="sr-ic">↻</span><span>艾宾浩斯到期复习：<b>' + rv + '</b> 项（1/2/4/7/15 天）</span><span class="sr-arrow">▾</span></div>' +
            '<div class="study-review-detail" id="studyReviewDetail" hidden>';
    // R3.6 整词换行：每个英文单词单独 span 包裹，容器只在分隔符处换行，绝不从词中间劈开
    function nowrapWords(arr, pick) {
      return arr.map(function (x) { return '<span class="nowrap">' + esc(pick(x)) + '</span>'; }).join(' · ');
    }
    if (plan.reviewWords.length) {
      html += '<div class="sr-line">单词：' + nowrapWords(plan.reviewWords, function (w) { return w.w; }) + '</div>';
    }
    if (plan.reviewTopics.length) {
      html += '<div class="sr-line">考点：' + nowrapWords(plan.reviewTopics, function (t) { return t.t; }) + '</div>';
    }
    html += '</div>';
    box.innerHTML = html;
    return plan;
  }

  /* =====================================================================
   * 今日页渲染
   * ===================================================================== */
  function renderToday() {
    var ds = todayStr();
    var plan = buildPlan(ds);
    Store.setPlan(ds, {
      morning: plan.morning.map(function (m) { return { s: m.s, t: m.t }; }),
      support: plan.support.map(qid), mix: plan.mix.map(qid), review: plan.review.map(qid)
    });

    // 00 每日背诵
    renderStudy(ds);

    // 01 晨读（接记忆到期）
    var dueN = Memory.dueCount();
    var badge = document.getElementById('dueBadge');
    if (dueN > 0) { badge.hidden = false; badge.textContent = '今日到期复习 ' + dueN + ' 条'; }
    else { badge.hidden = true; }
    document.getElementById('morningTag').textContent = '×' + plan.morning.length;
    document.getElementById('morningPoints').innerHTML = plan.morning.map(function (m) {
      var flag = m.highRisk ? '<span class="hr-flag">高危</span>' : (m.due ? '<span class="due-flag">待复习</span>' : '');
      return '<div class="kp-item" data-act="go-topic" data-sub="' + esc(m.s) + '" data-topic="' + esc(m.t) + '"><span class="kp-dot"></span>' +
             '<span class="kp-text">' + esc(m.t) + '</span>' + prioBadge(m.s, m.t, true) + flag +
             '<span class="kp-sub">' + esc(SUBJ_CN[m.s] || m.s) + ' ›</span></div>';
    }).join('');

    renderQList('supportQs', plan.support);
    renderQList('mixQs', plan.mix);
    if (plan.review.length) {
      document.getElementById('reviewTag').textContent = '×' + plan.review.length;
      renderQList('reviewQs', plan.review);
    } else {
      document.getElementById('reviewTag').textContent = '≤3';
      document.getElementById('reviewQs').innerHTML = '<div class="empty-hint">还没有错题，继续保持 ✦</div>';
    }

    updateHero();
    // R3.7 四段任务进度 + 复习提醒
    renderSegTasks();
    // R6.2 自适应强度标签
    var IN = buildPlan(ds).intensity;
    var pill = document.getElementById('intPill');
    if (pill) {
      pill.textContent = IN.label;
      pill.className = 'int-pill int-' + IN.level;
      document.getElementById('intReason').textContent = IN.reason;
    }
    document.getElementById('heroDate').textContent = ds;
    var dsEl2 = document.getElementById('heroDate2'); if (dsEl2) dsEl2.textContent = ds.slice(5);
    var studyPlan = buildDailyStudy(ds);
    var rdEl = document.getElementById('remindDue');
    if (rdEl) rdEl.textContent = String(studyPlan.reviewWords.length + studyPlan.reviewTopics.length);
    var rtEl = document.getElementById('remindTopics');
    if (rtEl) rtEl.textContent = '今日新考点 ' + studyPlan.newTopics.length + ' 个 · 新词 ' + studyPlan.newWords.length + ' 个';
    var days = Math.ceil((new Date(examDate()) - new Date(ds)) / 86400000);
    var cds = countdownState(days);
    var cdEl = document.getElementById('countdown');
    cdEl.textContent = cds.text;
    cdEl.className = 'countdown' + (cds.level ? ' cd-' + cds.level : '');
  }

  // 倒计时分级：>30 常规 / 10-30 提醒 / ≤10 紧急 / ≤0 加油
  function countdownState(days) {
    if (days <= 0) return { text: '考试加油', level: 'done', days: days };
    if (days <= 10) return { text: '仅剩 ' + days + ' 天！', level: 'urgent', days: days };
    if (days <= 30) return { text: '距考试 ' + days + ' 天', level: 'soon', days: days };
    return { text: '距考试 ' + days + ' 天', level: '', days: days };
  }

  /* =====================================================================
   * R3.7 今日四段任务进度可视化（只加展示层，不改计划引擎与答题链路）
   * 进度口径：晨读=看讲解考点数 / 晨读考点数；其余三段=该段已答题数 / 该段题数
   * 总进度 = 四段已答之和 / 四段总数之和（默认 21），随答题实时更新
   * ===================================================================== */
  var segmentIds = { support: [], mix: [], review: [] };  // 供段卡点击筛题
  function answeredCount(ids, answered) {
    return ids.filter(function (id) { return Object.prototype.hasOwnProperty.call(answered, id); }).length;
  }
  function renderSegTasks() {
    var ds = todayStr();
    var answered = Store.answeredToday(ds);
    var seen = Store.seenTopicsToday();
    var plan = Store.getPlan(ds) || { morning: [], support: [], mix: [], review: [] };
    var INTEN = intensityFor(ds);
    var morning = plan.morning || [];
    var mTotal = Math.min(PLAN_BASE.morning, morning.length);     // 晨读上限（科学增强版基准）
    var mDone = morning.filter(function (m) {
      return seen.indexOf(m.s + '|' + m.t) !== -1;
    }).length;
    mDone = Math.min(mDone, mTotal);

    // 科学增强版：题量与预估用时（呼应晨间攻坚/午后巩固/晚间整合的分段节奏）
    // 时长 = 基准 × 每段实际题数/基准题数，随自适应强度自动增减
    function minsFor(base, actual, baseN) { return Math.max(3, Math.round(base * actual / baseN)); }
    var segs = [
      { key: 'morning', name: '晨读知识点', done: mDone, total: mTotal, mins: minsFor(10, mTotal, PLAN_BASE.morning), phase: '晨间' },
      { key: 'support', name: '配套练习', done: answeredCount(plan.support, answered), total: plan.support.length, mins: minsFor(20, plan.support.length, PLAN_BASE.support), phase: '午后' },
      { key: 'mix', name: '混合套题', done: answeredCount(plan.mix, answered), total: plan.mix.length, mins: minsFor(35, plan.mix.length, PLAN_BASE.mix), phase: '午后' },
      { key: 'review', name: '错题回顾', done: answeredCount(plan.review, answered), total: plan.review.length, mins: minsFor(10, plan.review.length, PLAN_BASE.review), phase: '晚间' }
    ];
    segmentIds.support = plan.support;
    segmentIds.mix = plan.mix;
    segmentIds.review = plan.review;

    // 进度只保留一个口径：今日已答题数 / 全库题数（其余分母已删除）
    var answeredTodayN = Object.keys(answered).length;
    var totalMins = segs.reduce(function (a, s) { return a + (s.total > 0 ? s.mins : 0); }, 0);
    var doneMins = segs.reduce(function (a, s) { return a + Math.round((s.total > 0 ? s.done / s.total : 1) * s.mins); }, 0);

    document.getElementById('heroTotal').textContent = answeredTodayN + ' / ' + QBANK.length;
    document.getElementById('heroSegDone').textContent = '约 ' + doneMins + ' / ' + totalMins + ' 分钟';
    document.getElementById('segDoneTag').textContent = '今日 4 段';

    document.getElementById('taskCards').innerHTML = segs.map(function (s, i) {
      var ratio = s.total ? s.done / s.total : 1;
      var state = (s.total === 0 || s.done >= s.total) ? 'done' : (s.done > 0 ? 'doing' : '');
      var label = (s.total === 0 || s.done >= s.total) ? '完成' : (s.done > 0 ? '进行中' : '待做');
      var status = (s.key === 'review' && s.total === 0) ? '无错题' : (s.done + '/' + s.total + ' ' + label);
      var timeTag = s.total > 0 ? ' <span class="seg-time">' + s.phase + ' · 约' + s.mins + '分</span>' : '';
      // 入场直接呈现最终宽度，不逐帧 animate width（R3.7 红线）
      return '<div class="seg-item ' + state + '" data-act="go-seg" data-seg="' + s.key + '">' +
             '<div class="seg-num">' + (state === 'done' ? '✓' : (i + 1)) + '</div>' +
             '<div class="seg-body"><div class="seg-line"><span class="seg-name">' + s.name + timeTag + '</span>' +
             '<span class="seg-prog">' + status + '</span></div>' +
             '<div class="seg-track"><div class="seg-fill" style="width:' + Math.round(ratio * 100) + '%"></div></div></div>' +
             '<span class="seg-arrow">›</span></div>';
    }).join('');
  }

  function groupDone(ids, answered) {
    return ids.length > 0 && ids.every(function (id) { return Object.prototype.hasOwnProperty.call(answered, id); });
  }
  function updateHero() {
    var ds = todayStr();
    var snapshot = Store.getPlan(ds) || { support: [], mix: [], review: [] };
    var answered = Store.answeredToday(ds);
    var done = 0;
    if (groupDone(snapshot.support, answered)) done++;
    if (groupDone(snapshot.mix, answered)) done++;
    if (snapshot.review.length === 0 || groupDone(snapshot.review, answered)) done++;
    document.getElementById('heroProgress').textContent = done === 3 ? '今日任务已达成，可以打卡 ✦' : '完成全部任务后即可打卡';
    var streak = Store.streak();
    document.getElementById('heroTodayStreak').textContent = streak;
    var btn = document.getElementById('checkinBtn');
    if (Store.isChecked(ds)) {
      btn.disabled = true; btn.className = 'checkin-btn done'; btn.textContent = '今日已打卡 ✓';
    } else if (done === 3) {
      btn.disabled = false; btn.className = 'checkin-btn'; btn.textContent = '完成打卡 ✓';
    } else {
      btn.disabled = true; btn.className = 'checkin-btn done'; btn.textContent = '完成全部任务后打卡';
    }
  }

  /* =====================================================================
   * 题目卡渲染（支持 单选/判断/多选/填空/解答/翻译）
   * ===================================================================== */
  function questionHTML(q, idx, answeredLevel) {
    var id = qid(q), type = q.type;
    var opts = q.options || [];
    var html = '<div class="q-card" data-qid="' + id + '" data-type="' + esc(type) + '">';
    html += '<div class="q-meta"><span class="q-sub" data-sub="' + esc(q.subject) + '">' + esc(SUBJ_CN[q.subject] || q.subject) + '</span>' +
            '<span class="q-topic">' + esc(q.topic || '') + '</span>' +
            (q._origin === 'real' ? '<span class="q-topic">·真题</span>' : '') +
            prioBadge(q.subject, q.topic, true) + '</div>';
    if (q.passage) html += '<div class="q-passage">' + esc(q.passage) + '</div>';
    html += '<div class="q-stem">' + (idx + 1) + '. ' + esc(q.stem) + '</div>';

    if (type === 'choice' || type === 'judge' || type === 'multi_choice') {
      html += '<div class="opts">' + opts.map(function (o, oi) {
        var k = String(o).charAt(0);
        return '<div class="opt" data-act="pick" data-qid="' + id + '" data-k="' + esc(k) + '">' +
               '<span class="opt-k">' + esc(k) + '</span><span class="opt-t">' + esc(String(o).replace(/^[A-Da-d][.、)]\s*/, '')) + '</span>' +
               '<span class="opt-icon"></span></div>';
      }).join('') + '</div>';
      if (type === 'multi_choice') html += '<button class="fill-submit" data-act="submit-multi" data-qid="' + id + '">提交答案</button>';
    } else if (type === 'blank') {
      html += '<input class="fill-input" data-qid="' + id + '" placeholder="输入你的答案" ' +
              (answeredLevel != null ? 'value="' + esc(answerOf(q)) + '"' : '') + '>' +
              '<button class="fill-submit" data-act="submit-blank" data-qid="' + id + '">提交</button>';
      html += '<button class="reveal-btn" data-act="reveal" data-qid="' + id + '">看答案自评</button>';
    } else {
      // solve / translation：无自动判分，显示参考答案 + 三档自评
      html += '<button class="reveal-btn" data-act="reveal" data-qid="' + id + '">查看参考答案并自评</button>';
    }

    html += '<div class="q-answer" data-qid="' + id + '" hidden>' +
            '<div class="q-explain"><span class="lbl">参考答案</span><span class="ans-txt">' + esc(answerOf(q)) + '</span></div>' +
            (q.explain ? '<div class="q-explain"><span class="lbl">解析</span>' + esc(q.explain) + '</div>' : '') +
            (q.figure ? '<div class="q-figure"><div class="fig-title">图示 · 结合解析理解</div>' + q.figure + '</div>' : '') +
            '<div class="self-row"><button class="self-b btn btn-ok" data-act="self" data-level="2" data-qid="' + id + '">记住</button>' +
            '<button class="self-b btn btn-mid" data-act="self" data-level="1" data-qid="' + id + '">模糊</button>' +
            '<button class="self-b btn btn-bad" data-act="self" data-level="0" data-qid="' + id + '">忘了</button></div></div>';
    html += '<div class="q-fb-slot" data-qid="' + id + '"></div>';
    html += '</div>';
    return html;
  }

  function renderQList(elId, list) {
    var el = document.getElementById(elId);
    var answered = Store.answeredToday(todayStr());
    el.innerHTML = list.map(function (q, i) { return questionHTML(q, i, answered[qid(q)]); }).join('');
    mathRender(el);
  }

  /* ---------- 反馈动效：一律走引擎 animateOn ---------- */
  function flash(node, ok) {
    if (!engine || !node) return;
    engine.animateOn(node, [
      { opacity: 0.4, transform: 'scale(0.96)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: 340, easing: ok ? 'cubic-bezier(0.22,1.25,0.36,1)' : 'ease-out' });
  }

  function showResult(id, correct, q, cardRef) {
    // 同一题可能同时出现在今日页与练习页，必须定位到用户实际点击的那张卡，
    // 不能用全局 querySelector 命中后台隐藏的另一张（否则反馈加错、看不到）。
    var card = cardRef || document.querySelector('.q-card[data-qid="' + id + '"]');
    if (!card) return;
    var opts = [].slice.call(card.querySelectorAll('.opt'));
    opts.forEach(function (o) { o.classList.add('locked'); });
    var ans = answerOf(q);
    opts.forEach(function (o) {
      if (o.dataset.k === ans.charAt(0)) o.classList.add('correct');
    });
    var slot = card.querySelector('.q-fb-slot');
    var causeBar = '';
    if (!correct) {
      causeBar = '<div class="cause-pick" data-qid="' + id + '">' +
                 '<span class="cause-label">错因？</span>' +
                 Store.CAUSES.map(function (c) {
                   return '<button class="cause-tag" data-act="cause" data-qid="' + id + '" data-cause="' + c.key + '">' + c.label + '</button>';
                 }).join('') + '</div>';
    }
    slot.innerHTML = '<div class="q-fb ' + (correct ? 'ok' : 'no') + '">' +
                     (correct ? '✓ 回答正确' : '✗ 回答错误，已收入错题本') + '</div>' + causeBar;
    var ansBox = card.querySelector('.q-answer');
    ansBox.hidden = false;
    mathRender(ansBox);
    flash(slot, correct);
  }

  function selfResult(id, level, cardRef) {
    var card = cardRef || document.querySelector('.q-card[data-qid="' + id + '"]');
    if (!card) return;
    var slot = card.querySelector('.q-fb-slot');
    var txt = level === 2 ? '已记录：记住 ✓' : (level === 1 ? '已记录：模糊' : '已记录：忘了，已进复习池');
    slot.innerHTML = '<div class="q-fb ' + (level === 2 ? 'ok' : 'no') + '">' + txt + '</div>';
    flash(slot, level === 2);
  }

  /* ---------- 事件委托：所有答题交互 ---------- */
  function bindQuiz() {
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act, id = t.dataset.qid, q = QM[id];

      /* ---- R3 交互：晨读跳转 / 翻卡 / 去练习（无 qid，先处理） ---- */
      if (act === 'go-topic' || act === 'go-practice') {
        var s = t.dataset.sub, topic = t.dataset.topic;
        focusTopic = { s: s, t: topic };
        if (act === 'go-topic') {
          // R3.5 看讲解：聚焦卡直接翻到讲解面；R3.7 记入晨读段进度
          focusFlip = true;
          Store.markSeenTopic(s, topic);
          // 跳知识页：切到对应科目 subtab、定位高亮该卡
          var kb = document.querySelector('#knowSubs .subtab[data-sub="' + s + '"]');
          if (kb) { document.querySelectorAll('#knowSubs .subtab').forEach(function (x) { x.classList.toggle('active', x === kb); }); }
          renderKnowledge(s);
          switchTab('knowledge');
          setTimeout(function () {
            var target = document.querySelector('#knowCards .kp-card[data-topic="' + CSS.escape(topic) + '"]');
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 360);
        } else {
          // 去练习：按考点筛选
          var pb = document.querySelector('#practiceSubs .subtab[data-sub="' + s + '"]');
          if (pb) { document.querySelectorAll('#practiceSubs .subtab').forEach(function (x) { x.classList.toggle('active', x === pb); }); }
          renderPractice(s);
          switchTab('practice');
        }
        return;
      }
      if (act === 'flip') {
        flipCard(t.closest('.kp-card'));
        return;
      }
      /* ---- R6.1 只看重点开关 ---- */
      if (act === 'prio-toggle') {
        knowPrioOnly = !knowPrioOnly;
        var pt = document.getElementById('prioToggle');
        pt.classList.toggle('active', knowPrioOnly);
        pt.setAttribute('aria-pressed', knowPrioOnly ? 'true' : 'false');
        pt.childNodes[0].nodeValue = knowPrioOnly ? '★ 重点考点（已筛选） ' : '★ 只看重点考点 ';
        renderKnowledge(document.querySelector('#knowSubs .subtab.active').dataset.sub);
        return;
      }

      /* ---- R3.9 知识点自评：接入 SM-2，记住后按遗忘曲线沉底 ---- */
      if (act === 'kp-self') {
        var s2 = t.dataset.sub, t2 = t.dataset.topic, lv = +t.dataset.level;
        var pseudoQ = { subject: s2, topic: t2 };
        var card = Memory.touch(pseudoQ, lv);   // 复用引擎：更新 interval/ease/due
        var wrap = t.closest('.kp-self');
        var fb = wrap ? wrap.querySelector('.kps-fb') : null;
        var dayTxt = lv === 2 ? ('记住了，约 ' + card.interval + ' 天后复习')
                   : (lv === 1 ? ('模糊，约 ' + card.interval + ' 天后再看')
                   : '已忘了，明天再来复习');
        if (fb) fb.textContent = '✓ ' + dayTxt;
        if (wrap) wrap.querySelectorAll('.kps-b').forEach(function (b) { b.disabled = true; });
        // 更新这张卡的记忆徽章；延迟重排让它按新 due 沉到底部
        var kpCard = t.closest('.kp-card');
        if (kpCard) {
          var oldBadge = kpCard.querySelector('.kp-mem-badge');
          if (oldBadge) oldBadge.remove();
          var ns = memStatus(s2, t2);
          if (ns) kpCard.insertAdjacentHTML('afterbegin', '<span class="kp-mem-badge ' + ns.cls + '">' + ns.txt + '</span>');
        }
        refreshAfterAnswer();   // 同步总进度/记忆档案统计（不影响本卡交互）
        setTimeout(function () {
          var subSel = document.querySelector('#knowSubs .subtab.active');
          var curSub = subSel ? subSel.dataset.sub : s2;
          focusTopic = null; focusFlip = false;   // 重排后不再强制翻面
          renderKnowledge(curSub);
        }, 900);
        return;
      }

      /* ---- R3.7 段卡：进入对应练习/错题页并筛该段题目 ---- */
      if (act === 'go-seg') {
        var seg = t.dataset.seg;
        listFilter = null; focusTopic = null; focusFlip = false;
        if (seg === 'morning') {
          var plan = Store.getPlan(todayStr()) || {};
          var mp = buildPlan(todayStr()).morning;
          if (mp.length) {
            focusTopic = { s: mp[0].s, t: mp[0].t };
            focusFlip = true;
            var kb3 = document.querySelector('#knowSubs .subtab[data-sub="' + mp[0].s + '"]');
            if (kb3) document.querySelectorAll('#knowSubs .subtab').forEach(function (x) { x.classList.toggle('active', x === kb3); });
            renderKnowledge(mp[0].s);
            switchTab('knowledge');
          }
        } else if (seg === 'review') {
          switchTab('wrong');
        } else {
          var ids = segmentIds[seg] || [];
          var segName = { support: '配套练习', mix: '混合套题', review: '错题回顾' }[seg];
          listFilter = { label: segName, ids: ids };
          practiceSub = 'all';
          document.querySelectorAll('#practiceSubs .subtab').forEach(function (x) { x.classList.toggle('active', x.dataset.sub === 'all'); });
          renderPractice('all');
          switchTab('practice');
        }
        return;
      }
      if (act === 'review-remind') {
        var det = document.getElementById('studyReviewDetail');
        if (det) { det.hidden = false; det.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        var sr = document.querySelector('.study-review'); if (sr) sr.classList.add('open');
        return;
      }

      /* ---- 每日背诵：词卡翻面 / 标记记住 / 考点看讲解 / 复习展开 ---- */
      if (act === 'word-learned') {
        ev.stopPropagation();
        var wk = t.dataset.w;
        var learned = !Study.isWordDone(wordKey(wk));
        if (learned) Study.markWord(wk);
        else {
          var s1 = Study.all(); delete s1.doneWords[wordKey(wk)]; Study._save(s1);
        }
        t.classList.toggle('done', learned);
        t.textContent = learned ? '✓ 已记住' : '记住了';
        t.closest('.word-card').classList.toggle('learned', learned);
        return;
      }
      if (act === 'word-flip') {
        t.classList.toggle('flipped');
        return;
      }
      if (act === 'study-topic') {
        var ss = t.dataset.sub, stt = t.dataset.topic;
        focusTopic = { s: ss, t: stt };
        focusFlip = true;   // R3.5 看讲解直接翻到讲解面
        Store.markSeenTopic(ss, stt);   // R3.7 晨读段进度
        var kb2 = document.querySelector('#knowSubs .subtab[data-sub="' + ss + '"]');
        if (kb2) { document.querySelectorAll('#knowSubs .subtab').forEach(function (x) { x.classList.toggle('active', x === kb2); }); }
        renderKnowledge(ss);
        switchTab('knowledge');
        setTimeout(function () {
          var target2 = document.querySelector('#knowCards .kp-card[data-topic="' + CSS.escape(stt) + '"]');
          if (target2) target2.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 360);
        return;
      }
      if (act === 'study-review-toggle') {
        var detail = document.getElementById('studyReviewDetail');
        if (detail) detail.hidden = !detail.hidden;
        t.classList.toggle('open');
        return;
      }

      /* ---- R12 错因筛选（无 qid） ---- */
      if (act === 'cause-filter') {
        wrongCauseFilter = t.dataset.cause || '';
        renderWrong(wrongSub);
        return;
      }

      if (!q) return;

      /* ---- R12 错因标注（标签点选，可取消） ---- */
      if (act === 'cause') {
        var cause = t.dataset.cause;
        var cur = Store.setWrongCause(q, cause);
        // 同卡片内所有本题标签同步高亮
        document.querySelectorAll('.cause-pick[data-qid="' + id + '"] .cause-tag').forEach(function (b) {
          b.classList.toggle('on', b.dataset.cause === cur);
        });
        return;
      }
      /* ---- R12 同类变式题：单题聚焦到练习页 ---- */
      if (act === 'variant') {
        gotoVariant(t.dataset.qid);
        return;
      }

      if (act === 'pick') {
        var card = t.closest('.q-card');
        if (card.dataset.locked === '1') return;
        if (q.type === 'multi_choice') {
          t.classList.toggle('left');                       // 多选只切换选中
          return;
        }
        card.dataset.locked = '1';
        [].slice.call(card.querySelectorAll('.opt')).forEach(function (o) { o.classList.remove('left'); });
        t.classList.add('left');
        var correct = judge(q, t.dataset.k);
        Store.logAnswer(q, correct ? 2 : 0);
        showResult(id, correct, q, card);
        refreshAfterAnswer();
      } else if (act === 'submit-multi') {
        var card2 = t.closest('.q-card');
        if (card2.dataset.locked === '1') return;
        var picked = [].slice.call(card2.querySelectorAll('.opt.left')).map(function (o) { return o.dataset.k; });
        if (!picked.length) return;
        card2.dataset.locked = '1';
        var ok = judge(q, picked);
        Store.logAnswer(q, ok ? 2 : 0);
        showResult(id, ok, q, card2);
        refreshAfterAnswer();
      } else if (act === 'submit-blank') {
        var card3 = t.closest('.q-card');
        if (card3.dataset.locked === '1') return;
        var input = card3.querySelector('.fill-input');
        var val = (input && input.value || '').trim();
        if (!val) return;
        card3.dataset.locked = '1';
        var ok2 = judge(q, val);
        Store.logAnswer(q, ok2 ? 2 : 0);
        showResult(id, ok2, q, card3);
        refreshAfterAnswer();
      } else if (act === 'reveal') {
        var ansBox = t.closest('.q-card').querySelector('.q-answer');
        ansBox.hidden = !ansBox.hidden;
        if (!ansBox.hidden) mathRender(ansBox);
      } else if (act === 'self') {
        var card4 = t.closest('.q-card');
        // 修复：选项作答后卡片 locked=1，原逻辑在此直接 return，导致答完题点「记住/模糊/忘了」无反应。
        // 自评不再被 locked 阻止；用 selfLevel 去重——同档重复点击忽略，改档则更新记忆记录。
        var level = +t.dataset.level;
        if (card4.dataset.selfLevel === String(level)) return;
        card4.dataset.selfLevel = String(level);
        Store.logAnswer(q, level);
        card4.querySelector('.q-answer').hidden = false;
        selfResult(id, level, card4);
        refreshAfterAnswer();
      }
    });
  }

  function refreshAfterAnswer() {
    updateHero();
    // R3.7 答题后实时同步四段进度（今日页 DOM 存在才更新，避免知识页误触）
    if (document.getElementById('taskCards')) renderSegTasks();
    document.getElementById('practiceDone').textContent = '今日 ' +
      Object.keys(Store.answeredToday(todayStr())).length + ' 题';
  }

  /* ---------- 练习页 ---------- */
  var practiceSub = 'all';
  var practiceDiff = 'all';   // R8.2 难度筛选：all / '1'基础 / '2'进阶 / '3'挑战
  var practiceSeed = 0;
  var listFilter = null;   // R3.7 段卡筛题：{label, ids}
  function renderPractice(sub) {
    practiceSub = sub || 'all';
    var list = QBANK.filter(function (q) {
      if (practiceSub !== 'all' && q.subject !== practiceSub) return false;
      // 难度筛选：无 difficulty 字段的题只在"全部"下显示
      if (practiceDiff !== 'all' && String(q.difficulty) !== practiceDiff) return false;
      return true;
    });
    // R3.7 段卡筛题（优先于考点筛选）
    var chip = document.getElementById('filterChip');
    if (listFilter) {
      var idset = {};
      listFilter.ids.forEach(function (id) { idset[id] = 1; });
      list = list.filter(function (q) { return idset[qid(q)]; });
      chip.hidden = false;
      chip.querySelector('.ft').textContent = listFilter.label + '（' + list.length + '题）';
    } else if (focusTopic && (focusTopic.s === practiceSub || practiceSub === 'all')) {
      // R3：考点筛选（从知识卡"去练习"进入）
      list = list.filter(function (q) { return q.topic === focusTopic.t; });
      chip.hidden = false;
      chip.querySelector('.ft').textContent = '考点：' + focusTopic.t + '（' + list.length + '题）';
    } else {
      chip.hidden = true;
    }
    var rng = mulberry32(hashStr(todayStr() + '|practice|' + practiceSub + '|' + (focusTopic ? focusTopic.t : '') + practiceSeed));
    var shown;
    if (listFilter && listFilter.ids) {
      // 段卡筛题：展示该段全部题（混合22道不被 20 上限截断）
      shown = shuffle(list, rng);
      document.getElementById('bankTotal').textContent = '今日该段共 ' + list.length + ' 题 · 全部展示';
    } else {
      shown = shuffle(list, rng).slice(0, 20);
      document.getElementById('bankTotal').textContent = '共 ' + list.length + ' 题 · 每次展示 20 道';
    }
    if (!list.length && practiceDiff !== 'all') {
      // 某难度在该科目下无题（如英语无"挑战"题）：给友好提示而非空白
      var dn = { '1': '基础', '2': '进阶', '3': '挑战' }[practiceDiff];
      var sn = { english: '英语', math: '数学', cs: '计算机' }[practiceSub] || '本科目';
      document.getElementById('practiceList').innerHTML =
        '<div class="empty-state"><div class="empty-icon">✦</div>' +
        '<div class="empty-txt">' + sn + '暂无「' + dn + '」题</div>' +
        '<div class="empty-sub">换一个难度或科目试试</div></div>';
    } else {
      renderQList('practiceList', shown);
    }
    refreshAfterAnswer();
  }

  /* ---------- 知识页（R3 翻卡） ---------- */
  function memStatus(sub, topic) {
    var all = Memory.all(), c = all[sub + '|' + topic];
    if (!c) return null;
    if (c.highRisk) return { cls: 'risk', txt: '高危' };
    if (Memory.isDue(c)) return { cls: 'due', txt: '到期' };
    // 明确"忘了"待巩固：显示待复习
    if (c.streak === 0 && c.interval === 1 && (c.wrongCount || 0) > 0)
      return { cls: 'due', txt: '待复习' };
    // 已记住（未到期）：显示间隔天数，让用户知道被安排到几天后
    if (c.streak >= 3) return { cls: 'mastered', txt: '已掌握' };
    if (c.reps > 0) return { cls: 'memorized', txt: c.interval + '天后' };
    return null;
  }
  // R3.5 五类学科模板：按 kind 生成背面分段（定义→规则/步骤→易错→例句/例题→（锚点）→跳转）
  // 段落标签按学科定制；例句/例题来自题库真实题，零编造；跳转永远在最后
  function backContent(c) {
    var info = c.info || {};
    var kind = info.kind || (c.s === 'math' ? 'math' : c.s === 'cs' ? 'cs' : 'grammar');
    var def = info.def || '该考点的知识点讲解。';
    var html = '<div class="kp-card-def-full kp-sec">' + esc(def) + '</div>';

    // 第二段：核心规则 / 公式 / 原理 / 解题步骤（按学科换标签，内容取真实考点的 points）
    var ruleLabel = { grammar: '核心规则', math: '核心公式 / 要点', cs: '原理 / 组成', reading: '解题步骤' }[kind] || '核心要点';
    if (info.points && info.points.length) {
      html += '<div><span class="kp-sec-t ' + (kind === 'reading' ? 't-step' : 't-rule') + '">' + ruleLabel + '</span>' +
              '<ul class="kp-points">' + info.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
    }
    // 第三段：易错红线（R3.8 notice 组件：淡朱砂底+竖条+自动换行，正文墨色非整段红字）
    if (info.trap) html += '<div class="kp-trap notice-warn"><span class="nt">⚠ 易错红线</span>' + esc(info.trap) + '</div>';
    // 第四段：典型例句 / 例题（来自题库真实题，R3.8 ex-box 组件）
    if (info.example) {
      var eg = info.example;
      html += '<div class="kp-eg ex-box"><span class="kp-sec-t t-eg">' + esc(eg.kind || '例题') + '</span>' +
              '<span class="eg-stem">' + esc(eg.stem) + '</span>' +
              '<span>参考答案：<span class="eg-ans">' + esc(eg.answer) + '</span></span>' +
              (eg.explain ? '<span class="eg-exp">' + esc(eg.explain) + '</span>' : '') + '</div>';
    }
    // 记忆锚点（若有，R3.8 notice-tip 组件）
    if (info.anchor) html += '<div class="kp-anchor notice-tip"><span class="nt">✦ 记忆锚点</span>' + esc(info.anchor) + '</div>';
    // R3.9 自评三档：记住/模糊/忘了 → 接入 SM-2，记住后按遗忘曲线沉底
    html += '<div class="kp-self" data-self-for="' + esc(c.s) + '|' + esc(c.t) + '">' +
            '<span class="kps-lbl">记住了吗？</span>' +
            '<button class="btn kps-b btn-ok" data-act="kp-self" data-sub="' + esc(c.s) + '" data-topic="' + esc(c.t) + '" data-level="2">✓ 记住</button>' +
            '<button class="btn kps-b btn-mid" data-act="kp-self" data-sub="' + esc(c.s) + '" data-topic="' + esc(c.t) + '" data-level="1">~ 模糊</button>' +
            '<button class="btn kps-b btn-bad" data-act="kp-self" data-sub="' + esc(c.s) + '" data-topic="' + esc(c.t) + '" data-level="0">✗ 忘了</button>' +
            '<span class="kps-fb"></span></div>';
    // 底部跳转：永远最后
    html += '<button class="kp-go" data-act="go-practice" data-sub="' + esc(c.s) + '" data-topic="' + esc(c.t) + '"><svg class="kp-go-ic" viewBox="0 0 24 24"><path d="M4 5.5C7 4 10 4.5 12 6.5c2-2 5-2.5 8-1v13c-3-1.5-6-1-8 1-2-2-5-2.5-8-1v-13z"/><path d="M12 6.5v13"/></svg>相关题目 ' + c.n + ' 道 · 想练再点 →</button>';
    return html;
  }

  /* R3.9 遗忘曲线排序：未学→高危→到期→已记住(按下次复习日due升序沉后)
   * 记住后 interval 变大、due 推远，卡片自动沉底；到期日到了再回到前面。 */
  function knowSortRank(c) {
    var all = Memory.all(), card = all[c.s + '|' + c.t];
    if (!card) return { tier: 1, due: 0, risk: 0 };                // 未学：次优先
    if (card.highRisk) return { tier: 0, due: 0, risk: 1 };        // 高危：最前
    // 明确"忘了"（错后 streak=0 且 interval=1）：回到最前重点巩固
    if (card.streak === 0 && card.interval === 1 && (card.wrongCount || 0) > 0)
      return { tier: 0, due: 0, risk: 0 };
    if (Memory.isDue(card)) return { tier: 0, due: 0, risk: 0 };   // 到期：最前
    // 已记住未到期：due 越远越靠后（记得越牢沉得越深）
    var due = card.due || D.offset(card.lastReview, card.interval);
    return { tier: 2, due: due, risk: 0 };
  }
  function renderKnowledge(sub) {
    var seen = {}, cards = [];
    QBANK.forEach(function (q) {
      if (q.subject !== sub || seen[q.topic]) return;
      seen[q.topic] = 1;
      var rel = QBANK.filter(function (x) { return x.subject === sub && x.topic === q.topic; });
      var t = TOPICS[sub + '|' + q.topic];
      cards.push({ t: q.topic, s: sub, n: rel.length, info: t || null });
    });
    // R6.1 只看重点：过滤掉 normal 考点
    if (knowPrioOnly) cards = cards.filter(function (c) {
      return c.info && c.info.priority && c.info.priority !== 'normal';
    });
    // 更新重点计数（当前科目 core+high 数）
    var pcEl = document.getElementById('prioCount');
    if (pcEl) {
      var allCards = [];
      var sn = {};
      QBANK.forEach(function (q) {
        if (q.subject === sub || sub === 'all') {
          if (!sn[q.subject + '|' + q.topic]) {
            sn[q.subject + '|' + q.topic] = 1;
            var tt = TOPICS[q.subject + '|' + q.topic];
            if (tt && tt.priority && tt.priority !== 'normal') allCards.push(1);
          }
        }
      });
      pcEl.textContent = allCards.length ? '(' + allCards.length + ')' : '';
    }
    // R3.9：按遗忘曲线优先级排序，记住的沉底、未学与待复习的靠前
    cards.forEach(function (c) { c.rank = knowSortRank(c); });
    cards.sort(function (a, b) {
      if (a.rank.tier !== b.rank.tier) return a.rank.tier - b.rank.tier;
      if (a.rank.risk !== b.rank.risk) return b.rank.risk - a.rank.risk;
      if (a.rank.tier === 2 && a.rank.due !== b.rank.due) return String(a.rank.due).localeCompare(String(b.rank.due));
      return 0;
    });
    document.getElementById('knowCards').innerHTML = cards.map(function (c) {
      var isFocus = focusTopic && focusTopic.s === c.s && focusTopic.t === c.t;
      // R3.5：看讲解进入时，聚焦卡直接翻到讲解面
      var showBack = isFocus && focusFlip;
      var st = memStatus(c.s, c.t);
      var badge = st ? '<span class="kp-mem-badge ' + st.cls + '">' + st.txt + '</span>' : '';
      var info = c.info;
      var def = info ? info.def : '该考点的知识点讲解。';
      var defShort = def.length > 42 ? def.slice(0, 42) + '…' : def;
      var kindLabel = { grammar: '英语语法', math: '数学 · 导数/计算', cs: '计算机 · 概念原理', reading: '英语阅读 · 方法' }[info && info.kind] || '';
      var pBadge = prioBadge(c.s, c.t);
      return '<div class="kp-card' + (isFocus ? ' highlight' : '') + (showBack ? ' flipped' : '') + '" data-sub="' + esc(c.s) + '" data-topic="' + esc(c.t) + '" data-act="flip">' +
             badge +
             '<div class="kp-face front"><div class="kp-card-t">' + esc(c.t) + pBadge + '</div>' +
             '<div class="kp-card-def">' + esc(defShort) + '</div>' +
             '<div class="kp-card-sub">' + (kindLabel ? kindLabel + ' · ' : '') + '点击翻面看讲解 · ' + c.n + ' 道关联题</div></div>' +
             '<div class="kp-face back"><div class="kp-card-t">' + esc(c.t) + pBadge + '</div>' +
             backContent(c) + '</div>' +
             '</div>';
    }).join('');
    // R3.8：知识卡背面含真实例题/要点里的 LaTeX，必须渲染，杜绝裸源码
    mathRender(document.getElementById('knowCards'));
  }

  /* 翻卡：纯 CSS transition（.kp-face 的 transform/opacity 过渡），JS 只切 class。
     不用 animateOn：回弹曲线末段过冲 + onfinish 的 a.cancel() 会把 transform 瞬间弹回，正是回翻闪屏根因。
     CSS 动画与终态同源、ease 单调收敛、支持中途反向，连点也不需要 flipping 锁。 */
  function flipCard(card) {
    card.classList.toggle('flipped');
  }

  /* ---------- 错题页 ---------- */
  var wrongSub = 'all', rebrush = false;
  var wrongCauseFilter = '';   // R12 错因筛选（空=全部）

  function renderWrong(sub) {
    wrongSub = sub || 'all';
    var all = Store.activeWrongs().filter(function (w) { return wrongSub === 'all' || w.subject === wrongSub; });
    var cstats = Store.causeStats();
    var list = all.filter(function (w) { return !wrongCauseFilter || w.cause === wrongCauseFilter; });
    var stat = document.getElementById('wrongStat');
    var btn = document.getElementById('rebrushBtn');
    stat.textContent = '待攻克 ' + all.length + ' 题 · 答对 3 次自动移出';
    btn.hidden = all.length === 0;
    btn.textContent = rebrush ? '退出重刷' : '重刷模式';
    var wrap = document.getElementById('wrongWrap');

    // 错因分布条（可点筛选）
    var causeBar = '<div class="cause-strip"><span class="cs-label">错因分布</span>';
    causeBar += '<button class="cs-chip' + (!wrongCauseFilter ? ' active' : '') + '" data-act="cause-filter" data-cause="">全部 ' + all.length + '</button>';
    Store.CAUSES.forEach(function (c) {
      if (cstats[c.key] > 0) {
        causeBar += '<button class="cs-chip' + (wrongCauseFilter === c.key ? ' active' : '') +
                    '" data-act="cause-filter" data-cause="' + c.key + '">' + c.label + ' ' + cstats[c.key] + '</button>';
      }
    });
    if (cstats._unlabeled > 0) {
      causeBar += '<button class="cs-chip' + (wrongCauseFilter === '_none' ? ' active' : '') +
                  '" data-act="cause-filter" data-cause="_none">未标注 ' + cstats._unlabeled + '</button>';
    }
    causeBar += '</div>';

    if (!list.length) {
      wrap.innerHTML = causeBar + '<div class="empty-state"><div class="empty-icon">✦</div>' +
        '<div class="empty-txt">' + (wrongCauseFilter ? '该错因下暂无题目' : '错题本还是空的') + '</div>' +
        '<div class="empty-sub">' + (wrongCauseFilter ? '点「全部」看其他错题' : '答错的题会自动收进这里') + '</div></div>';
      return;
    }
    var grouped = {};
    list.forEach(function (w) { (grouped[w.subject] = grouped[w.subject] || []).push(w); });
    var html = causeBar + '<div class="mastery-tip">每道题连续答对 3 次即标记「已掌握」并移出错题本。</div>';
    Object.keys(grouped).forEach(function (s) {
      html += '<div class="wrong-group"><div class="wrong-group-hd">' +
              '<span class="q-sub" data-sub="' + esc(s) + '">' + esc(SUBJ_CN[s] || s) + '</span>' +
              '<span class="wg-count">' + grouped[s].length + ' 题</span></div>';
      html += '<div class="q-list">' + grouped[s].map(function (w, i) {
        var q = QM[w.qid];
        if (!q) return '<div class="empty-hint">题已失效</div>';
        var card = questionHTML(q, i, null);
        // 在卡片末尾插入：错因标注 + 同类题推荐
        var causeLabel = Store.CAUSES.filter(function (c) { return c.key === w.cause; })[0];
        var extra = '<div class="wrong-extra">' +
                    '<div class="we-cause"><span class="we-lb">我错在</span>' +
                    Store.CAUSES.map(function (c) {
                      return '<button class="cause-tag' + (w.cause === c.key ? ' on' : '') +
                             '" data-act="cause" data-qid="' + esc(w.qid) + '" data-cause="' + c.key + '">' + c.label + '</button>';
                    }).join('') + '</div>';
        var sims = similarQuestions(q, 3);
        if (sims.length) {
          extra += '<div class="we-variants"><div class="we-vt">同类变式 · 再练 ' + sims.length + ' 题</div>' +
                   sims.map(function (sq) {
                     return '<button class="variant-btn" data-act="variant" data-qid="' + esc(qid(sq)) + '">' +
                            '<span class="vb-topic">' + esc(sq.topic || '') + '</span>' +
                            '<span class="vb-stem">' + esc(String(sq.stem).slice(0, 42)) + (String(sq.stem).length > 42 ? '…' : '') + '</span>' +
                            '<span class="vb-go">练这题 ›</span></button>';
                   }).join('') + '</div>';
        }
        extra += '</div>';
        // 插到 .q-card 最外层闭合标签前（用 lastIndexOf 定位末尾 </div>）
        var pos = card.lastIndexOf('</div>');
        return card.slice(0, pos) + extra + card.slice(pos);
      }).join('') + '</div></div>';
    });
    wrap.innerHTML = html;
    mathRender(wrap);
  }

  /* ---------- R12 同类题推荐：同考点变式，控制粒度与质量 ---------- */
  function stemTokens(s) {
    // 中英文混合题干取词：英文单词 + 中文二字词，用于粗粒度考点内的相似度
    var words = String(s || '').toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fa5]{2}/g) || [];
    var set = {};
    words.forEach(function (w) { set[w] = 1; });
    return set;
  }
  function similarQuestions(q, limit) {
    limit = limit || 3;
    if (!q) return [];
    var mastered = {};
    Store.wrongs() && Object.keys(Store.wrongs()).forEach(function (k) {
      if (Store.wrongs()[k].mastered) mastered[k] = 1;
    });
    var selfId = qid(q);
    var srcTok = stemTokens(q.stem);
    var cand = QBANK.filter(function (x) {
      return x.subject === q.subject && x.topic === q.topic && qid(x) !== selfId && !mastered[qid(x)];
    });
    // 评分：题干用词重叠（越像越像变式）+ 难度接近（同难度最佳）
    var scored = cand.map(function (x) {
      var tok = stemTokens(x.stem), overlap = 0;
      Object.keys(srcTok).forEach(function (w) { if (tok[w]) overlap++; });
      var dDiff = Math.abs((+x.difficulty || 1) - (+q.difficulty || 1));
      return { q: x, score: overlap * 2 - dDiff };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit).map(function (s) { return s.q; });
  }

  // 点"练这题"：切到练习页单题聚焦模式，确保目标题一定显示
  function gotoVariant(qidTarget) {
    var q = QM[qidTarget];
    if (!q) return;
    focusTopic = null;
    practiceSub = 'all';
    practiceDiff = 'all';
    document.querySelectorAll('#diffTabs .diff-tab').forEach(function (x) {
      x.classList.toggle('active', x.dataset.diff === 'all');
    });
    var chip = document.getElementById('filterChip'); if (chip) chip.hidden = true;
    listFilter = { label: '同类变式 · ' + (q.topic || ''), ids: [qidTarget] };
    switchTab('practice');
    setTimeout(function () {
      var el = document.querySelector('#practiceList .q-card[data-qid="' + CSS.escape(qidTarget) + '"]');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 380);
  }

  /* ---------- 我的页 ---------- */
  function renderMe() {
    var s = Store.stats();
    document.getElementById('meStreak').textContent = s.streak;
    document.getElementById('meToday').textContent = s.sevenDays[6].count;
    document.getElementById('meRate').textContent = s.rate + '%';
    document.getElementById('meWrong').textContent = s.wrongCount;
    // R8 错题本入口卡待复习数
    var weCount = document.getElementById('wrongEntryCount');
    if (weCount) weCount.textContent = Store.activeWrongs().length + ' 题待复习';
    // R6.3 考试日设置回填
    var ed = examDate(), custom = !!Store.getExamDate();
    var examInput = document.getElementById('examInput');
    if (examInput) examInput.value = ed;
    var ph = document.getElementById('examPlaceholder');
    if (ph) { ph.textContent = custom ? '已设置' : '占位日期'; ph.className = 'exam-placeholder' + (custom ? ' set' : ''); }

    // 近7日练习量柱状图（动画走引擎）
    var max = Math.max(1, Math.max.apply(null, s.sevenDays.map(function (d) { return d.count; })));
    var labels = ['一', '二', '三', '四', '五', '六', '日'];
    var bars = s.sevenDays.map(function (d, i) {
      var h = Math.max(4, Math.round(d.count / max * 100));
      return '<div class="cb-col"><div class="cb-bar ' + (d.count ? 'has' : '') + '" data-h="' + h + '" style="height:4px"></div>' +
             '<div class="cb-lb">' + (d.date.slice(8)) + '</div></div>';
    }).join('');
    var el = document.getElementById('chartBars');
    el.innerHTML = bars;
    [].slice.call(el.querySelectorAll('.cb-bar')).forEach(function (b, i) {
      if (engine) engine.animateOn(b, [{ height: '4px' }, { height: b.dataset.h + '%' }], { delay: i * 60 });
      else b.style.height = b.dataset.h + '%';
    });

    // 记忆曲线
    var curve = Memory.curve(30);
    var cmax = Math.max(1, Math.max.apply(null, curve.map(function (d) { return d.count; })));
    var totalRev = curve.reduce(function (a, b) { return a + b.count; }, 0);
    var mbars = curve.map(function (d) {
      var h = Math.max(3, Math.round(d.count / cmax * 100));
      return '<div class="cb-col"><div class="cb-bar ' + (d.count ? 'has' : '') + '" style="height:' + h + '%"></div></div>';
    }).join('');
    document.getElementById('memoryBars').innerHTML = mbars;
    document.getElementById('curveTip').textContent = totalRev > 0
      ? '近30天共复习 ' + totalRev + ' 次 · 到期 ' + Memory.dueCount() + ' 条'
      : '做几道题后这里会记录你的复习节奏';
    // R7 存储健康徽章：写入失败/无痕模式时变红警示
    var badge = document.getElementById('storageBadge');
    if (badge) {
      var errs = Store.getWriteErrors();
      if (!Store.storageWritable() || errs.length > 0) {
        badge.textContent = '● 存储异常 · 请导出备份';
        badge.className = 'storage-badge danger';
      } else {
        badge.textContent = '● 本机存储正常';
        badge.className = 'storage-badge';
      }
    }
  }

  /* =====================================================================
   * R11 专注番茄钟 UI（数据层在 store.js 的 Pomo 模块）
   * 时间戳计时，切页/锁屏不中断；每秒 tick，到点提醒 + 自动转休息/结束。
   * ===================================================================== */
  var Pomo = Store.Pomo;
  var pomoTimer = null;          // setInterval 句柄
  var pomoNotify = function () {}; // 到点提醒（绑定时注入）
  var RING_C = 2 * Math.PI * 98; // 圆环周长 ≈ 615.75

  function fmtClock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // 把 "MM:SS" 拆写到分/秒两个节点（冒号节点固定为 ':'，innerText 仍是完整时间）
  function paintClock(txt) {
    var parts = txt.split(':');
    var mm = document.getElementById('ftMm'), ss = document.getElementById('ftSs');
    if (mm) mm.textContent = parts[0];
    if (ss) ss.textContent = parts[1];
  }

  // 暂停反馈：数字淡出+缩小再回来（重放动画）
  function pulseClock() {
    var el = document.getElementById('ftTime');
    if (!el) return;
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    setTimeout(function () { el.classList.remove('pulse'); }, 550);
  }

  // 到点庆祝：环扩散 + "本轮完成"淡入淡出
  function celebratePomo() {
    var w = document.getElementById('ftWave'), d = document.getElementById('ftDone');
    [w, d].forEach(function (el) {
      if (!el) return;
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
      setTimeout(function () { el.classList.remove('go'); }, 1400);
    });
  }

  // 渲染番茄钟（倒计时 + 圆环 + 按钮态），每 tick 调用
  function renderPomo() {
    var box = document.getElementById('focusTimer');
    if (!box) return;
    var s = Pomo.session();
    var stat = Pomo.stats();
    var modeEl = document.getElementById('ftMode');
    var subjEl = document.getElementById('ftSubject');
    var prog = document.getElementById('ftProg');
    var bStart = document.getElementById('ftStart');
    var bPause = document.getElementById('ftPause');
    var bAbandon = document.getElementById('ftAbandon');
    var bSkip = document.getElementById('ftSkip');

    if (!s) {
      prog.style.strokeDashoffset = '0';
      paintClock(fmtClock(Pomo.FOCUS_MS));
      modeEl.textContent = '准备开始';
      // 选当天第一个未完成的槽位作为下一个
      var recs = Pomo.records();
      var doneSlots = recs.filter(function (r) { return r.date === D.today(); }).map(function (r) { return r.slot; });
      var nextSlot = 0;
      while (nextSlot < stat.slots.length && doneSlots.indexOf(nextSlot) >= 0) nextSlot++;
      if (nextSlot >= stat.slots.length) nextSlot = stat.slots.length - 1;
      var sub = stat.slots[nextSlot];
      subjEl.textContent = '第 ' + (nextSlot + 1) + ' 个 · ' + Pomo.subjectName(sub);
      box.classList.remove('break');
      bStart.hidden = false; bStart.textContent = '开始专注';
      bStart.dataset.slot = String(nextSlot); bStart.dataset.subject = sub;
      bPause.hidden = true; bAbandon.hidden = true; bSkip.hidden = true;
    } else {
      var total = (s.mode === 'focus') ? Pomo.FOCUS_MS : Pomo.BREAK_MS;
      var remain = s.paused ? s.pausedLeft : Math.max(0, s.endAt - Date.now());
      var ratio = Math.max(0, Math.min(1, remain / total));
      prog.style.strokeDashoffset = String(RING_C * (1 - ratio));
      paintClock(fmtClock(remain));
      modeEl.textContent = s.paused ? '已暂停' : (s.mode === 'focus' ? '专注中' : '休息中');
      subjEl.textContent = '第 ' + (s.slot + 1) + ' 个 · ' + Pomo.subjectName(s.subject);
      box.classList.toggle('break', s.mode === 'break');
      bStart.hidden = true;
      bAbandon.hidden = false;
      if (s.mode === 'focus') {
        bPause.hidden = false; bPause.textContent = s.paused ? '继续' : '暂停';
        bSkip.hidden = true;
      } else {
        bPause.hidden = true; bSkip.hidden = false;
      }
    }
    // 今日番茄清单
    var goalEl = document.getElementById('ftGoal');
    if (goalEl) goalEl.textContent = stat.today + ' / ' + stat.goal;
    var slotsEl = document.getElementById('ftSlots');
    if (slotsEl) {
      var recs2 = Pomo.records().filter(function (r) { return r.date === D.today(); });
      var doneIdx = recs2.map(function (r) { return r.slot; });
      var html = '';
      stat.slots.forEach(function (sub, i) {
        var done = doneIdx.indexOf(i) >= 0;
        var cls = 'ft-slot-name ' + sub;
        html += '<div class="ft-slot' + (done ? ' done' : '') + '">' +
                '<div class="ft-slot-idx">' + (done ? '✓' : (i + 1)) + '</div>' +
                '<div class="ft-slot-main"><div class="' + cls + '">' + Pomo.subjectName(sub) + '</div>' +
                '<div class="ft-slot-desc">45 分钟专注</div></div>' +
                '<div class="ft-slot-state">' + (done ? '已完成' : '待开始') + '</div></div>';
      });
      slotsEl.innerHTML = html;
    }
    // 统计
    var statEl = document.getElementById('ftStats');
    if (statEl) {
      statEl.innerHTML =
        '<div class="ft-stat-cell"><div class="ft-stat-num">' + stat.today + '</div><div class="ft-stat-lb">今日番茄</div></div>' +
        '<div class="ft-stat-cell"><div class="ft-stat-num">' + stat.week + '</div><div class="ft-stat-lb">本周番茄</div></div>' +
        '<div class="ft-stat-cell"><div class="ft-stat-num">' + stat.hours + '</div><div class="ft-stat-lb">累计专注(时)</div></div>';
    }
  }

  // 到点事件分发（真实 tick 与测试推进入口共用，保证提醒/庆祝行为一致）
  function handlePomoResult(r) {
    if (!r) { renderPomo(); return; }
    if (r.event === 'focus-done') {
      pomoNotify('番茄完成！休息 10 分钟');
      celebratePomo();
    } else if (r.event === 'break-done') {
      pomoNotify('休息结束，开始下一个番茄吧');
    }
    renderPomo();
  }

  // 每秒推进时钟：到点处理事件（幂等由 Pomo.tick 保证）
  function pomoTick() {
    handlePomoResult(Pomo.tick());
  }

  function bindPomo() {
    var cd = document.getElementById('focusCountdown');
    if (cd) {
      var days = Math.ceil((new Date(examDate()) - new Date(D.today())) / 86400000);
      var cds = countdownState(days);
      cd.textContent = cds.text;
    }
    var bStart = document.getElementById('ftStart');
    var bPause = document.getElementById('ftPause');
    var bAbandon = document.getElementById('ftAbandon');
    var bSkip = document.getElementById('ftSkip');
    if (bStart) bStart.addEventListener('click', function () {
      Pomo.start(bStart.dataset.subject || 'math', parseInt(bStart.dataset.slot || '0', 10));
      renderPomo();
    });
    if (bPause) bPause.addEventListener('click', function () {
      var s = Pomo.session();
      if (s && s.mode === 'focus') { if (s.paused) Pomo.resume(); else Pomo.pause(); }
      renderPomo();
      pulseClock();
    });
    if (bAbandon) bAbandon.addEventListener('click', function () { Pomo.abandon(); renderPomo(); });
    if (bSkip) bSkip.addEventListener('click', function () { Pomo.skipBreak(); renderPomo(); });

    // 到点提醒：优先 Notification，回退到页面内顶部条 + 短提示音
    pomoNotify = function (msg) {
      try {
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('专注番茄', { body: msg });
        }
      } catch (e) {}
      var tip = document.getElementById('ftTip');
      if (tip) { tip.textContent = '⏰ ' + msg; tip.style.color = 'var(--zhu)'; tip.style.fontWeight = '800'; }
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          var ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = 660; g.gain.value = .12;
          o.start(); o.stop(ctx.currentTime + .35);
        }
      } catch (e) {}
    };
    // 请求通知权限（静默，用户拒绝也不影响）
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}

    // 每秒 tick（仅在专注页可见时渲染，但 tick 全局跑以保证到点记录）
    if (pomoTimer) clearInterval(pomoTimer);
    pomoTimer = setInterval(function () {
      var s = Pomo.session();
      if (!s) return;                    // 无会话不做任何写操作
      pomoTick();
    }, 1000);

    // 离开页面（切后台/锁屏/关闭）自动暂停；回来后保持暂停，需手动点「继续」
    function autoPauseOnLeave() {
      var s = Pomo.session();
      if (s && !s.paused) { Pomo.pause(); renderPomo(); }
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) autoPauseOnLeave();
    });
    window.addEventListener('pagehide', autoPauseOnLeave);

    renderPomo();
  }

  /* ---------- tab 绑定 ---------- */
  // 切到指定 tab（更新高亮 + 渲染 + 引擎切换），供 tab 点击与内部跳转共用
  function switchTab(target) {
    // 错题页无独立底部 tab：进入时保持「我的」高亮，screen 仍切到 wrong
    var hl = (target === 'wrong') ? 'me' : target;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.target === hl);
    });
    if (target === 'today') renderToday();
    if (target === 'practice') renderPractice(practiceSub);
    if (target === 'knowledge') renderKnowledge(document.querySelector('#knowSubs .subtab.active').dataset.sub);
    if (target === 'plan') renderPlan();
    if (target === 'focus') renderPomo();
    if (target === 'wrong') renderWrong(wrongSub);
    if (target === 'me') renderMe();
    engine.go(target);
  }
  function bindTabs() {
    var tabs = [].slice.call(document.querySelectorAll('.tab'));
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        // R3.5：从底部 tab 正常进入时清除上次的看讲解聚焦/翻面态；内部跳转不经过这里
        focusTopic = null; focusFlip = false;
        switchTab(btn.dataset.target);
      });
    });
    bindSubTabs('practiceSubs', renderPractice);
    // R8.2 难度筛选：与科目/考点/段卡筛选叠加
    document.querySelectorAll('#diffTabs .diff-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        practiceDiff = b.dataset.diff;
        document.querySelectorAll('#diffTabs .diff-tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        focusTopic = null; listFilter = null;   // 难度切换清掉旧的考点/段卡筛选，避免矛盾
        var chip = document.getElementById('filterChip'); if (chip) chip.hidden = true;
        renderPractice(practiceSub);
      });
    });
    bindSubTabs('knowSubs', function (s) { focusTopic = null; focusFlip = false; renderKnowledge(s); });
    bindSubTabs('wrongSubs', renderWrong);

    document.getElementById('shuffleBtn').addEventListener('click', function () { practiceSeed++; renderPractice(practiceSub); });
    document.getElementById('clearFilter').addEventListener('click', function () { focusTopic = null; listFilter = null; renderPractice(practiceSub); });
    document.getElementById('rebrushBtn').addEventListener('click', function () { rebrush = !rebrush; renderWrong(wrongSub); });
    document.getElementById('checkinBtn').addEventListener('click', function () {
      if (Store.checkin()) {
        updateHero();
        var b = document.getElementById('checkinBtn');
        if (engine) engine.animateOn(b, [
          { transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }
        ], { duration: 480 });
      }
    });
    document.getElementById('resetBtn').addEventListener('click', function () {
      if (window.confirm('确定清空全部学习数据？此操作不可恢复。')) {
        Store.reset(); renderToday(); renderWrong('all'); renderMe(); renderPlan();
      }
    });
    // R8 「我的」页错题本入口 → 进入错题页（底部保持"我的"高亮）
    var wrongEntry = document.getElementById('wrongEntry');
    if (wrongEntry) wrongEntry.addEventListener('click', function () { switchTab('wrong'); });
    // R8 错题页返回按钮 → 回「我的」页
    var wrongBack = document.getElementById('wrongBack');
    if (wrongBack) wrongBack.addEventListener('click', function () { switchTab('me'); });
    // R6.3 保存考试日 → 倒计时即刻更新
    var examSave = document.getElementById('examSave');
    if (examSave) examSave.addEventListener('click', function () {
      var v = document.getElementById('examInput').value;
      var msg = document.getElementById('examMsg');
      if (Store.setExamDate(v)) {
        msg.textContent = '已保存，倒计时已更新'; msg.className = 'exam-msg ok';
        renderToday(); renderMe();
      } else {
        msg.textContent = '日期格式不正确'; msg.className = 'exam-msg err';
      }
    });
    // R7 导出学习记录 JSON
    var exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      var msg = document.getElementById('backupMsg');
      try {
        var data = Store.exportData();
        var text = JSON.stringify(data, null, 2);
        var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var d = todayStr();
        a.href = url;
        a.download = '专升本学习记录_' + d + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        msg.textContent = '已导出 ' + d + ' 的学习记录，请妥善保存。';
        msg.className = 'backup-msg ok';
      } catch (e) {
        msg.textContent = '导出失败：' + (e && e.message ? e.message : e);
        msg.className = 'backup-msg err';
      }
    });
    // R14 导入备份：选文件 → 校验+摘要 → 用户选合并/覆盖
    var importBtn = document.getElementById('importBtn');
    var importFile = document.getElementById('importFile');
    var importPanel = document.getElementById('importPanel');
    var importData = null;
    function hideImportPanel() { if (importPanel) importPanel.hidden = true; importData = null; }
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function () {
        var f = importFile.files && importFile.files[0];
        if (!f) return;
        var msg = document.getElementById('backupMsg');
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var obj = JSON.parse(String(reader.result));
            if (!obj || obj.app !== '专升本每日修炼') throw new Error('这不是本站导出的备份文件');
            importData = obj;
            var nAns = Array.isArray(obj.answers) ? obj.answers.length : 0;
            var nWrong = obj.wrongs ? Object.keys(obj.wrongs).filter(function (k) { return !obj.wrongs[k].mastered; }).length : 0;
            var nCk = obj.checkins ? Object.keys(obj.checkins).length : 0;
            document.getElementById('ipInfo').textContent =
              '备份时间：' + (obj.exportedAt ? String(obj.exportedAt).slice(0, 10) : '未知') +
              ' · 答题记录 ' + nAns + ' 条 · 错题 ' + nWrong + ' 道 · 打卡 ' + nCk + ' 天';
            importPanel.hidden = false;
            msg.textContent = '已读取备份文件，请选择导入方式。';
            msg.className = 'backup-msg ok';
          } catch (e) {
            hideImportPanel();
            msg.textContent = '导入失败：' + (e && e.message ? e.message : e);
            msg.className = 'backup-msg err';
          }
          importFile.value = '';
        };
        reader.onerror = function () {
          msg.textContent = '文件读取失败，请重试';
          msg.className = 'backup-msg err';
        };
        reader.readAsText(f);
      });
      var doImport = function (mode) {
        if (!importData) return;
        var msg = document.getElementById('backupMsg');
        var r = Store.importData(importData, mode);
        if (r.ok) {
          msg.textContent = r.msg + '：答题记录 ' + r.answers + ' 条、错题 ' + r.wrongs + ' 道。';
          msg.className = 'backup-msg ok';
          hideImportPanel();
          renderMe();
        } else {
          msg.textContent = '导入失败：' + r.msg;
          msg.className = 'backup-msg err';
          hideImportPanel();
        }
      };
      if (importPanel) {
        document.getElementById('ipMerge').addEventListener('click', function () { doImport('merge'); });
        document.getElementById('ipOver').addEventListener('click', function () { doImport('overwrite'); });
        document.getElementById('ipCancel').addEventListener('click', hideImportPanel);
      }
    }
  }
  function bindSubTabs(wrapId, cb) {
    document.querySelectorAll('#' + wrapId + ' .subtab').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#' + wrapId + ' .subtab').forEach(function (x) { x.classList.toggle('active', x === b); });
        cb(b.dataset.sub);
      });
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    engine = new window.EnterEngine();
    engine.register([].slice.call(document.querySelectorAll('.screen')));
    bindQuiz();

    loadBank(function (err) {
      if (err) {
        document.getElementById('supportQs').innerHTML = '<div class="empty-hint">题库加载失败，请通过本地服务器打开</div>';
      } else {
        buildWeekPlan();
        planWeek = currentWeekByExam();   // 计划页默认定位到本周
        renderToday();
        renderPractice('all');
        renderKnowledge('english');
        renderPlan();
        renderWrong('all');
        renderMe();
      }
      bindTabs();
      bindPlan();
      bindPomo();
      engine.boot('today');
      window.__APP_READY__ = true;
      // R6.3 跨零点自动刷新：每分钟检查系统日期，变了就重算当天计划与倒计时
      var lastDay = todayStr();
      setInterval(function () {
        var now = todayStr();
        if (now !== lastDay) {
          lastDay = now;
          try { renderToday(); renderMe(); renderPomo(); } catch (e) {}
        }
      }, 60000);
      // 自检辅助接口
      window.__ZSB_APP__ = {
        buildPlan: buildPlan, renderToday: renderToday, renderMe: renderMe,
        renderKnowledge: renderKnowledge, renderPractice: renderPractice, switchTab: switchTab,
        Store: Store, Memory: Memory,
        countdownState: countdownState,
        intensityFor: intensityFor, PLAN_BASE: PLAN_BASE,
        buildDailyStudy: buildDailyStudy, renderStudy: renderStudy,
        getFocus: function () { return focusTopic; },
        getQB: function () { return QBANK; },
        getWords: function () { return WORDS; },
        getTopics: function () { return TOPICS; },
        // R8.2 难度筛选
        setPracticeDiff: function (d) { practiceDiff = String(d); renderPractice(practiceSub); },
        getPracticeDiff: function () { return practiceDiff; },
        // R7 计划页 / 数据备份
        buildWeekPlan: buildWeekPlan, currentWeekByExam: currentWeekByExam,
        getPlanWeek: function () { return planWeek; },
        setPlanWeek: function (w) { planWeek = Math.max(1, Math.min(WEEK_COUNT, w)); renderPlan(); },
        renderPlan: renderPlan,
        // R11 专注番茄钟
        Pomo: Pomo, renderPomo: renderPomo,
        pomoStart: function (sub, slot) { Pomo.start(sub, slot); renderPomo(); },
        pomoTickAt: function (t) { var r = Pomo.tick(t); handlePomoResult(r); return r; },
        pomoStats: function () { return Pomo.stats(); },
        // R12 错因分类 / 同类题推荐
        similarQuestions: function (q, n) { return similarQuestions(q, n); },
        causeStats: function () { return Store.causeStats(); }
      };
    });
  });
})();
