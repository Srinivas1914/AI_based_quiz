// ===== SACET QUIZ — STORAGE ENGINE =====
let socket;
if (typeof io !== 'undefined') {
  const token = localStorage.getItem('sq_token');
  socket = io({
    auth: { token }
  });
  socket.on('sync', (data) => {
    localStorage.setItem(data.key, data.val);
    window.dispatchEvent(new CustomEvent('storage_sync', { detail: { key: data.key } }));
  });
}

const KEYS = {
  QUIZ:        'sq_quiz',
  TEAMS:       'sq_teams',
  QUESTIONS:   'sq_questions',
  SESSION:     'sq_session',
  ACTIVITY:    'sq_activity',
  SETTINGS:    'sq_settings',
  ROUNDS:      'sq_rounds',
  USERS:       'sq_users',
  PARTICIPANTS:'sq_participants',
  LOGIN_STATUS:'sq_login_status',  // {teamId: {loggedIn, loginTime, name}}
  CAM_PREFIX:  'sq_cam_',          // sq_cam_{teamId} = base64 frame
  CAM_STATUS:  'sq_cam_status',    // {teamId: {tabHidden, lastSeen, suspicious}}
  ALERTS:      'sq_alerts',        // [{teamId, type, time, msg, dismissed}]
  FEEDBACK:    'sq_feedback',      // [{name, text, time}]
  LOGIN_HISTORY: 'sq_login_history', // [{name, role, loginTime, logoutTime}]
  QUIZ_REQUESTS: 'sq_quiz_requests', // [{id, username, password, collegeName, collegeCode, status, time}]
  MANAGED_QUIZZES: 'sq_managed_quizzes', // [{quizId, adminId, collegeName, collegeCode, expiry, status}]
};

const DEFAULT_SETTINGS = {
  adminUsername: 'srinivas',
  adminPassword: 'sri@1119',
  captchaCode: 'QUIZ2026',
  defaultTimePerQuestion: 60,
  participantTimeLimit: 30,   // seconds participants get to answer
  overallTimeLimit: 0,
  globalInstructions: '',
  prizes: ['🏆 Gold Medal + ₹5000', '🥈 Silver Medal + ₹3000', '🥉 Bronze Medal + ₹1000'],
};

// ─── QUIZ STATE ────────────────────────────────────────────────
// Flow per question:
//   questionStartTeamIdx → team answers OR passes
//   CORRECT or WRONG → question ends immediately → next Q starts with (questionStartTeamIdx+1)%N
//   PASS → next team in cycle; if all N teams pass → participantTurn = true with timer
//   participantTimer expires → next Q starts with (questionStartTeamIdx+1)%N
const DEFAULT_QUIZ = {
  status: 'idle',          // idle|round_intro|running|paused|participant_turn|round_end|finished
  currentRoundIdx: 0,
  currentQInRound: 0,
  globalQIdx: 0,

  questionStartTeamIdx: 0, // team index that STARTED this question (rotates each Q)
  currentTeamIdx: 0,       // who is currently on the hot seat
  passChain: [],           // teamIds that have already passed this Q

  participantTurn: false,         // true when all teams passed → participants answer
  participantTimerStart: null,
  participantTimeLimit: 30,

  timerStart: null,
  timerLimit: 60,

  roundTimerStart: null,
  roundTimeLimit: 0,

  competitionStart: null,
  overallTimeLimit: 0,

  _timerEndHandled: false,
  _roundTimerEnded: false,
  _participantTimerHandled: false,
};

// ─── HELPERS ──────────────────────────────────────────────────
function load(key, def=null){
  try{ const v=localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch(e){ return def; }
}
function save(key, val){
  const str = JSON.stringify(val);
  localStorage.setItem(key, str);
  if(socket && socket.connected){
    // NEVER sync the local user session or individual camera frames to everyone
    if(key !== KEYS.SESSION && !key.startsWith(KEYS.CAM_PREFIX)){
      const token = localStorage.getItem('sq_token');
      socket.emit('sync', { key, val: str, token });
    }
  }
}


function getPKey(key) {
  const s = Store.getSession();
  if (!s || !s.quizId) return key;
  // Global keys that shouldn't be partitioned
  if ([KEYS.SESSION, KEYS.USERS, KEYS.LOGIN_HISTORY, KEYS.QUIZ_REQUESTS, KEYS.MANAGED_QUIZZES].includes(key)) return key;
  return `${key}_${s.quizId}`;
}

// ─── STORE ────────────────────────────────────────────────────
const Store = {
  // Settings
  getSettings(){ return { ...DEFAULT_SETTINGS, ...(load(KEYS.SETTINGS)||{}) }; },
  saveSettings(s){ save(KEYS.SETTINGS, s); },

  // Quiz
  getQuiz(){ return { ...DEFAULT_QUIZ, ...(load(getPKey(KEYS.QUIZ))||{}) }; },
  saveQuiz(q){ save(getPKey(KEYS.QUIZ), q); },

  // Users
  getUsers(){ return load(KEYS.USERS, []); },
  saveUsers(u){ save(KEYS.USERS, u); },
  getUserById(id){ return Store.getUsers().find(u=>u.id===id)||null; },
  getUserByLogin(username,password){ return Store.getUsers().find(u=>u.username===username&&u.password===password)||null; },
  updateUser(id, patch){
    const list=Store.getUsers(), idx=list.findIndex(u=>u.id===id);
    if(idx>=0){ list[idx]={...list[idx],...patch}; Store.saveUsers(list); }
  },
  deleteUser(id){ Store.saveUsers(Store.getUsers().filter(u=>u.id!==id)); },
  addUser(u){ const list=Store.getUsers(); list.push(u); Store.saveUsers(list); },

  // Teams — sorted by teamNumber
  getTeams(quizId){ 
    const pk = quizId ? `${KEYS.TEAMS}_${quizId}` : getPKey(KEYS.TEAMS);
    return (load(pk,[])).sort((a,b)=>(a.teamNumber||0)-(b.teamNumber||0)); 
  },
  saveTeams(t){ save(getPKey(KEYS.TEAMS), t); },
  getActiveTeams(){ return Store.getTeams().filter(t=>t.status==='active'); },
  getTeamById(id){ return Store.getTeams().find(t=>t.id===id)||null; },
  getTeamByLogin(u,p, quizId){ return Store.getTeams(quizId).find(t=>t.username===u&&t.password===p&&t.status==='active')||null; },
  updateTeam(id, patch){
    const list=load(getPKey(KEYS.TEAMS),[]); // raw unsorted for update
    const idx=list.findIndex(t=>t.id===id);
    if(idx>=0){ list[idx]={...list[idx],...patch}; save(getPKey(KEYS.TEAMS),list); }
  },
  deleteTeam(id){ save(getPKey(KEYS.TEAMS), load(getPKey(KEYS.TEAMS),[]).filter(t=>t.id!==id)); },

  // Questions
  getQuestions(){ return load(getPKey(KEYS.QUESTIONS), []); },
  saveQuestions(q){ save(getPKey(KEYS.QUESTIONS), q); },

  // Rounds
  getRounds(){ return load(getPKey(KEYS.ROUNDS), []); },
  saveRounds(r){ save(getPKey(KEYS.ROUNDS), r); },

  // Participants
  getParticipants(){ return load(getPKey(KEYS.PARTICIPANTS), []); },
  saveParticipants(p){ save(getPKey(KEYS.PARTICIPANTS), p); },
  getParticipantById(id){ return Store.getParticipants().find(p=>p.id===id)||null; },
  upsertParticipant(id, name, patch){
    const list=Store.getParticipants();
    const idx=list.findIndex(p=>p.id===id);
    if(idx>=0){ list[idx]={...list[idx],...patch}; }
    else { list.push({ id, name, score:0, correctCount:0, answers:{}, ...patch }); }
    Store.saveParticipants(list);
  },

  // Login status (which teams are signed in)
  getLoginStatus(){ return load(getPKey(KEYS.LOGIN_STATUS), {}); },
  setTeamLogin(teamId, teamName, loggedIn){
    const s=Store.getLoginStatus();
    s[teamId] = { loggedIn, teamName, loginTime: loggedIn ? Date.now() : (s[teamId]?.loginTime||null) };
    save(getPKey(KEYS.LOGIN_STATUS), s);

    // Also mark the team as 'active' in the teams list if logged in
    if(loggedIn){
      const teams = Store.getTeams();
      const idx = teams.findIndex(t => t.id === teamId);
      if(idx >= 0 && teams[idx].status !== 'active'){
        teams[idx].status = 'active';
        Store.saveTeams(teams);
      }
    }
  },
  clearLoginStatus(){ save(getPKey(KEYS.LOGIN_STATUS), {}); },
  
  // Login History
  getLoginHistory(){ return load(KEYS.LOGIN_HISTORY, []); },
  addLoginRecord(name, role){
    const list = Store.getLoginHistory();
    list.unshift({ id: genId(), name, role, loginTime: Date.now(), logoutTime: null });
    if(list.length > 500) list.pop();
    save(KEYS.LOGIN_HISTORY, list);
    return list[0].id; // Return record ID for logout update
  },
  updateLogout(id){
    const list = Store.getLoginHistory();
    const r = list.find(x => x.id === id);
    if(r) { r.logoutTime = Date.now(); save(KEYS.LOGIN_HISTORY, list); }
  },

  // Camera frames (base64 JPEG per team)
  saveCamFrame(teamId, base64){
    const key = getPKey(KEYS.CAM_PREFIX+teamId);
    localStorage.setItem(key, base64);
    if(socket && socket.connected) socket.emit('sync', { key: key, val: base64 });
  },
  getCamFrame(teamId){ return localStorage.getItem(getPKey(KEYS.CAM_PREFIX+teamId))||null; },
  clearCamFrame(teamId){ localStorage.removeItem(getPKey(KEYS.CAM_PREFIX+teamId)); },

  // Camera status (tab visibility, suspicious flags)
  getCamStatus(){ return load(getPKey(KEYS.CAM_STATUS), {}); },
  updateCamStatus(teamId, patch){
    const s=Store.getCamStatus();
    s[teamId]={ ...(s[teamId]||{}), ...patch };
    save(getPKey(KEYS.CAM_STATUS), s);
  },

  // Alerts
  getAlerts(){ return load(getPKey(KEYS.ALERTS), []); },
  addAlert(alert){ const list=Store.getAlerts(); list.unshift(alert); if(list.length>100) list.pop(); save(getPKey(KEYS.ALERTS),list); },
  dismissAlert(id){ const list=Store.getAlerts(); const idx=list.findIndex(a=>a.id===id); if(idx>=0){list[idx].dismissed=true; save(getPKey(KEYS.ALERTS),list);} },
  clearAlerts(){ save(getPKey(KEYS.ALERTS),[]); },

  addActivity(text, type='info', isSuper=false){
    const sess = this.getSession();
    const quizId = isSuper ? null : sess.quizId;
    
    // 1. Log to the specific quiz key (isolated)
    const key = getPKey(KEYS.ACTIVITY); 
    const activity = { 
      id: genId(), text, type, isSuper, quizId,
      time: new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),
      timestamp: Date.now()
    };
    
    const list = load(key, []);
    list.unshift(activity);
    if(list.length > 300) list.pop();
    save(key, list);

    // 2. ALSO log to global key for Superadmin visibility if it wasn't already global
    if (quizId) {
      const globalList = load(KEYS.ACTIVITY, []);
      globalList.unshift(activity);
      if (globalList.length > 1000) globalList.pop();
      save(KEYS.ACTIVITY, globalList);
    }
  },
  getActivity(forcedQuizId = undefined){
    const sess = this.getSession();
    // If sess is Superadmin and no specific quizId is forced, return the GLOBAL list
    if (sess.isSuper && forcedQuizId === undefined) {
      return load(KEYS.ACTIVITY, []);
    }
    // Otherwise return the list for the current (or forced) quizId
    const key = (forcedQuizId !== undefined) ? `${KEYS.ACTIVITY}_${forcedQuizId}` : getPKey(KEYS.ACTIVITY);
    return load(key, []);
  },
  clearActivity(){ 
    const sess = this.getSession();
    save(getPKey(KEYS.ACTIVITY), []); 
    if (sess.isSuper) save(KEYS.ACTIVITY, []); // Clear global too if superadmin
  },

  // Session
  getSession(){ return load(KEYS.SESSION, null); },
  setSession(s){ save(KEYS.SESSION, s); },
  clearSession(){
    localStorage.removeItem(KEYS.SESSION);
    localStorage.removeItem('sq_token');
    if(socket && socket.connected) {
      const token = localStorage.getItem('sq_token');
      socket.emit('sync', { key: KEYS.SESSION, val: null, token });
    }
  },
  setToken(t){ localStorage.setItem('sq_token', t); },
  getToken(){ return localStorage.getItem('sq_token'); },


  // Feedback
  getFeedback(){ return load(getPKey(KEYS.FEEDBACK), []); },
  addFeedback(name, text){
    const list = Store.getFeedback();
    list.push({ name, text, time: new Date().toLocaleString('en-IN') });
    save(getPKey(KEYS.FEEDBACK), list);
  },

  // Quiz Requests
  getQuizRequests(){ return load(KEYS.QUIZ_REQUESTS, []); },
  saveQuizRequests(r){ save(KEYS.QUIZ_REQUESTS, r); },
  addQuizRequest(r){ const list=Store.getQuizRequests(); list.push({ ...r, id: genId(), time: Date.now(), status: 'pending' }); Store.saveQuizRequests(list); },
  deleteQuizRequest(id){ const list=Store.getQuizRequests().filter(r=>r.id!==id); Store.saveQuizRequests(list); },

  // Managed Quizzes
  getManagedQuizzes(){ return load(KEYS.MANAGED_QUIZZES, []); },
  saveManagedQuizzes(q){ save(KEYS.MANAGED_QUIZZES, q); },
  addManagedQuiz(q){ const list=Store.getManagedQuizzes(); list.push(q); Store.saveManagedQuizzes(list); },
  generateQuizId(){ return Math.random().toString(36).substr(2,6).toUpperCase(); },

  // Ensure the server has all our data (useful for Admin on startup)
  pushToBackend(){
    if(!socket || !socket.connected) return;
    const token = localStorage.getItem('sq_token');
    Object.values(KEYS).forEach(key => {
      if(key === KEYS.SESSION || key === KEYS.LOGIN_STATUS || key.startsWith('sq_cam_')) return;
      const val = localStorage.getItem(key);
      if(val) socket.emit('sync', { key, val, token });
    });

  },
  // Quiz Summary for Super Admin
  getQuizSummary(quizId){
    const qKey = `${KEYS.QUIZ}_${quizId}`;
    const tKey = `${KEYS.TEAMS}_${quizId}`;
    const aKey = `${KEYS.ACTIVITY}_${quizId}`;
    
    const qObj = load(qKey, DEFAULT_QUIZ);
    const teams = load(tKey, []);
    const acts = load(aKey, []);
    
    return {
      status: qObj.status,
      round: qObj.currentRoundIdx + 1,
      teamCount: teams.length,
      activities: acts.slice(0, 5),
      lastSeen: acts[0]?.time || "—"
    };
  }
};

// Auto-push if we are admin and just connected
if (socket) {
  socket.on('connect', () => {
    const s = Store.getSession();
    if(s && s.role === 'admin') Store.pushToBackend();
  });
}

// ─── ROUND HELPERS ─────────────────────────────────────────────
function getRoundQRange(rounds, idx){
  let start=0;
  for(let i=0;i<idx;i++) start += (rounds[i]?.questionCount||0);
  const count = rounds[idx]?.questionCount||0;
  return { start, end: start+count-1, count };
}
function getTotalConfiguredQs(rounds){ return rounds.reduce((s,r)=>s+(r.questionCount||0),0); }

// ─── QUIZ ADVANCE HELPER (called by BOTH team.js and admin.js) ──
// Moves to the next question with proper cyclic team assignment.
// MUST be called only once per question-end (guard with _advancing flag).
function advanceToNextQuestion(){
  const quiz = Store.getQuiz();
  if(quiz._advancing) return;           // prevent double-call
  quiz._advancing = true;
  Store.saveQuiz(quiz);

  const rounds = Store.getRounds();
  const questions = Store.getQuestions();
  const teams = Store.getActiveTeams();
  const range = getRoundQRange(rounds, quiz.currentRoundIdx);

  // Determine the team that will START the NEXT question
  const nextStartTeam = (quiz.questionStartTeamIdx + 1) % teams.length;

  const nextQInRound = quiz.currentQInRound + 1;
  const nextGlobal   = quiz.globalQIdx + 1;
  const r = rounds[quiz.currentRoundIdx];

  if(nextQInRound >= range.count || nextGlobal >= questions.length){
    // Round over
    const newQ = { ...quiz,
      status: 'round_end',
      passChain: [],
      participantTurn: false,
      participantTimerStart: null,
      _timerEndHandled: false,
      _participantTimerHandled: false,
      _advancing: false,
    };
    Store.saveQuiz(newQ);
    Store.addActivity(`🏁 Round ${quiz.currentRoundIdx+1} ended`, 'success');
    return;
  }

  const newQ = { ...quiz,
    status: 'running',
    currentQInRound: nextQInRound,
    globalQIdx: nextGlobal,
    questionStartTeamIdx: nextStartTeam,
    currentTeamIdx: nextStartTeam,
    passChain: [],
    participantTurn: false,
    participantTimerStart: null,
    timerStart: Date.now(),
    timerLimit: r?.timePerQuestion || 60,
    _timerEndHandled: false,
    _participantTimerHandled: false,
    _advancing: false,
  };
  Store.saveQuiz(newQ);
  Store.addActivity(`➡ Q${nextQInRound+1} → <strong>${teams[nextStartTeam]?.name||'?'}</strong>`, 'info');
}

// ─── ID / AUTH / TOAST / TIME ──────────────────────────────────
function genId(){ return '_'+Math.random().toString(36).substr(2,9); }

function requireRole(role){
  const s=Store.getSession();
  if(!s||s.role!==role){ window.location.href='/index.html'; return null; }
  return s;
}
function requireAnyAuth(){
  const s=Store.getSession();
  if(!s){ window.location.href='/index.html'; return null; }
  return s;
}

function toast(msg, type='info', dur=3200){
  let c=document.getElementById('toast-container');
  if(!c){ c=document.createElement('div'); c.id='toast-container'; document.body.appendChild(c); }
  const icons={success:'✓',error:'✕',info:'ℹ',warning:'⚠'};
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<span class="toast-icon">${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(110%)'; setTimeout(()=>el.remove(),300); }, dur);
}

function formatTime(sec){
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  if(h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ─── CROSS-TAB SYNC ────────────────────────────────────────────
function onUpdate(cb){
  window.addEventListener('storage', e=>{
    if(!e.key) return;
    const isBaseKey = Object.values(KEYS).some(k => e.key === k || e.key.startsWith(k + '_'));
    if(isBaseKey || e.key.startsWith('sq_cam_')){
      cb({ key: e.key });
    }
  });
  window.addEventListener('storage_sync', e => {
    cb({ key: e.detail.key });
  });
}
