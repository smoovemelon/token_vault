const $ = id => document.getElementById(id);
const getISODate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const eHtml = str => String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m]);

let audioCtx = null, wakeLockObj = null, masterInterval = null, state;
let pendingSpend = { cost: 0, mins: 0, name: "" }, currentEditMode = 'routine';

const DEFAULT_STATE = {
    version: 6.0, tokens: 0.00, vaultCash: 0.00, streak: 0, baselineMet: false, lastDate: getISODate(),
    studyBlocks: 0.00, webhookUrl: "", soundEnabled: true, theme: "light", timerEndTime: null, focusEndTime: null, focusMinutesTotal: 0,
    dailyRoutine: [
        { id: 'h1', icon: 'MD', name: 'MEDS (DAY)', payout: 0.25, checked: false },
        { id: 'h2', icon: 'SH', name: 'GOOBA SHAKE', payout: 0.50, checked: false }
    ],
    flexibleEngine: [{ id: 'f1', icon: 'GY', name: 'LIFT SESSION', payout: 1.00, checked: false }],
    todayLog: { earned: 0.00, spent: 0.00, banked: 0.00 },
    history: [] // Stores last 7 days for the chart
};

// 💾 INDEXED-DB ASYNC LOADING
localforage.getItem('toroTrackerApp').then(saved => {
    state = saved ? { ...DEFAULT_STATE, ...saved } : { ...DEFAULT_STATE };
    if(!saved && localStorage.getItem('toroTrackerApp')) {
        state = { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('toroTrackerApp')) };
    }
    if(!state.history) state.history = [];
    document.body.className = `theme-${state.theme}`;
    $('meta-theme-color').setAttribute('content', state.theme === 'dark' ? '#121212' : '#ffffff');
    $('app-container').style.display = 'flex';
    checkDayRollover(); updateUI();
    if (state.timerEndTime || state.focusEndTime) startMasterEngine();
});

function saveState() {
    ['tokens','vaultCash','studyBlocks'].forEach(k => state[k] = Math.round(state[k]*100)/100);
    ['earned','spent','banked'].forEach(k => state.todayLog[k] = Math.round(state.todayLog[k]*100)/100);
    localforage.setItem('toroTrackerApp', state); updateUI();
}

// 📱 HAPTICS & SOUND
window.addEventListener('touchstart', () => { if(!audioCtx) { audioCtx = new AudioContext(); audioCtx.resume(); } }, {once:true});
const playHz = (hz, dur, type='square') => { if(!state.soundEnabled || !audioCtx) return; const o=audioCtx.createOscillator(), g=audioCtx.createGain(); o.type=type; o.frequency.setValueAtTime(hz, audioCtx.currentTime); g.gain.setValueAtTime(0.05, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+dur); o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime+dur); };
const playDing = () => playHz(880, 0.1); const playBloop = () => playHz(300, 0.15);
const triggerHaptic = () => navigator.vibrate && navigator.vibrate(60);

// ♻️ ROLLOVER & NOTIFICATIONS
function checkDayRollover() {
    const todayStr = getISODate();
    if (state.lastDate !== todayStr) {
        let yest = new Date(); yest.setDate(yest.getDate() - 1);
        if (state.lastDate === getISODate(yest) && state.baselineMet) state.streak++; else state.streak = 0;
        
        state.history.push({ date: state.lastDate, earned: state.todayLog.earned, focus: state.studyBlocks });
        if(state.history.length > 7) state.history.shift();
        
        state.dailyRoutine.forEach(h => h.checked = false); state.flexibleEngine.forEach(f => f.checked = false);
        state.studyBlocks = 0.00; state.baselineMet = false; state.lastDate = todayStr;
        state.todayLog = { earned: 0.00, spent: 0.00, banked: 0.00 }; state.timerEndTime = state.focusEndTime = null;
        saveState();
    }
    const dOpt = { weekday: 'long', month: 'long', day: 'numeric' };
    $('current-date').innerText = new Date().toLocaleDateString('en-US', dOpt);
}
document.addEventListener("visibilitychange", () => { checkDayRollover(); if(document.hidden && state.focusEndTime) cancelActiveSession(); });

// 🔄 UI RENDERER
function updateUI() {
    $('token-display').innerText = Math.max(0, state.tokens).toFixed(2); $('vault-display').innerText = "$"+state.vaultCash.toFixed(2);
    $('streak-display').innerText = state.streak; $('sound-status').innerText = state.soundEnabled ? "ON" : "OFF";
    $('theme-name').innerText = state.theme.toUpperCase();
    $('log-earned').innerText = "+"+state.todayLog.earned.toFixed(2); $('log-spent').innerText = "-"+state.todayLog.spent.toFixed(2); $('log-banked').innerText = "$"+state.todayLog.banked.toFixed(2);
    $('study-count').innerText = state.studyBlocks.toFixed(2); $('study-payout').innerText = "+"+(state.studyBlocks*1.5).toFixed(2)+" TOKENS";

    const renderList = (list, containerId, isRoutine) => {
        let total = 0; $(containerId).innerHTML = list.map((item, i) => {
            total += item.payout;
            return `<div class="task-item" onclick="promptTask(${i}, ${isRoutine})">
                <div class="task-icon">${eHtml(item.icon)}</div>
                <div class="task-details"><div class="task-title">${eHtml(item.name)}</div><div class="task-subtitle">+${item.payout.toFixed(2)} TOKENS</div></div>
                <div class="task-check ${item.checked?'checked':''}">${item.checked?'✓':''}</div>
            </div>`;
        }).join(''); return total;
    };
    const t = renderList(state.dailyRoutine, 'routine-container', true); renderList(state.flexibleEngine, 'flexible-container', false);
    $('routine-title').innerText = `DAILY ROUTINE (${t.toFixed(2)})`;

    $('companion-mood').innerText = state.focusEndTime ? "FOCUSED" : state.timerEndTime ? "CHILLING" : state.streak>=3 ? "PROUD" : state.baselineMet ? "HAPPY" : "WAITING";
}

// 🎯 TASK LOGIC
function promptTask(idx, isRoutine) {
    triggerHaptic(); const list = isRoutine ? state.dailyRoutine : state.flexibleEngine; const item = list[idx];
    if(item.checked) return playBloop();
    showModal(`LOCK IN [${item.name}] FOR +${item.payout.toFixed(2)}?`, [
        { text: 'CANCEL', click: closeModal },
        { text: 'LOCK IN', class: 'btn-green', click: () => {
            item.checked = true; state.tokens += item.payout; state.todayLog.earned += item.payout;
            if (isRoutine) {
                const wasMet = state.baselineMet; state.baselineMet = state.dailyRoutine.every(h => h.checked);
                if (!wasMet && state.baselineMet) confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
            }
            playDing(); saveState(); closeModal();
        }}
    ]);
}

// ⏱️ ENGINES
function startMasterEngine() {
    if(masterInterval) clearInterval(masterInterval); $('active-session-wrapper').style.display = 'block';
    masterInterval = setInterval(() => {
        const now = Date.now(); const end = state.timerEndTime || state.focusEndTime;
        if (!end) return clearInterval(masterInterval);
        const rem = end - now;
        $('session-title').innerText = state.focusEndTime ? "🍅 FOCUS SESSION" : "⏳ DOWNTIME BREAK";
        if(rem <= 0) {
            if(state.focusEndTime) {
                const earned = (state.focusMinutesTotal/60)*1.5; state.studyBlocks+= (state.focusMinutesTotal/60);
                state.tokens+= earned; state.todayLog.earned+= earned;
            }
            state.timerEndTime = state.focusEndTime = null; saveState();
            $('active-session-wrapper').style.display = 'none'; clearInterval(masterInterval); playDing(); triggerHaptic();
        } else {
            const s = Math.floor(rem/1000); $('session-countdown').innerText = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
        }
    }, 1000);
}
function cancelActiveSession() { triggerHaptic(); state.timerEndTime = state.focusEndTime = null; saveState(); $('active-session-wrapper').style.display = 'none'; }
function startFocusPomodoro(mins) {
    triggerHaptic(); if(state.timerEndTime || state.focusEndTime) return playBloop();
    state.focusEndTime = Date.now() + (mins*60000); state.focusMinutesTotal = mins; saveState(); startMasterEngine();
}
function promptSpendTokens(cost, mins, name) {
    triggerHaptic(); if(state.tokens < cost || state.focusEndTime) return playBloop();
    showModal(`REDEEM ${name} FOR -${cost.toFixed(2)}?\nSTART TIMER NOW?`, [
        { text: 'JUST SPEND', click: () => executeSpend(cost, null) },
        { text: 'START TIMER', class: 'btn-green', click: () => executeSpend(cost, mins) }
    ]);
}
function executeSpend(cost, mins) {
    state.tokens -= cost; state.todayLog.spent += cost;
    if(mins) { state.timerEndTime = Date.now() + (mins*60000); startMasterEngine(); }
    playBloop(); saveState(); closeModal();
}

function bankToVault() { triggerHaptic(); if(state.tokens>=1) { state.tokens-=1; state.vaultCash+=2.50; state.todayLog.banked+=2.50; playDing(); saveState(); } }
function spendVaultCash() { triggerHaptic(); 
    showModal(`SPEND VAULT CASH (MAX: $${state.vaultCash.toFixed(2)})`, [
        { text: 'CANCEL', click: closeModal },
        { text: 'SPEND', class: 'btn-green', click: () => { const amt = parseFloat($('mod-input').value); if(amt>0 && amt<=state.vaultCash) { state.vaultCash-=amt; playBloop(); saveState(); closeModal(); } }}
    ], `<input type="number" id="mod-input" class="modal-input" placeholder="0.00" step="0.01">`);
}

// 🛠️ DYNAMIC MODAL SYSTEM (Consolidates 10 modals into 1)
function showModal(title, buttons, extraHtml='') {
    const html = `<div style="text-align:center;font-size:22px;white-space:pre-line;margin-bottom:12px;">${eHtml(title)}</div>
        ${extraHtml}<div class="btn-row" style="margin-bottom:0;margin-top:12px;">
        ${buttons.map((b,i) => `<button class="btn btn-half ${b.class||''}" id="mod-btn-${i}">${b.text}</button>`).join('')}</div>`;
    $('dynamic-modal').innerHTML = html; $('modal-overlay').style.display = 'flex';
    buttons.forEach((b,i) => $(`mod-btn-${i}`).onclick = b.click);
}
function closeModal() { $('modal-overlay').style.display = 'none'; }
function toggleTheme() { triggerHaptic(); state.theme = state.theme==='light'?'dark':'light'; saveState(); document.body.className = `theme-${state.theme}`; }
function toggleSound() { triggerHaptic(); state.soundEnabled = !state.soundEnabled; saveState(); }
function adjustStudy(d) { triggerHaptic(); if(d>0) { state.studyBlocks+=1; state.tokens+=1.5; state.todayLog.earned+=1.5; playDing(); } else if(state.studyBlocks>=1 && state.tokens>=1.5) { state.studyBlocks-=1; state.tokens-=1.5; state.todayLog.earned=Math.max(0, state.todayLog.earned-1.5); playBloop(); } saveState(); }

// 📊 STATS CHART GENERATOR
function showStatsChart() {
    triggerHaptic();
    const dates = state.history.map(h => h.date.slice(5)); const data = state.history.map(h => h.earned);
    showModal("7-DAY PERFORMANCE", [{text:"CLOSE", click: closeModal, class:"btn-green"}], `<canvas id="chartCanvas" style="background:#fff;border-radius:8px;padding:4px;"></canvas>`);
    new Chart($('chartCanvas'), { type: 'bar', data: { labels: dates, datasets: [{ label: 'Tokens', data: data, backgroundColor: '#000' }] }, options: { scales: { y: { beginAtZero: true } } }});
}

if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
