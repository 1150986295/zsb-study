# -*- coding: utf-8 -*-
R = '/workspace/专升本改版/改版源'
js_path = R + '/js/app.js'
js = open(js_path, encoding='utf-8').read()

SVG = '<svg class="kp-go-ic" viewBox="0 0 24 24"><path d="M4 5.5C7 4 10 4.5 12 6.5c2-2 5-2.5 8-1v13c-3-1.5-6-1-8 1-2-2-5-2.5-8-1v-13z"/><path d="M12 6.5v13"/></svg>'

reps = [
    ("'今日任务已达成，可以打卡 🎉'", "'今日任务已达成，可以打卡 ✦'"),
    ("btn.textContent = '完成打卡 🎉';", "btn.textContent = '完成打卡 ✓';"),
    ('<span class="nt">💡 记忆锚点</span>', '<span class="nt">✦ 记忆锚点</span>'),
    ("📖 相关题目 ' + c.n + ' 道 · 想练再点 →",
     SVG + "相关题目 ' + c.n + ' 道 · 想练再点 →"),
]
n = 0
for old, new in reps:
    if old in js:
        js = js.replace(old, new)
        n += 1
    else:
        print('未命中:', old[:40])
open(js_path, 'w', encoding='utf-8').write(js)
print('JS替换完成: %d/4' % n)

css_path = R + '/css/style.css'
css = open(css_path, encoding='utf-8').read()
marker = "/* =====================================================================\n * R15 深色模式 · 纸墨调（夜刷题场景）"
icon_css = ("/* R15.1 知识页\"相关题目\"按钮书本图标（线性，1.7描边，currentColor随主题） */\n"
            ".kp-go-ic{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.7;"
            "stroke-linecap:round;stroke-linejoin:round;vertical-align:-2px;margin-right:4px}\n\n")
css = css.replace(marker, icon_css + marker)
open(css_path, 'w', encoding='utf-8').write(css)
print('CSS图标样式已加:', 'kp-go-ic' in css)
