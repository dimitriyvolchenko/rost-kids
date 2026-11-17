'use strict';
(() => {
  const JOURNAL_KEY = 'rost.journal.v1';
  const PROGRAM_KEY = 'rost.program.v1';
  const VIEWS = {today:'МОЙ ДЕНЬ',week:'МОЯ НЕДЕЛЯ',progress:'МОИ ШАГИ',parents:'ВЗРОСЛЫМ'};
  const UNITS = ['повт.','на сторону','сек.','мин.'];
  const $ = (q, root=document) => root.querySelector(q);
  const $$ = (q, root=document) => [...root.querySelectorAll(q)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  const plain = v => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  const str = (v,min=0,max=3000) => typeof v === 'string' && v.length >= min && v.length <= max;
  const number = (v,min,max) => typeof v === 'number' && Number.isFinite(v) && v>=min && v<=max;
  const safeId = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(v);
  const keyDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const parseDate = s => {const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12);};
  const validDate = s => typeof s==='string' && /^20\d{2}-\d{2}-\d{2}$/.test(s) && keyDate(parseDate(s))===s;
  const today = () => keyDate(new Date());
  const dateLabel = s => parseDate(s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  const wholeDate = s => parseDate(s).toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const kindLabel = kind => ({strength:'Сила',easy:'Легкость',rest:'Отдых'}[kind]);
  const main = $('#main');
  let program=null, selectedDate=today(), currentView='today', adult=false;
  let journal={schemaVersion:1,dates:{}}, storageError='', persistAllowed=true, updateText='Проверяем программу…';
  let timerInterval=null, timerEnds=0, toastTimeout=null, registration=null, waitingWorker=null;
  let updateRequested=false;

  function validExercise(e) {
    return plain(e)&&safeId(e.id)&&str(e.title,1,160)&&Number.isInteger(e.sets)&&number(e.sets,1,5)&&number(e.reps,1,300)&&UNITS.includes(e.unit)&&number(e.loadKg,0,100)&&number(e.restSec,0,600)&&str(e.cue,1)&&str(e.easier,0)&&typeof e.adultRequired==='boolean';
  }
  function validPlan(p) {
    if(!plain(p)||!safeId(p.id)||!str(p.title,1,200)||!['strength','easy','rest'].includes(p.kind)||!number(p.minutes,0,120)||!str(p.warmup)||!str(p.cooldown)||!Array.isArray(p.exercises)||p.exercises.length>20) return false;
    if(!p.exercises.every(validExercise)||new Set(p.exercises.map(e=>e.id)).size!==p.exercises.length) return false;
    if(p.kind==='rest' && p.exercises.length!==0) return false;
    if(p.kind==='easy' && p.exercises.some(e=>e.loadKg!==0||e.adultRequired)) return false;
    if(p.kind!=='rest' && p.exercises.length===0) return false;
    return p.focus===undefined || str(p.focus,0,500);
  }
  function validateProgram(p) {
    if(!plain(p)||p.schemaVersion!==1||!str(p.version,1,80)||!str(p.title,1,120)||!str(p.intro,1)||!Array.isArray(p.days)||p.days.length!==7||!validPlan(p.solo)||p.solo.kind!=='easy') throw new Error('Неверный формат программы');
    if(!p.days.every(d=>validPlan(d)&&Number.isInteger(d.weekday)&&number(d.weekday,0,6)&&str(d.label,1,80))||new Set(p.days.map(d=>d.weekday)).size!==7||new Set(p.days.map(d=>d.id)).size!==7) throw new Error('В программе должны быть семь разных дней');
    const forceDays=p.days.filter(d=>d.kind==='strength').map(d=>d.weekday);
    if(forceDays.length>3||forceDays.some(d=>forceDays.includes((d+1)%7))) throw new Error('Силовые дни должны идти через день, не более трех в неделю');
    if(!['guidance','progression'].every(k=>Array.isArray(p[k])&&p[k].length<=30&&p[k].every(v=>str(v,1,4000)))) throw new Error('Нет пояснений к программе');
    if(!Array.isArray(p.sources)||p.sources.length>20||!p.sources.every(s=>plain(s)&&str(s.title,1,300)&&str(s.url,1,1000)&&/^https:\/\//.test(s.url)&&(()=>{try{return new URL(s.url).protocol==='https:';}catch{return false;}})())) throw new Error('Неверные источники');
    return p;
  }
  function validSession(s,mode) {
    if(!plain(s)||!str(s.version,1,80)||!validPlan(s.plan)||!plain(s.entries))return false;
    if(mode==='solo'&&s.plan.kind!=='easy')return false;
    if(Object.keys(s.entries).length!==s.plan.exercises.length)return false;
    const allowed=new Map(s.plan.exercises.map(e=>[e.id,e]));
    return Object.entries(s.entries).every(([id,sets])=>allowed.has(id)&&Array.isArray(sets)&&sets.length===allowed.get(id).sets&&sets.every(v=>plain(v)&&typeof v.done==='boolean'&&(v.actual===null||number(v.actual,0,10000))&&(v.kg===null||(number(v.kg,0,100)&&(s.plan.kind==='strength'||v.kg===0)))));
  }
  function validateJournal(j) {
    if(!plain(j)||j.schemaVersion!==1||!plain(j.dates)||Object.keys(j.dates).length>4000)throw new Error('Неверный формат записей');
    for(const [date,d] of Object.entries(j.dates)) {
      if(!validDate(date)||!plain(d)||!['good','low','pain'].includes(d.mood)||!plain(d.sessions)||Object.keys(d.sessions).some(k=>!['main','solo'].includes(k))||!Object.entries(d.sessions).every(([mode,s])=>validSession(s,mode)))throw new Error('Поврежденная запись за дату '+date);
    }
    return j;
  }
  function toast(message) { $('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('#toast').classList.remove('visible'),4200); }
  function saveJournal() {
    if(!persistAllowed){toast('Запись пока только на экране. Скачайте резервную копию во вкладке «Взрослым».');return false;}
    try {localStorage.setItem(JOURNAL_KEY,JSON.stringify(journal));return true;}
    catch {storageError='Браузер не смог сохранить записи. Не закрывайте страницу: скачайте резервную копию во вкладке «Взрослым».';toast(storageError);return false;}
  }
  function readJournal() {
    try {const raw=localStorage.getItem(JOURNAL_KEY);if(raw)journal=validateJournal(JSON.parse(raw));}
    catch {persistAllowed=false;storageError='Не удалось прочитать сохраненный дневник. Старые данные не перезаписаны. Во вкладке «Взрослым» можно восстановить проверенную резервную копию.';}
  }
  function record() {return journal.dates[selectedDate]||null;}
  function mood() {return record()?.mood||'good';}
  function baseDay() {return program.days.find(d=>d.weekday===parseDate(selectedDate).getDay());}
  function requiresAdult(plan) {return plan.kind==='strength'||plan.exercises.some(e=>e.adultRequired||e.loadKg>0);}
  function currentContext() {
    const base=record()?.sessions?.main?.plan || baseDay();
    const mode=base.kind!=='rest'&&(mood()==='low'||(requiresAdult(base)&&!adult))?'solo':'main';
    const snap=record()?.sessions?.[mode];
    const plan=snap?.plan || (mode==='solo'?program.solo:base);
    const blocked=mood()==='pain'||(requiresAdult(plan)&&!adult)||selectedDate>today();
    return {base,mode,plan,snap,blocked};
  }
  function ensureRecord() {return journal.dates[selectedDate] ||= {mood:'good',sessions:{}};}
  function ensureSession(context) {
    const r=ensureRecord();
    if(!r.sessions[context.mode]) {
      const entries={};for(const e of context.plan.exercises)entries[e.id]=Array.from({length:e.sets},()=>({done:false,actual:null,kg:null}));
      r.sessions[context.mode]={version:program.version,plan:clone(context.plan),entries};
    }
    return r.sessions[context.mode];
  }
  function hasRecorded(s) {return Object.values(s?.entries||{}).flat().some(e=>e.done||e.actual!==null||e.kg!==null);}
  function checkedSets(s) {return Object.values(s?.entries||{}).flat().filter(e=>e.done).length;}
  function totalSets(p) {return p.exercises.reduce((n,e)=>n+e.sets,0);}
  function dayProgress(date) {return Object.values(journal.dates[date]?.sessions||{}).reduce((n,s)=>n+checkedSets(s),0);}
  function weekDates() {const start=parseDate(selectedDate);start.setDate(start.getDate()-((start.getDay()+6)%7));return Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return keyDate(d);});}
  function weekCount() {return weekDates().filter(d=>dayProgress(d)>0).length;}
  function dateControl() {return `<div class="date-pill"><input id="date-picker" type="date" min="2020-01-01" max="2099-12-31" value="${selectedDate}" aria-label="Дата дневника"><button data-action="today-date">Сегодня</button></div>`;}
  function header(title,sub,date=true) {return `<div class="intro-heading"><div><h1>${title}</h1><p>${sub}</p></div>${date?dateControl():''}</div>`;}
  function plantArt() {return `<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 240 220" fill="none"><circle cx="124" cy="103" r="80" fill="#eff3e7"/><circle cx="124" cy="103" r="97" stroke="#cdd8bb" stroke-dasharray="2 6"/><path d="M34 178C68 161 79 181 105 169C131 157 158 166 190 146" stroke="#c0cda9" stroke-width="1.5"/><path d="M120 180C110 153 128 127 117 101C110 84 123 61 125 40" stroke="#4c7051" stroke-width="3.5" stroke-linecap="round"/><path d="M119 111C89 107 73 81 79 64C104 62 123 79 119 111Z" fill="#8aa577"/><path d="M118 141C143 136 166 111 161 90C138 91 118 108 118 141Z" fill="#b2c795"/><path d="M121 77C140 70 151 52 146 37C127 42 118 58 121 77Z" fill="#658861"/><path d="M115 161C96 159 84 144 84 131C106 132 117 143 115 161Z" fill="#6d8d67"/><path d="M120 108L86 74M120 134L153 102M123 68L140 44" stroke="#4c7051" stroke-width="1.2" stroke-linecap="round" opacity=".45"/><path d="M100 184Q120 174 141 185" stroke="#6b855d" stroke-width="2" stroke-linecap="round"/><circle cx="58" cy="116" r="3" fill="#ab8abb"/><path d="M179 59V70M174 64.5H184" stroke="#ab8abb" stroke-width="2" stroke-linecap="round"/><circle cx="172" cy="166" r="6" fill="#e8c1a2"/><path d="M50 48L53 54L59 57L53 60L50 66L47 60L41 57L47 54Z" fill="#c4d2ac"/></svg></div>`;}
  function hero() {return `<section class="hero"><div class="hero-copy"><div class="eyebrow"><i class="eyebrow-dot"></i> ТВОЙ РИТМ. ТВОЙ РОСТ.</div><h2>Сильнее,<br>шаг за шагом.</h2><p>Учись новым движениям, замечай свои успехи и оставляй время для отдыха.</p><div class="hero-tags"><span class="tag">✦ 5 дней движения</span><span class="tag">♡ С заботой о себе</span></div></div>${plantArt()}</section>`;}
  function renderWeekStrip() {
    const names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    return `<div class="section-title"><h2>Твоя неделя</h2><button class="quiet-link" data-view="week">Весь план <span aria-hidden="true">›</span></button></div><div class="week-strip">${weekDates().map((date,i)=>{const day=program.days.find(d=>d.weekday===parseDate(date).getDay());const count=dayProgress(date);return `<button data-date="${date}" class="day-mini kind-${day.kind}${date===selectedDate?' selected':''}${count?' has-progress':''}" aria-label="${esc(wholeDate(date))}, ${kindLabel(day.kind)}${count?', есть записи':''}" ${date===selectedDate?'aria-current="date"':''}><span class="day-name">${names[i]}</span><span class="day-number">${parseDate(date).getDate()}</span><i class="day-dot"></i><span class="day-status">${count?'✓ Есть шаг':kindLabel(day.kind)}</span></button>`;}).join('')}</div>`;
  }
  function preflight(context) {
    const m=mood();
    return `<div class="preflight"><div class="preflight-title">Как ты себя чувствуешь?</div><div class="mood-buttons" role="group" aria-label="Самочувствие"><button class="mood${m==='good'?' active':''}" aria-pressed="${m==='good'}" data-mood="good">☀ Хорошо</button><button class="mood${m==='low'?' active':''}" aria-pressed="${m==='low'}" data-mood="low">☁ Мало сил</button><button class="mood${m==='pain'?' active':''}" aria-pressed="${m==='pain'}" data-mood="pain">♡ Боль / плохо</button></div><label class="adult-control"><input id="adult-present" type="checkbox" ${adult?'checked':''}><span>Взрослый рядом и следит за техникой<small>Умеет объяснить движения и остается на всё занятие.</small></span></label>${context.mode==='solo'?`<div class="notice">${m==='low'?'Сегодня выбираем лёгкий вариант. Можно закончить раньше или отдохнуть.':'Сегодня по плану сила. Пока взрослого нет рядом — только знакомые лёгкие движения без инвентаря.'}</div>`:''}${selectedDate>today()?'<div class="notice info">Это будущий день. Можно посмотреть план; отметки откроются в эту дату.</div>':''}${context.snap&&context.snap.version!==program.version?`<div class="readonly-banner">Сохранен план ${esc(context.snap.version)}: обновление программы не меняет эту запись.</div>`:''}</div>`;
  }
  function exerciseMarkup(e,index,c) {
    const sets=c.snap?.entries[e.id]||Array.from({length:e.sets},()=>({done:false,actual:null,kg:null}));
    const complete=sets.every(s=>s.done);
    const actualUnit=e.unit==='на сторону'?'на сторону':e.unit;
    return `<article class="exercise${complete?' done':''}" data-exercise="${e.id}"><div class="exercise-heading"><span class="exercise-number">${complete?'✓':String(index+1).padStart(2,'0')}</span><div class="exercise-title"><h3>${esc(e.title)}</h3><div class="exercise-subtitle">${e.sets} ${e.sets===1?'подход':e.sets<5?'подхода':'подходов'} · ${e.reps} ${esc(e.unit)} · ${e.loadKg===0?'без дополнительного веса':esc(e.loadKg)+' кг инвентаря'}</div></div></div><details class="technique"><summary>Как делать движение</summary><p>${esc(e.cue)}${e.easier?`<br><b>Если трудно:</b> ${esc(e.easier)}`:''}</p></details><div class="sets-grid"><div class="set-head">Подх.</div><div class="set-head">План</div><div class="set-head">Факт<span class="sub">${esc(actualUnit)}</span></div><div class="set-head">кг<span class="sub">инвентарь</span></div><div class="set-head">Готово</div>${sets.map((s,i)=>`<div class="set-row"><span class="set-number">${i+1}</span><span class="set-plan">${e.reps} ${esc(e.unit)}<small>${e.loadKg===0?'0 кг · свой вес':e.loadKg+' кг'}</small></span><input class="set-input" type="number" min="0" max="10000" step="any" inputmode="decimal" data-entry="actual" data-ex="${e.id}" data-set="${i}" value="${s.actual===null?'':s.actual}" placeholder="—" aria-label="${esc(e.title)}, подход ${i+1}, факт ${esc(actualUnit)}" ${c.blocked?'disabled':''}><input class="set-input" type="number" min="0" max="100" step="0.1" inputmode="decimal" data-entry="kg" data-ex="${e.id}" data-set="${i}" value="${s.kg===null?'':s.kg}" placeholder="—" aria-label="${esc(e.title)}, подход ${i+1}, фактическая масса инвентаря в кг" ${c.blocked?'disabled':''}><input class="set-check" type="checkbox" data-entry="done" data-ex="${e.id}" data-set="${i}" ${s.done?'checked':''} ${c.blocked?'disabled':''} aria-label="${esc(e.title)}, подход ${i+1} выполнен"><span class="set-spacer"></span></div>`).join('')}</div><div class="exercise-tools"><button class="rest-button" data-rest="${e.restSec}">◷ Пауза ${e.restSec} сек.</button><span>${e.unit==='на сторону'?'Факт — число для каждой стороны':'Не нужно делать больше плана'}</span></div></article>`;
  }
  function routine() {
    const c=currentContext(),p=c.plan,total=totalSets(p),done=checkedSets(c.snap);
    if(c.base.kind==='rest')return `<section class="main-card"><div class="routine-header"><p class="eyebrow">${esc(wholeDate(selectedDate))}</p><h2>Отдых тоже помогает расти</h2><p>Сегодня нет обязательного списка упражнений.</p></div><div class="stop-card"><span class="flower-icon" aria-hidden="true">✺</span><h3>Время для себя</h3><p>Гуляй, играй, проводи время с семьей. Выбирай то, что нравится. Пропущенные занятия наверстывать не нужно.</p></div></section>`;
    return `<section class="main-card"><div class="routine-header"><p class="eyebrow">${esc(wholeDate(selectedDate))}</p><h2>${mood()==='pain'?'Сегодня бережём себя':esc(p.title)}</h2><p>${esc(p.focus||'Знакомые движения в своём темпе')}</p><div class="routine-meta"><span class="tag ${p.kind==='strength'?'green':'lilac'}">${p.kind==='strength'?'✦ Со взрослым':'✧ Лёгкий день'} · ~${p.minutes} мин.</span><span class="progress-count">${done} из ${total} подходов</span></div><div class="progress-bar" role="progressbar" aria-label="Отмеченные подходы" aria-valuemin="0" aria-valuemax="${total||1}" aria-valuenow="${done}"><i style="width:${total?Math.min(100,done/total*100):0}%"></i></div></div>${preflight(c)}${mood()==='pain'?`<div class="stop-card"><span class="stop-symbol" aria-hidden="true">♡</span><h3>Сейчас нужна пауза.</h3><p>Остановись и скажи взрослому о боли или плохом самочувствии. При сильных или сохраняющихся симптомах нужна медицинская помощь. Галочки сегодня не важны.</p></div>`:`${requiresAdult(p)&&!adult?'<div class="notice warning">Для этого сохраненного плана нужен взрослый рядом.</div>':''}<div class="phase"><span class="phase-icon" aria-hidden="true">☀</span><div><h3>Сначала — разминка</h3><p>${esc(p.warmup)}</p></div></div><div class="exercise-list">${p.exercises.map((e,i)=>exerciseMarkup(e,i,c)).join('')}</div><div class="phase"><span class="phase-icon" aria-hidden="true">☁</span><div><h3>В конце — спокойно выдохни</h3><p>${esc(p.cooldown)}</p></div></div><div class="routine-bottom"><p>${done===total&&total?'Все подходы отмечены. Спасибо, что уделила время себе. Теперь можно отдохнуть.':'Отметь то, что получилось. Можно выполнить часть занятия — это тоже шаг.'}</p></div>`}</section>`;
  }
  function sideCards() {return `<aside class="side-stack" aria-label="Подсказки"><section class="side-card"><span class="eyebrow">МАЛЕНЬКИЕ ШАГИ</span><h3>На этой неделе</h3><div class="small-stat"><strong class="stat-value">${weekCount()} <span>дн.</span></strong><p>с отмеченным<br>движением</p></div><p>Здесь нет гонки.<br>Каждая попытка важна.</p></section><section class="side-card lilac"><div class="flower-icon" aria-hidden="true">✳</div><h3>Техника важнее числа</h3><p>Двигайся спокойно. Если трудно — меньше повторов или более лёгкий вариант.</p></section><section class="side-card"><h3>Перед началом</h3><ul class="tips-list"><li>Свободный пол и устойчивая опора.</li><li>Вода рядом, дыхание свободное.</li><li>Боль — повод остановиться и сказать взрослому.</li></ul></section></aside>`;}
  function todayView() {return `${header('Рада твоему новому шагу.','Немного движения. Больше уверенности в себе.')}${hero()}${renderWeekStrip()}<div class="today-grid">${routine()}${sideCards()}</div>`;}
  function weekView() {
    const dates=weekDates();
    return `${header('Неделя в твоём ритме.','Три дня силы через день. Два дня лёгкости. Выходные — свободные.') }<p class="week-note">Стартовый план на первые 2 недели. Силовая часть — только со взрослым, знакомым с правильной техникой.</p><div class="week-cards">${dates.map(date=>{const d=program.days.find(v=>v.weekday===parseDate(date).getDay());return `<article class="week-card kind-${d.kind}"><div class="week-card-top"><span class="week-card-day">${esc(d.label)} · ${dateLabel(date)}</span><span class="tag ${d.kind==='strength'?'green':d.kind==='easy'?'lilac':'neutral'}">${kindLabel(d.kind)}${d.minutes?' · ~'+d.minutes+' мин.':''}</span></div><h2>${esc(d.title)}</h2><p>${esc(d.focus)}</p>${d.exercises.length?`<ul>${d.exercises.map(e=>`<li>${esc(e.title)} — ${e.sets} × ${e.reps} ${esc(e.unit)}</li>`).join('')}</ul>`:'<p>Прогулка, игра, любимые дела. Без обязательных отметок.</p>'}<button class="button" data-date="${date}">Открыть день <span aria-hidden="true">›</span></button></article>`;}).join('')}</div><p class="note-footer">Не переноси пропущенную силовую тренировку на следующий день. Просто продолжай по расписанию.</p>`;
  }
  function progressView() {
    const entries=Object.entries(journal.dates).filter(([,d])=>Object.values(d.sessions).some(hasRecorded)).sort(([a],[b])=>b.localeCompare(a));
    const total=entries.reduce((n,[,d])=>n+Object.values(d.sessions).reduce((x,s)=>x+checkedSets(s),0),0);
    return `${header('Твои маленькие победы.','Замечай, что получается. Отдых не обнуляет твой путь.',false)}<div class="stats-grid"><div class="stat-card"><strong>${entries.length}</strong><span>дней с записями</span></div><div class="stat-card"><strong>${total}</strong><span>отмеченных подходов</span></div><div class="stat-card"><strong>${weekCount()}</strong><span>дней в выбранной неделе</span></div></div><section class="section-card"><div class="section-title"><h2>История твоих шагов</h2><span class="tiny-label">Только на этом устройстве</span></div>${entries.length?`<div class="history-list">${entries.map(([date,d])=>{const sessions=Object.entries(d.sessions).filter(([,s])=>hasRecorded(s));return `<div class="history-row"><div><h3>${esc(dateLabel(date))} · ${parseDate(date).getFullYear()}</h3><p>${sessions.map(([,s])=>esc(s.plan.title)).join(' + ')} · ${dayProgress(date)} отметок</p><details class="history-details"><summary>План и фактические значения</summary>${sessions.map(([,s])=>`<p>Версия ${esc(s.version)}</p><ul>${s.plan.exercises.map(e=>{const sets=s.entries[e.id]||[];return `<li>${esc(e.title)}: план ${e.sets} × ${e.reps} ${esc(e.unit)}, ${e.loadKg} кг.<br>${sets.map((v,i)=>`${i+1}: ${v.done?'✓':'—'} факт ${v.actual===null?'не указан':v.actual+' '+esc(e.unit)}; ${v.kg===null?'кг не указаны':v.kg+' кг'}`).join(' · ')}</li>`;}).join('')}</ul>`).join('')}</details></div><button class="button" data-date="${date}">Открыть</button></div>`;}).join('')}</div>`:`<div class="empty-state"><span class="flower-icon" aria-hidden="true">✺</span><h3>Всё начинается с одного шага.</h3><p>Когда отметишь подход в дневнике, он появится здесь. Ты можешь начать с лёгкого движения.</p><div class="button-row" style="justify-content:center"><button class="button dark" data-view="today">Перейти к моему дню</button></div></div>`}</section><section class="side-card peach"><h3>Сравнивай себя только с собой</h3><p>Стало легче держать равновесие? Получается спокойнее двигаться? Такие перемены важнее цифр. Здесь нет оценок фигуры, веса тела и соревнований.</p></section>`;
  }
  function parentsView() {
    return `${header('Расти с поддержкой.','Программа, безопасность и забота о записях.',false)}<section class="section-card"><span class="eyebrow">ОСТОРОЖНЫЙ СТАРТ · 11 ЛЕТ</span><h2 style="margin-top:12px">Сила начинается с техники</h2><p>${esc(program.intro)}</p><div class="notice">Этот дневник не проверяет технику и не заменяет специалиста. Подтверждение «взрослый рядом» — напоминание, а не средство контроля.</div></section><div class="parent-grid"><section class="section-card"><h2>Перед первым занятием</h2><ul class="parent-list">${program.guidance.map(v=>`<li>${esc(v)}</li>`).join('')}</ul></section><div><section class="section-card"><h2>Как добавлять нагрузку</h2><ol class="parent-list">${program.progression.map(v=>`<li>${esc(v)}</li>`).join('')}</ol></section><section class="section-card" style="margin-top:18px"><h2>Обновление программы</h2><p class="update-status">Версия: <strong>${esc(program.version)}</strong><br>${esc(updateText)}</p><div class="button-row"><button class="button dark" data-action="update">Проверить обновления</button></div><p class="data-note">Программа приходит из program.json на том же сайте. Уже начатые дни сохраняют собственную копию плана. Новая программа применяется к новым записям. Отметки не удаляются.</p></section><section class="section-card" style="margin-top:18px"><h2>Твои записи</h2><p>Дневник хранится в этом браузере. Он не отправляется на GitHub и не синхронизируется между устройствами. Очистка данных сайта или удаление приложения может удалить записи.</p><div class="button-row"><button class="button soft" data-action="export">Скачать мои записи</button><button class="button" data-action="import">Восстановить из файла</button></div><p class="data-note">Сохраняйте копию регулярно и перед переносом на другой телефон. Файл может содержать отметки о самочувствии; храните его у себя.</p>${!persistAllowed?'<div class="notice warning">Поврежденные локальные записи защищены от перезаписи. Восстановление из проверенного файла заменит их только после подтверждения.</div>':''}</section><section class="section-card" style="margin-top:18px"><h2>Всегда под рукой</h2><p>Добавьте приложение на экран телефона. После первого успешного открытия с интернетом оно сможет работать без сети.</p><div class="button-row"><a class="button" href="install.html">Инструкция установки ›</a></div></section></div></div><section class="section-card" style="margin-top:18px"><h2>На что опирается программа</h2><ul class="source-list">${program.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ›</a></li>`).join('')}</ul><p class="data-note">План составлен по общим рекомендациям и требует адаптации по самочувствию и технике ребенка. Здесь нет гарантии изменения фигуры к определенному возрасту.</p></section>`;
  }
  function render() {
    if(!program)return;
    const view={today:todayView,week:weekView,progress:progressView,parents:parentsView}[currentView];
    main.innerHTML=(storageError?`<div class="error-inline" role="alert">${esc(storageError)}</div>`:'')+view();
    $$('.nav-button').forEach(b=>{const on=b.dataset.view===currentView;b.classList.toggle('active',on);on?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');});
    $('#view-label').textContent=VIEWS[currentView];$('#version').textContent='Рост · программа '+program.version;
  }
  function setView(view) {if(!VIEWS[view])return;currentView=view;history.replaceState(null,'','#'+view);render();window.scrollTo({top:0,behavior:'instant'});}
  function changeDate(date) {if(!validDate(date)){toast('Выберите корректную дату.');return;}selectedDate=date;adult=false;stopTimer();currentView='today';history.replaceState(null,'','#today');render();}
  async function fetchProgram(manual=false) {
    if(manual){updateText='Проверяем обновления…';if(currentView==='parents')render();}
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetch('program.json',{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const offlineCopy=response.headers.get('X-Rost-Offline')==='1';
      if(offlineCopy && program){updateText='Без сети: сохранена последняя проверенная программа. Обновление пока недоступно.';render();if(manual)toast('Без сети: действующая программа и записи сохранены.');return;}
      const candidate=validateProgram(await response.json());
      const changed=program&&candidate.version!==program.version;
      program=candidate;
      try{localStorage.setItem(PROGRAM_KEY,JSON.stringify(program));}catch{updateText='Программа открыта, но браузер не сохранил резервную копию.';}
      updateText=(navigator.onLine&&!offlineCopy)?'Проверено '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+'. План готов.':'Открыта сохраненная версия. Обновления проверятся при подключении.';
      render();if(manual)toast(changed?'Новая программа получена. Начатые дни сохранены.':navigator.onLine?'Программа проверена. Записи сохранены.':'Без сети: используем сохраненную программу.');
    }catch(e){
      updateText='Не удалось получить новую программу. Используется последняя проверенная копия.';
      if(program){if(currentView==='parents')render();if(manual)toast('Обновление недоступно или файл некорректен. Действующий план и записи сохранены.');}
      else main.innerHTML=`<div class="error-panel"><h1>Сначала подключимся к программе.</h1><p>Для первого открытия нужен интернет и файл program.json рядом с приложением. Если открываешь скачанный index.html, используй адрес сайта GitHub Pages.</p><button class="button dark" data-action="retry">Попробовать снова</button><a class="button" href="install.html">Инструкция</a></div>`;
    }finally{clearTimeout(timeout);}
  }
  function updateEntry(input) {
    if(!program)return;
    const c=currentContext();if(c.blocked){toast('Сначала проверь самочувствие и условия занятия.');render();return;}
    const exercise=c.plan.exercises.find(e=>e.id===input.dataset.ex),index=Number(input.dataset.set),field=input.dataset.entry;
    if(!exercise||!Number.isInteger(index)||index<0||index>=exercise.sets||!['actual','kg','done'].includes(field))return;
    let value;
    if(field==='done')value=input.checked;
    else {value=input.value.trim()===''?null:Number(input.value);if(value!==null&&!number(value,0,field==='kg'?100:10000)){toast('Введите неотрицательное число в допустимом диапазоне.');input.value='';return;}if(field==='kg'&&value>0&&(!adult||c.plan.kind!=='strength')){toast('В лёгком плане дополнительного веса нет. Силовая нагрузка — только со взрослым.');input.value='';return;}}
    const s=ensureSession(c);s.entries[exercise.id][index][field]=value;saveJournal();
    if(field==='done'){const opened=$$('details.technique[open]').map(d=>d.closest('[data-exercise]').dataset.exercise);render();opened.forEach(id=>$(`[data-exercise="${id}"] .technique`)?.setAttribute('open',''));}
  }
  function startTimer(seconds) {stopTimer();timerEnds=Date.now()+seconds*1000;$('#timer-panel').hidden=false;function tick(){const left=Math.max(0,Math.ceil((timerEnds-Date.now())/1000));$('#timer-display').textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');if(!left){clearInterval(timerInterval);timerInterval=null;toast('Пауза закончилась. Отдохни дольше, если нужно.');}}tick();timerInterval=setInterval(tick,250);}
  function stopTimer() {clearInterval(timerInterval);timerInterval=null;$('#timer-panel').hidden=true;}
  function exportData() {
    const backup={format:'rost-backup',schemaVersion:1,exportedAt:new Date().toISOString(),journal};
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`rost-records-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);toast('Резервная копия подготовлена для скачивания.');
  }
  async function importData(file) {
    if(!file)return;
    if(file.size>20000000){toast('Файл слишком большой. Выберите резервную копию Рост до 20 МБ.');return;}
    try {
      const b=JSON.parse(await file.text());if(!plain(b)||b.format!=='rost-backup'||b.schemaVersion!==1)throw new Error('Это не резервная копия Рост');
      const incoming=validateJournal(b.journal),dates=Object.keys(incoming.dates);
      const conflicts=dates.filter(d=>journal.dates[d]&&JSON.stringify(journal.dates[d])!==JSON.stringify(incoming.dates[d]));
      const prompt=persistAllowed?`В файле ${dates.length} дат. Добавить отсутствующие записи?${conflicts.length?' Найдено '+conflicts.length+' совпадающих дат с отличиями. На следующем шаге выберете, какие оставить.':''}`:'Локальная копия не читается. Заменить ее проверенной резервной копией? Это действие заменит поврежденные данные на этом устройстве.';
      if(!confirm(prompt))return;
      let replaceConflicts=false;if(conflicts.length)replaceConflicts=confirm(`Заменить ${conflicts.length} совпадающих дат версиями из файла? «Отмена» сохранит местные записи и добавит только новые даты.`);
      const merged=persistAllowed?clone(journal):{schemaVersion:1,dates:{}};
      for(const [date,d] of Object.entries(incoming.dates))if(!merged.dates[date]||replaceConflicts)merged.dates[date]=clone(d);
      validateJournal(merged);localStorage.setItem(JOURNAL_KEY,JSON.stringify(merged));journal=merged;persistAllowed=true;storageError='';adult=false;render();toast('Записи восстановлены. Подтверждение взрослого сброшено.');
    }catch(e){toast('Файл не импортирован: '+e.message+'. Текущие записи сохранены.');}
    finally{$('#import-file').value='';}
  }
  function connectionState() {const el=$('#connection');el.classList.toggle('offline',!navigator.onLine);el.innerHTML='<i></i>'+(navigator.onLine?'На этом устройстве':'Без сети · локально');}
  async function setupWorker() {
    if(!('serviceWorker'in navigator)||!window.isSecureContext)return;
    try {
      registration=await navigator.serviceWorker.register('sw.js');
      function showWaiting(worker){waitingWorker=worker;$('#update-banner').hidden=false;}
      if(registration.waiting)showWaiting(registration.waiting);
      registration.addEventListener('updatefound',()=>{const worker=registration.installing;if(worker)worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showWaiting(worker);});});
      let reloading=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)return;reloading=true;if(updateRequested)location.reload();});
    }catch { /* Online use remains available; no offline success is claimed. */ }
  }
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,[data-view]');if(!target)return;
    if(target.dataset.view){setView(target.dataset.view);return;}
    if(target.dataset.date){changeDate(target.dataset.date);return;}
    if(target.dataset.mood){ensureRecord().mood=target.dataset.mood;saveJournal();if(target.dataset.mood==='pain')stopTimer();render();return;}
    if(target.dataset.rest!==undefined){if(mood()==='pain')return;startTimer(Number(target.dataset.rest));return;}
    const action=target.dataset.action;
    if(action==='today-date')changeDate(today());
    if(action==='update'){fetchProgram(true);registration?.update().catch(()=>{});}
    if(action==='retry')fetchProgram(true);
    if(action==='export')exportData();
    if(action==='import')$('#import-file').click();
  });
  document.addEventListener('input',event=>{
    if(['actual','kg'].includes(event.target.dataset.entry))updateEntry(event.target);
  });
  document.addEventListener('change',event=>{
    const target=event.target;
    if(target.id==='date-picker')changeDate(target.value);
    else if(target.id==='adult-present'){adult=target.checked;stopTimer();render();}
    else if(target.dataset.entry)updateEntry(target);
  });
  $('#import-file').addEventListener('change',e=>importData(e.target.files[0]));
  $('#timer-stop').addEventListener('click',stopTimer);
  $('#reload-app').addEventListener('click',()=>{if(waitingWorker){updateRequested=true;waitingWorker.postMessage({type:'SKIP_WAITING'});}else location.reload();});
  window.addEventListener('online',()=>{connectionState();fetchProgram(false);});window.addEventListener('offline',connectionState);
  window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(VIEWS[view]){currentView=view;render();}});
  window.addEventListener('storage',event=>{if(event.key===JOURNAL_KEY&&event.newValue){try{journal=validateJournal(JSON.parse(event.newValue));render();toast('Записи обновлены из другой вкладки.');}catch{toast('Из другой вкладки пришли поврежденные данные. Текущий дневник сохранен.');}}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')connectionState();});
  readJournal();connectionState();
  const initial=location.hash.slice(1);if(VIEWS[initial])currentView=initial;
  try{const cached=localStorage.getItem(PROGRAM_KEY);if(cached){program=validateProgram(JSON.parse(cached));updateText='Открыта сохраненная программа. Проверяем обновления…';render();}}catch{}
  fetchProgram(false);setupWorker();
  // Small read-only testing surface; no personal data is exposed over the network.
  window.__rost={validateProgram,validateJournal,keyDate,validDate,getProgram:()=>clone(program),getJournal:()=>clone(journal),getContext:()=>program?clone(currentContext()):null};
})();
