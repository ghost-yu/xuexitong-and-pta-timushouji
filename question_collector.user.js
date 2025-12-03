// ==UserScript==
// @name         题目收集助手
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  智能答案提取：优先从答对题目提取正确答案，支持三种平台（超星作业/章节/PTA）
// @author       You
// @match        https://mooc1.chaoxing.com/mooc-ans/mooc2/work/*
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy?*
// @match        https://pintia.cn/problem-sets/*/exam/problems/type/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// ==/UserScript==

(function () {
  'use strict';

  const DB_KEY = 'collectedQuestions';
  const BUTTON_STYLE = 'position:fixed;right:20px;z-index:99999;padding:10px 20px;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:16px;box-shadow:0 2px 5px rgba(0,0,0,0.3);';

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeAnswer(answer) {
    const text = normalizeText(answer);
    if (!text) return '';
    const letters = text.toUpperCase().match(/[A-Z]/g);
    if (letters && letters.length > 0) return letters.join('');
    if (/正确|对|TRUE/i.test(text)) return 'T';
    if (/错误|错|FALSE/i.test(text)) return 'F';
    return text;
  }

  function getQuestions() {
    return GM_getValue(DB_KEY, []);
  }

  function saveQuestions(questions) {
    GM_setValue(DB_KEY, questions);
    updateCountDisplay();
  }

  function mergeQuestions(existing, incoming) {
    const map = new Map();
    [...existing, ...incoming].forEach((q) => {
      if (!q || !q.title) return;
      const title = normalizeText(q.title);
      const options = Array.isArray(q.options) ? q.options.map(normalizeText) : [];
      const answer = normalizeAnswer(q.answer);
      const key = `${q.type}|${title}|${options.join('||')}|${answer}|${q.source}`;
      if (!map.has(key)) {
        map.set(key, { ...q, title, options, answer });
      }
    });
    return Array.from(map.values());
  }

  function updateCountDisplay() {
    const btn = document.querySelector('[data-role="count-btn"]');
    if (btn) btn.textContent = `题库: ${getQuestions().length}`;
  }

  function createButtons() {
    console.log('createButtons() 被调用');

    // 等待页面body加载完成
    if (!document.body) {
      console.log('document.body 未就绪，延迟执行');
      setTimeout(createButtons, 100);
      return;
    }

    const configs = [
      { text: '收集题目', top: 20, color: '#4CAF50', handler: collectQuestions },
      { text: '打开学习页', top: 70, color: '#5842a5ff', handler: openStudyPage },
      { text: ' 清空题库', top: 120, color: '#f44336', handler: clearQuestions },
      { text: `题库: ${getQuestions().length}`, top: 170, color: '#2196F3', handler: showStats, role: 'count-btn' },
      { text: '导出JSON', top: 220, color: '#9eab29ff', handler: exportToJSON },
      { text: '导入JSON', top: 270, color: '#cb75dbff', handler: importFromJSON },
      { text: '保存HTML(以后可以一直通过这个使用)', top: 320, color: '#00BCD4', handler: saveAsHTML }
    ];

    configs.forEach((cfg) => {
      const btn = document.createElement('button');
      btn.textContent = cfg.text;
      btn.style.cssText = `${BUTTON_STYLE}top:${cfg.top}px;background:${cfg.color};`;
      if (cfg.role) btn.dataset.role = cfg.role;
      btn.onclick = cfg.handler;
      document.body.appendChild(btn);
      // console.log(`按钮已创建: ${cfg.text}`);
    });

    // console.log('所有按钮创建完成');
  }

  function getOptionPrefix(label, fallbackIndex) {
    const candidates = label ? label.querySelectorAll('span') : [];
    for (const span of candidates) {
      const text = normalizeText(span.textContent).replace(/\./g, '');
      if (/^[A-Z]$/.test(text)) return text;
    }
    const raw = normalizeText(label?.textContent || '');
    const match = raw.match(/^([A-Z])[\.、．。\s]/i);
    if (match) return match[1].toUpperCase();
    if (fallbackIndex >= 0 && fallbackIndex < 26) return String.fromCharCode(65 + fallbackIndex);
    return '';
  }

  function collectChaoxingWork() {
    return Array.from(document.querySelectorAll('.questionLi')).map((item) => {
      const titleEl = item.querySelector('.mark_name .qtContent') || item.querySelector('h3');
      if (!titleEl) return null;

      const typeText = item.querySelector('.colorShallow')?.textContent || '';
      let type = 'single';
      if (typeText.includes('多选')) type = 'multiple';
      else if (typeText.includes('判断')) type = 'judge';

      const options = Array.from(item.querySelectorAll('.mark_letter li, .answer_option li')).map((opt) => normalizeText(opt.textContent));

      // 作业页答案提取逻辑
      let answerText = '';
      const isCorrect = item.querySelector('.marking_dui') !== null;

      // 1. 如果答对了，优先使用"我的答案"（因为答对了，我的答案就是正确答案）
      if (isCorrect) {
        const myAnswerEl = item.querySelector('.stuAnswerContent');
        if (myAnswerEl) {
          answerText = myAnswerEl.textContent;
          console.log(`  作业页-答对题目，使用我的答案: ${answerText}`);
        }
      }

      // 2. 否则从"正确答案"区提取
      if (!answerText) {
        const correctAnswerEl = item.querySelector('.rightAnswerContent, .check_answer');
        if (correctAnswerEl) {
          answerText = correctAnswerEl.textContent;
          console.log(`  作业页-从正确答案区提取: ${answerText}`);
        }
      }

      // 3. 文本匹配兜底
      if (!answerText) {
        const textContent = item.textContent;
        const match = textContent.match(/正确答案[:：]\s*([A-Z]+|√|×|对|错)/i);
        if (match) answerText = match[1];
      }

      const answer = normalizeAnswer(answerText);
      const title = normalizeText(titleEl.textContent);

      return {
        type,
        title,
        options,
        answer,
        source: '超星作业'
      };
    }).filter(Boolean);
  }

  function extractQuestionsFromDoc(doc, questions, isStudyPage = false) {
    if (!doc) return;

    // 尝试多组选择器（覆盖不同版本的学习通题目容器）
    const selectors = [
      '.questionLi',           // 标准题目容器
      '.TiMu.newTiMu',         // 新版题目容器（章节检测）
      '.TiMu',                 // 旧版容器
      '.ans-cc.singleQuesId',  // 答题卡容器
      '.answerBg',             // 答题区
      '.Zy_TItle',             // 作业标题
      '.singleQ',              // 单选题
      '.duoQ',                 // 多选题
      '.panQ',                 // 判断题
      '[class*="question"]',   // 包含 question 的容器
      'div[id*="question"]',   // ID 包含 question
      '.examPaper_title',      // 试卷题目
      '.subject',              // 题目主体
      'ul.clearfix li',        // 列表题目
      '.work',                 // 作业容器
      '.workLibrary',          // 题库
      'div[class*="work"]',    // 包含 work 的容器
      'div[id*="work"]',       // ID 包含 work
      '.exam',                 // 考试容器
      'div[class*="exam"]',    // 包含 exam 的容器
      '.topic',                // 话题/题目
      'li[class*="topic"]'     // 话题列表项
    ];

    let items = [];
    let usedSelector = '';
    for (const selector of selectors) {
      items = Array.from(doc.querySelectorAll(selector));
      if (items.length > 0) {
        usedSelector = selector;
        break;
      }
    }

    if (items.length === 0) {
      // 没找到题目容器，记录调试信息
      console.log('未找到题目容器，尝试的选择器:', selectors.join(', '));
      return;
    }

    console.log(`使用选择器 "${usedSelector}" 找到 ${items.length} 个题目容器`);

    items.forEach((item) => {
      // 检查是否答对（用于优先提取答案）
      const isCorrect = item.querySelector('.marking_dui') !== null;
      const isWrong = item.querySelector('.marking_cuo') !== null;

      // 多种题目标题选择器
      let titleEl = item.querySelector('.Zy_TItle .qtContent') ||           // 新版章节检测
        item.querySelector('.mark_name .qtContent') ||                      // 作业页
        item.querySelector('.stem_answer') ||
        item.querySelector('.questionContent') ||
        item.querySelector('.timu') ||
        item.querySelector('h3') ||
        item.querySelector('[class*="title"]');

      if (!titleEl) return;

      // 提取题目标题（去除题型标签）
      let titleText = normalizeText(titleEl.textContent);
      // 去除【单选题】【多选题】【判断题】等标签
      titleText = titleText.replace(/^【[^】]+】\s*/, '');

      // 判断题目类型
      const typeText = item.querySelector('.newZy_TItle, .colorShallow')?.textContent || '';
      let type = 'single';
      if (typeText.includes('多选') || item.classList.contains('duoQ')) type = 'multiple';
      else if (typeText.includes('判断') || item.classList.contains('panQ')) type = 'judge';
      else if (item.querySelectorAll('input[type="checkbox"]').length > 0) type = 'multiple';

      // 提取选项（尝试多种选择器）
      const optionSelectors = [
        '.Zy_ulTop.qtDetail > li',   // 新版章节检测选项
        '.mark_letter li',           // 标准选项
        '.answerBg ul li',           // 答题区列表
        'label[class*="option"]',    // label 选项
        'ul.answer li',              // 答案列表
        '.stem_answer .answer_option li', // 题干答案选项
        'ul li[id*="answer"]',       // ID 包含 answer
        '.option',                   // 简单 option class
        'li[class*="option"]',       // li 包含 option
        'ul li',                     // 通用列表项（最后兜底）
      ];

      let optionNodes = [];
      for (const selector of optionSelectors) {
        optionNodes = Array.from(item.querySelectorAll(selector));
        if (optionNodes.length >= 2) { // 至少2个选项才算有效
          console.log(`  使用选项选择器: ${selector}, 找到 ${optionNodes.length} 个选项`);
          break;
        }
      }

      // 提取选项文本（处理新版格式：i标签 + a标签）
      const options = optionNodes.map((li) => {
        // 新格式：<li><i>A、</i><a>选项内容</a></li>
        const optionLabel = li.querySelector('i')?.textContent || '';
        const optionContent = li.querySelector('a')?.textContent || li.textContent || '';

        // 如果有分离的标签和内容，组合它们
        if (optionLabel && optionContent && optionLabel !== optionContent) {
          return normalizeText(optionLabel + ' ' + optionContent);
        }

        // 否则使用完整文本
        return normalizeText(li.textContent);
      }).filter(Boolean);

      // 提取答案：优先从答对题目的"我的答案"提取，其次从"正确答案"区提取
      let answerText = '';
      let answerSource = '';

      // 1. 如果答对了，优先从"我的答案"提取（因为答对了，我的答案就是正确答案）
      if (isCorrect && isStudyPage) {
        const myAnswerEl = item.querySelector('.myAnswer .answerCon');
        if (myAnswerEl) {
          answerText = myAnswerEl.textContent;
          answerSource = '我的答案(已答对)';
        }
      }

      // 2. 从"正确答案"区提取
      if (!answerText) {
        const correctAnswerEl = item.querySelector(
          '.rightAnswerContent, .answer, [class*="rightAnswer"], .check_answer, .answer_p, .daan'
        );
        if (correctAnswerEl) {
          answerText = correctAnswerEl.textContent;
          answerSource = '正确答案区';
        }
      }      // 文本匹配兜底
      if (!answerText) {
        const textContent = item.textContent;
        const match = textContent.match(/(?:正确答案|我的答案)[:：\s]*([A-Z]+|√|×|对|错|true|false)/i);
        if (match) answerText = match[1];
      }

      let answer = normalizeAnswer(answerText);

      // 从已选中的 input 推断答案
      if (!answer) {
        const checked = Array.from(item.querySelectorAll('input:checked')).map((input) => {
          const label = input.closest('label') || input.parentElement;
          const labelText = normalizeText(label?.textContent || '');
          // 尝试提取选项字母
          const match = labelText.match(/^([A-Z])[\.、\s]/);
          return match ? match[1] : '';
        }).filter(Boolean);
        answer = normalizeAnswer(checked.join(''));
      }

      questions.push({
        type,
        title: titleText,  // 使用清理后的标题
        options,
        answer,
        source: '超星章节'
      });

      // 日志输出
      if (answer) {
        console.log(`  ✓ 收集题目: ${titleText.substring(0, 30)}... [答案: ${answer}${answerSource ? ' 来源:' + answerSource : ''}]`);
      } else {
        console.log(`  ✓ 收集题目: ${titleText.substring(0, 30)}... [无答案]`);
      }
    });
  }  // 等待 iframe 加载完成
  function waitForIframeLoad(iframe, timeout = 3000) {
    return new Promise((resolve) => {
      if (!iframe) {
        resolve(false);
        return;
      }

      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.readyState === 'complete') {
          resolve(true);
          return;
        }
      } catch (e) {
        resolve(false);
        return;
      }

      let timeoutId = setTimeout(() => {
        console.log('iframe 加载超时');
        resolve(false);
      }, timeout);

      iframe.addEventListener('load', () => {
        clearTimeout(timeoutId);
        console.log('iframe 加载完成');
        resolve(true);
      }, { once: true });
    });
  }

  function collectChaoxingChapter() {
    const questions = [];
    // 检查是否是章节检测页面（studentstudy）
    const isStudyPage = location.href.includes('/mycourse/studentstudy');

    console.log('开始收集超星章节题目...');
    if (isStudyPage) {
      console.log(' 检测到章节检测页面（studentstudy），将优先从答对题目提取答案');
    }
    console.log('提示: 如果页面刚打开，可能需要等待几秒让 iframe 加载完成');

    // 先尝试在主文档中查找
    console.log('在主文档中查找题目...');
    extractQuestionsFromDoc(document, questions, isStudyPage);
    console.log(`主文档中找到 ${questions.length} 道题`);

    // 优先查找主 iframe（id="iframe"）
    const mainIframe = document.querySelector('#iframe, iframe[id="iframe"]');
    if (mainIframe) {
      console.log('找到主 iframe (#iframe)，优先处理...');
      try {
        const mainDoc = mainIframe.contentDocument || mainIframe.contentWindow?.document;
        if (mainDoc) {
          const beforeCount = questions.length;
          extractQuestionsFromDoc(mainDoc, questions, isStudyPage);
          console.log(`主 iframe 找到 ${questions.length - beforeCount} 道题`);

          // 在主 iframe 中递归查找嵌套 iframe
          const nestedIframes = mainDoc.querySelectorAll('iframe');
          console.log(`主 iframe 内有 ${nestedIframes.length} 个嵌套 iframe`);
          nestedIframes.forEach((nestedIframe, nestedIndex) => {
            try {
              const nestedDoc = nestedIframe.contentDocument || nestedIframe.contentWindow?.document;
              if (nestedDoc) {
                const beforeNestedCount = questions.length;
                extractQuestionsFromDoc(nestedDoc, questions, isStudyPage);
                console.log(`嵌套 iframe ${nestedIndex} 找到 ${questions.length - beforeNestedCount} 道题`);
              }
            } catch (e) {
              console.log(`嵌套 iframe ${nestedIndex} 跨域无法访问`);
            }
          });
        } else {
          console.log('主 iframe 文档为空，可能未加载完成');
        }
      } catch (e) {
        console.log('主 iframe 跨域无法访问:', e.message);
      }
    } else {
      console.log('未找到主 iframe (#iframe)');
    }

    // 查找所有其他 iframe
    const allIframes = document.querySelectorAll('iframe:not(#iframe)');
    console.log(`找到 ${allIframes.length} 个其他 iframe`);

    allIframes.forEach((iframe, index) => {
      try {
        let doc = null;
        try {
          doc = iframe.contentDocument || iframe.contentWindow?.document;
        } catch (e) {
          console.log(`iframe ${index} 跨域无法访问`);
          return;
        }
        if (!doc) {
          console.log(`iframe ${index} 文档为空`);
          return;
        }

        console.log(`正在处理 iframe ${index}...`);
        const beforeCount = questions.length;

        // 在当前 iframe 文档中查找题目
        extractQuestionsFromDoc(doc, questions, isStudyPage);
        console.log(`iframe ${index} 找到 ${questions.length - beforeCount} 道题`);

        // 递归查找嵌套 iframe（学习通章节页常用嵌套结构）
        const nestedIframes = doc.querySelectorAll('iframe');
        if (nestedIframes.length > 0) {
          console.log(`iframe ${index} 内有 ${nestedIframes.length} 个嵌套 iframe`);
        }

        nestedIframes.forEach((nestedIframe, nestedIndex) => {
          try {
            let nestedDoc = null;
            try {
              nestedDoc = nestedIframe.contentDocument || nestedIframe.contentWindow?.document;
            } catch (e) {
              console.log(`嵌套 iframe ${index}-${nestedIndex} 跨域无法访问`);
              return;
            }
            if (nestedDoc) {
              const beforeNestedCount = questions.length;
              extractQuestionsFromDoc(nestedDoc, questions, isStudyPage);
              console.log(`嵌套 iframe ${index}-${nestedIndex} 找到 ${questions.length - beforeNestedCount} 道题`);
            }
          } catch (err) {
            console.warn(`访问嵌套 iframe ${index}-${nestedIndex} 失败:`, err);
          }
        });
      } catch (err) {
        console.warn(`访问章节 iframe ${index} 失败:`, err);
      }
    });

    console.log(`章节收集完成，共找到 ${questions.length} 道题`);
    if (isStudyPage) {
      const withAnswer = questions.filter(q => q.answer).length;
      const noAnswer = questions.length - withAnswer;
      console.log(`✅ 收集完成：${withAnswer} 道有答案，${noAnswer} 道无答案`);
    }
    return questions;
  }

  function collectPTA() {
    console.log('开始收集 PTA 题目...');
    console.log('当前URL:', location.href);

    const typeMatch = location.href.match(/type\/(\d+)/);
    const typeId = typeMatch ? parseInt(typeMatch[1], 10) : 0;
    let type = 'single';
    if (typeId === 1) type = 'judge';
    else if (typeId === 2) type = 'single';
    else if (typeId === 3) type = 'multiple';
    else if (typeId === 6) type = 'completion'; // 函数题
    else if (typeId === 7 || typeId === 8) type = 'programming';

    console.log(`题目类型ID: ${typeId}, 类型: ${type}`);

    // 尝试多种容器选择器，覆盖列表模式和单题模式
    const containerSelectors = [
      '.pc-x[id]', // 列表模式常见容器
      '.pc-x.pt-2.pl-4',
      '[class*="pc-x"][id]',
      '.problem-view', // 可能的单题容器
      'div[class*="Problem_"]', // 备用
      '[id^="problem_"]', // ID以problem_开头
      '.problem-content' // 题目内容区
    ];

    let containers = [];
    let usedSelector = '';
    for (const selector of containerSelectors) {
      containers = Array.from(document.querySelectorAll(selector));
      if (containers.length) {
        usedSelector = selector;
        break;
      }
    }

    // 如果没找到容器，尝试直接查找题目内容区域（针对单题页面）
    if (!containers.length) {
      console.log('未找到题目容器，尝试查找主内容区...');
      const mainContent = document.querySelector('.main-content, [role="main"]');
      if (mainContent) {
        containers = [mainContent];
        usedSelector = '主内容区';
      }
    }

    console.log(`使用选择器 "${usedSelector}" 找到 ${containers.length} 个题目容器`);

    return containers.map((container) => {
      // 提取题目文本（题干）
      // 优先找标题 h4，如果没有则找 markdown 内容
      const titleEl = container.querySelector('h4[id], h4, .title');
      const bodyEl = container.querySelector('.rendered-markdown, .markdown-body, [class*="markdown"]');

      let title = '';
      if (titleEl) title += normalizeText(titleEl.textContent) + '\n';
      if (bodyEl && type === 'programming') {
        // 编程题收集完整题干
        title += normalizeText(bodyEl.textContent);
      } else if (!titleEl && bodyEl) {
        title += normalizeText(bodyEl.textContent);
      }

      title = title.trim();
      if (!title) return null;

      if (type === 'programming' || type === 'completion') {
        return { type: 'programming', title, options: [], answer: '', source: 'PTA' };
      }

      const options = [];
      let answer = '';

      // 检查评测结果（判断是否答对）
      const judgeResult = container.querySelector('.grid.gap-4');
      let isCorrectAnswer = false;
      if (judgeResult) {
        const resultText = judgeResult.textContent || '';
        if (resultText.includes('答案正确') || resultText.includes('正确')) {
          isCorrectAnswer = true;
          console.log('  PTA-检测到答案正确');
        }
      }

      // 查找选项 Label
      const labels = Array.from(container.querySelectorAll('label')).filter((label) =>
        label.querySelector('input[type="radio"], input[type="checkbox"]'));

      labels.forEach((label, index) => {
        const prefix = getOptionPrefix(label, index);
        // 提取选项内容，移除开头的 A. B. 等
        const contentNode = label.querySelector('.rendered-markdown, [class*="markdown"], .break-words');
        let content = normalizeText((contentNode || label).textContent);

        // 移除开头的 A. B. 或 A、 B、
        content = content.replace(/^[A-Z][\.\、\．\。\s]+/, '').trim();

        const optionText = prefix ? `${prefix}. ${content}` : content;
        options.push(optionText);

        const input = label.querySelector('input');
        if (input && input.checked) {
          // 如果答对了，已选的就是正确答案
          if (isCorrectAnswer) {
            if (type === 'multiple') {
              answer += prefix;
            } else {
              answer = prefix;
            }
          }
        }
      });

      // 如果答对了但没有找到选中的答案（可能是已提交的题目），记录无答案
      if (isCorrectAnswer && !answer) {
        console.log('  PTA-答对但未找到已选答案');
      }

      // 处理判断题可能没有 Label 的情况（或者 Label 结构不同）
      if (type === 'judge' && options.length === 0) {
        const tfRadios = container.querySelectorAll('input[type="radio"]');
        if (tfRadios.length) {
          // 构造标准的 T/F 选项
          options.push('T', 'F');
          const checked = Array.from(tfRadios).find((radio) => radio.checked);
          // 只有答对了才记录答案
          if (checked && isCorrectAnswer) {
            // 尝试从 value 或旁边的文本判断是 T 还是 F
            const val = (checked.value || '').toLowerCase();
            const nextText = normalizeText(checked.nextSibling?.textContent || checked.parentElement?.textContent);
            if (val.includes('true') || nextText.includes('对') || nextText.includes('正确')) answer = 'T';
            else answer = 'F';
          }
        }
      }

      return {
        type,
        title,
        options,
        answer: normalizeAnswer(answer),
        source: 'PTA'
      };
    }).filter(Boolean);
  }

  function collectQuestions() {
    console.log('=== 开始收集题目 ===');
    const url = location.href;
    console.log('当前URL:', url);

    let newQuestions = [];
    try {
      if (url.includes('mooc1.chaoxing.com/mooc-ans/mooc2/work/')) {
        console.log('检测到超星作业页面');
        newQuestions = collectChaoxingWork();
      } else if (url.includes('mooc1.chaoxing.com/mycourse/studentstudy')) {
        console.log('检测到超星章节页面');
        newQuestions = collectChaoxingChapter();
      } else if (url.includes('pintia.cn/problem-sets/')) {
        console.log('检测到 PTA 页面');
        newQuestions = collectPTA();
      } else {
        console.warn('当前页面不在支持范围内');
        alert('当前页面不支持题目收集\n\n支持的页面：\n1. 超星学习通作业页面\n2. 超星学习通章节检测页面\n3. PTA 题目页面');
        return;
      }
    } catch (error) {
      console.error('收集题目时出错:', error);
      alert(`收集题目时出错：${error.message}\n\n请查看浏览器控制台了解详情`);
      return;
    }

    console.log(`本次收集到 ${newQuestions.length} 道题目`);

    if (newQuestions.length === 0) {
      console.warn('未收集到任何题目');

      // 特殊提示：章节检测页面
      if (url.includes('mooc1.chaoxing.com/mycourse/studentstudy')) {
        alert('未收集到题目\n\n 作者实在搞不懂它逻辑 每次都收集不了 我放弃了');
      } else {
        alert('未收集到题目\n\n可能原因：\n选择器变了 自己改选择器吧');
      }
      return;
    }

    const existing = getQuestions();
    const merged = mergeQuestions(existing, newQuestions);
    const added = merged.length - existing.length;
    saveQuestions(merged);

    console.log(`题库更新完成 - 新增: ${added}, 总计: ${merged.length}`);
    alert(` 收集成功！\n\n 本次收集: ${newQuestions.length} 道\n新增: ${added} 道\n 题库总计: ${merged.length} 道`);
  }

  function openStudyPage() {
    const questions = getQuestions();
    if (!questions.length) {
      alert('题库为空，先收集题目再试');
      return;
    }
    const html = generateStudyPage(questions);
    const blob = new Blob([html], { type: 'text/html' });
    GM_openInTab(URL.createObjectURL(blob));
  }

  function clearQuestions() {
    if (confirm('确认清空题库？此操作不可恢复')) {
      saveQuestions([]);
      alert('题库已清空');
    }
  }

  function showStats() {
    const qs = getQuestions();
    const stats = {
      single: qs.filter((q) => q.type === 'single').length,
      multiple: qs.filter((q) => q.type === 'multiple').length,
      judge: qs.filter((q) => q.type === 'judge').length,
      programming: qs.filter((q) => q.type === 'programming').length
    };
    alert(`题库统计\n总计: ${qs.length}\n单选: ${stats.single}\n多选: ${stats.multiple}\n判断: ${stats.judge}\n编程: ${stats.programming}`);
  }

  function exportToJSON() {
    const questions = getQuestions();
    if (!questions.length) {
      alert('题库为空，无法导出');
      return;
    }
    const data = {
      version: '1.2',
      exportTime: new Date().toISOString(),
      totalCount: questions.length,
      questions
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `题库_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
  }

  function importFromJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (evt) => {
      const file = evt.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target?.result);
          if (!data.questions || !Array.isArray(data.questions)) {
            alert('JSON 文件缺少 questions 数组');
            return;
          }
          const existing = getQuestions();
          const merged = mergeQuestions(existing, data.questions);
          const replace = confirm('确定=合并题库，取消=完全替换');
          if (replace) {
            saveQuestions(merged);
            alert(`合并完成，当前题库 ${merged.length} 道`);
          } else {
            saveQuestions(data.questions);
            alert(`已覆盖导入 ${data.questions.length} 道题`);
          }
        } catch (err) {
          alert(`JSON 解析失败: ${err.message}`);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function saveAsHTML() {
    const questions = getQuestions();
    if (!questions.length) {
      alert('题库为空，无法保存 HTML');
      return;
    }
    const html = generateStudyPage(questions);
    const blob = new Blob([html], { type: 'text/html' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `题目学习系统_${new Date().toISOString().slice(0, 10)}.html`;
    link.click();
  }

  function generateStudyPage(questions) {
    const stats = {
      single: questions.filter((q) => q.type === 'single').length,
      multiple: questions.filter((q) => q.type === 'multiple').length,
      judge: questions.filter((q) => q.type === 'judge').length,
      programming: questions.filter((q) => q.type === 'programming').length
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>题目学习系统</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;padding:20px;background:#f5f5f5;line-height:1.6}
.container{max-width:900px;margin:0 auto;background:#fff;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
h1{text-align:center;color:#333;margin-bottom:30px}
.stats{background:#e3f2fd;padding:15px;border-radius:5px;margin-bottom:20px;text-align:center}
.filter-buttons,.controls{text-align:center;margin:20px 0}
.btn{padding:8px 20px;margin:5px;border:none;border-radius:5px;cursor:pointer;font-size:14px;color:#fff}
.btn-primary{background:#2196F3}
.btn-success{background:#4CAF50}
.btn-warning{background:#ff9800}
.btn:hover{opacity:0.9}
.question{background:#fafafa;padding:20px;margin-bottom:20px;border-radius:8px;border-left:4px solid #2196F3}
.question-title{font-weight:bold;margin-bottom:15px;font-size:16px;color:#333}
.question-type{display:inline-block;padding:3px 10px;background:#2196F3;color:#fff;border-radius:3px;font-size:12px;margin-right:10px}
.source{display:inline-block;padding:3px 10px;background:#4CAF50;color:#fff;border-radius:3px;font-size:12px}
.options{margin:15px 0}
.option{padding:10px;margin:5px 0;background:#fff;border:1px solid #ddd;border-radius:5px;cursor:pointer;transition:all 0.3s}
.option:hover{background:#e3f2fd;border-color:#2196F3}
.option.selected{background:#bbdefb;border-color:#2196F3}
.option.correct{background:#c8e6c9;border-color:#4CAF50}
.option.wrong{background:#ffcdd2;border-color:#f44336}
.answer-section{margin-top:15px;padding:10px;background:#fff3e0;border-radius:5px;display:none}
.answer-section.show{display:block}
.result{text-align:center;padding:15px;margin:10px 0;border-radius:5px;font-weight:bold}
.result.correct{background:#c8e6c9;color:#2e7d32}
.result.wrong{background:#ffcdd2;color:#c62828}
pre{white-space:pre-wrap;font-family:Consolas,monospace;background:#f5f5f5;padding:10px;border-radius:5px}
</style>
</head>
<body>
<div class="container">
<h1> ..难以评价</h1>
<div class="stats">
<p>共 <strong>${questions.length}</strong> 道题 | 单选 ${stats.single} | 多选 ${stats.multiple} | 判断 ${stats.judge} | 编程 ${stats.programming}</p>
</div>
<div class="filter-buttons">
<button class="btn btn-primary" onclick="filterQuestions('all')">全部</button>
<button class="btn btn-primary" onclick="filterQuestions('single')">单选</button>
<button class="btn btn-primary" onclick="filterQuestions('multiple')">多选</button>
<button class="btn btn-primary" onclick="filterQuestions('judge')">判断</button>
<button class="btn btn-primary" onclick="filterQuestions('programming')">编程</button>
</div>
<div class="controls">
<button class="btn btn-warning" onclick="shuffleAll()"> 打乱选项</button>
<button class="btn btn-success" onclick="resetAll()"> 重置</button>
</div>
<div id="questions"></div>
</div>
<script>
const questions=${JSON.stringify(questions)};
let currentFilter='all';
let userAnswers={};

function getFilteredQuestions(){
  return currentFilter==='all'?questions:questions.filter(q=>q.type===currentFilter);
}

function renderQuestions(){
  const container=document.getElementById('questions');
  container.innerHTML='';
  const filtered=getFilteredQuestions();
  filtered.forEach((q,idx)=>{
    const div=document.createElement('div');
    div.className='question';
    const typeMap={single:'单选题',multiple:'多选题',judge:'判断题',programming:'编程题'};
    let html='<div class="question-title">'+
      '<span class="question-type">'+(typeMap[q.type]||'题目')+'</span>'+
      '<span class="source">'+(q.source||'')+'</span>'+
      (q.type==='programming'?'':'<div style="margin-top:10px">'+(q.title||'')+'</div>')+
      '</div>';
    if(q.type==='programming'){
      html+='<pre>'+ (q.title||'') +'</pre>';
    }else{
      html+='<div class="options">';
      q.options.forEach((opt,i)=>{
        html+='<div class="option" data-q="'+idx+'" data-idx="'+i+'" data-type="'+q.type+'">'+(opt||'')+'</div>';
      });
      html+='</div>';
    }
    if(q.answer){
      html+='<div style="margin-top:10px">'+
        '<button class="btn btn-primary" data-action="check" data-q="'+idx+'">提交答案</button>'+
        '<button class="btn btn-success" data-action="show" data-q="'+idx+'">显示答案</button>'+
        '</div>'+
        '<div class="answer-section" id="answer-'+idx+'">'+
        '<strong>正确答案:</strong> '+(q.answer||'')+
        '<div id="result-'+idx+'"></div>'+
        '</div>';
    }
    div.innerHTML=html;
    container.appendChild(div);
  });
  bindOptionEvents();
  bindActionButtons();
}

function bindOptionEvents(){
  document.querySelectorAll('.option').forEach((opt)=>{
    opt.addEventListener('click',()=>{
      const qIdx=Number(opt.getAttribute('data-q'));
      const optIdx=Number(opt.getAttribute('data-idx'));
      const type=opt.getAttribute('data-type');
      selectOption(qIdx,optIdx,type);
    });
  });
}

function bindActionButtons(){
  document.querySelectorAll('[data-action="check"]').forEach((btn)=>{
    btn.addEventListener('click',()=>checkAnswer(Number(btn.getAttribute('data-q'))));
  });
  document.querySelectorAll('[data-action="show"]').forEach((btn)=>{
    btn.addEventListener('click',()=>showAnswer(Number(btn.getAttribute('data-q'))));
  });
}

function selectOption(qIdx,optIdx,type){
  const question=document.querySelectorAll('.question')[qIdx];
  const options=question.querySelectorAll('.option');
  if(type==='multiple'){
    options[optIdx].classList.toggle('selected');
    const selected=[];
    options.forEach((opt,i)=>{if(opt.classList.contains('selected')) selected.push(i);});
    userAnswers[qIdx]=selected;
  }else{
    options.forEach((opt)=>opt.classList.remove('selected'));
    options[optIdx].classList.add('selected');
    userAnswers[qIdx]=optIdx;
  }
}

function getCorrectIndices(q){
  if(!q.answer) return [];
  const letters=q.answer.toUpperCase().match(/[A-Z]/g);
  if(!letters) return [];
  return letters.map((letter)=>q.options.findIndex((opt)=>opt.toUpperCase().trim().startsWith(letter))).filter((idx)=>idx>=0);
}

function checkAnswer(idx){
  const filtered=getFilteredQuestions();
  const q=filtered[idx];
  const userAnswer=userAnswers[idx];
  if(userAnswer===undefined || (Array.isArray(userAnswer) && !userAnswer.length)){
    alert('请先选择答案');
    return;
  }
  const question=document.querySelectorAll('.question')[idx];
  const options=question.querySelectorAll('.option');
  const resultDiv=document.getElementById('result-'+idx);
  const correctIndices=getCorrectIndices(q);
  if(!correctIndices.length){
    alert('该题没有可判定的标准答案');
    return;
  }
  let isCorrect=false;
  if(q.type==='multiple'){
    const sortedUser=[...userAnswer].sort();
    const sortedCorrect=[...correctIndices].sort();
    isCorrect=sortedUser.length===sortedCorrect.length && sortedUser.every((val,i)=>val===sortedCorrect[i]);
    options.forEach((opt,i)=>{
      opt.classList.remove('correct','wrong');
      if(correctIndices.includes(i)) opt.classList.add('correct');
      else if(userAnswer.includes(i)) opt.classList.add('wrong');
    });
  }else{
    const correctIndex=correctIndices[0];
    isCorrect=userAnswer===correctIndex;
    options.forEach((opt,i)=>{
      opt.classList.remove('correct','wrong');
      if(i===correctIndex) opt.classList.add('correct');
      else if(i===userAnswer) opt.classList.add('wrong');
    });
  }
  resultDiv.innerHTML='<div class="result '+(isCorrect?'correct':'wrong')+'">'+(isCorrect?'✓ 回答正确':'✗ 回答错误')+'</div>';
  document.getElementById('answer-'+idx).classList.add('show');
}

function showAnswer(idx){
  const panel=document.getElementById('answer-'+idx);
  if(panel) panel.classList.add('show');
}

function filterQuestions(type){
  currentFilter=type;
  userAnswers={};
  renderQuestions();
}

function shuffleArray(arr){
  const copy=[...arr];
  for(let i=copy.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy;
}

function splitOption(option,fallbackIndex){
  const text=typeof option==='string'?option:'';
  // 匹配 "A. 内容" 或 "A 内容" 或 "A. 内容"（各种分隔符）
  const match=text.match(/^\s*([A-Z])[\.\、．。\s]+(.*)$/i);
  if(match){
    // 清理 body，移除开头可能残留的点号和空格
    const body=match[2].trim().replace(/^[\.\、．。\s]+/, '');
    return {letter:match[1].toUpperCase(),body:body};
  }
  // 如果没匹配到，可能整个就是内容（没有字母前缀）
  // 也要清理可能的前缀残留
  const cleanBody=text.trim().replace(/^[\.\、．。\s]+/, '');
  return {letter:String.fromCharCode(65+fallbackIndex),body:cleanBody};
}

function shuffleQuestionOptions(question){
  if(question.type==='programming' || question.type==='judge') return;
  if(!Array.isArray(question.options) || question.options.length<2) return;
  const parsed=question.options.map((opt,idx)=>{
    const {letter,body}=splitOption(opt,idx);
    const normalizedLetter=letter || String.fromCharCode(65+idx);
    const isCorrect=(question.answer||'').includes(normalizedLetter);
    return {body,letter:normalizedLetter,isCorrect};
  });
  const shuffled=shuffleArray(parsed);
  const newAnswerLetters=[];
  question.options=shuffled.map((item,idx)=>{
    const newLetter=String.fromCharCode(65+idx);
    if(item.isCorrect){
      newAnswerLetters.push(newLetter);
    }
    const body=item.body;
    return body ? newLetter + '. ' + body : newLetter + '.';
  });
  if(question.answer){
    if(question.type==='multiple'){
      question.answer=newAnswerLetters.join('');
    }else{
      question.answer=newAnswerLetters[0]||'';
    }
  }
}

function shuffleAll(){
  questions.forEach((q)=>{
    shuffleQuestionOptions(q);
  });
  userAnswers={};
  renderQuestions();
  alert('所有选项已随机打乱');
}

function resetAll(){
  location.reload();
}

renderQuestions();
</script>
</body>
</html>`;
  }

  // 确保在页面加载完成后创建按钮
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('DOMContentLoaded 事件触发');
      createButtons();
    });
  } else {
    console.log('页面已加载，直接创建按钮');
    createButtons();
  }

  console.log('题目收集助手已加载，当前题库:', getQuestions().length);
  console.log('当前URL:', location.href);
  console.log('脚本初始化完成');

  // 提供调试辅助函数（仅超星章节页面）
  if (location.href.includes('mooc1.chaoxing.com/mycourse/studentstudy')) {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(' 超星章节检测页面 - 调试辅助');
    console.log('═══════════════════════════════════════');
    console.log('如果收集不到题目，请在控制台执行以下命令进行诊断：');
    console.log('');
    console.log('1️ 检查主 iframe 是否存在:');
    console.log('   document.querySelector("#iframe")');
    console.log('');
    console.log('2️ 检查 iframe 是否可访问:');
    console.log('   document.querySelector("#iframe")?.contentDocument');
    console.log('');
    console.log('3️ 查找 iframe 中的题目容器:');
    console.log('   document.querySelector("#iframe")?.contentDocument?.querySelectorAll(".questionLi")');
    console.log('');
    console.log('4️ 查找所有可能的题目相关元素:');
    console.log('   document.querySelector("#iframe")?.contentDocument?.querySelectorAll("[class*=question]")');
    console.log('');
    console.log('5️ 手动触发收集（等待页面加载后）:');
    console.log('   collectChaoxingChapter()');
    console.log('═══════════════════════════════════════');
    console.log('');
  }
})();
