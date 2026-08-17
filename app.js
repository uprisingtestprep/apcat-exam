/* APCAT Exam Simulator, Application Logic */

const ACCESS_CODE  = "APCAT9000";
const EXAM_SECONDS = 8100;
const PASSING_PCT  = 70;
const STORAGE_KEY  = "apcat_exam_state_v1";
const SIM_Q_COUNT  = 120;  // simulator serves this project's configured pool size (config.json exam.sim_questions)
const CLUSTER_LABEL = "Case";
const DOMAIN_LABELS = {"judgement": "Judgement", "observation_skills": "Observation Skills", "learning_and_memory_recall": "Learning and Memory Recall", "written_communication": "Written Communication", "problem_analysis": "Problem Analysis"};  // maps domain key -> human-readable label for display
function domainLabel(key) { return DOMAIN_LABELS[key] || key || ""; }

let questions = [];
let state = {
  phase: "gate", answers: {}, flags: {},
  current: 1, timeLeft: EXAM_SECONDS,
  submitted: false, startTime: null, bookletId: null,
};
let timerInterval = null;

// ── boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const allQ = (window.EXAM_QUESTIONS || []).slice();
  // restoreState BEFORE picking questions, so a resumed (not yet submitted)
  // attempt keeps the same memory booklet it already showed the reader —
  // see pickBookletId, which reuses state.bookletId when still valid.
  restoreState();
  questions = pickQuestions(allQ, SIM_Q_COUNT);

  document.getElementById("access-gate").style.display = "flex";
  document.getElementById("app").style.display = "none";
  setupAccessGate();
});

// Shuffle by UNIT, never by individual question. A cluster is several
// questions sharing one case or passage: they must stay together and in their
// authored order, because later questions refer back to the same material.
// Shuffling every question individually scatters them across the exam, so a
// candidate meets question 6 about a passage before ever seeing the passage.
// That bug reached CNPLE's LIVE site and only a real browser found it.
// Truncation is done on a unit boundary too, so a cluster is never cut in half.
function clusterId(q) {
  return q.cluster_id || q.case_id || q.passage_id || null;
}

// APCAT's real exam gives one memory booklet per SITTING, not per question:
// study it once, then several questions later test recall of it with no way
// to look back. So a single simulated attempt must draw its Learning and
// Memory Recall questions from exactly ONE booklet_id, never a mix of two,
// or the on-screen booklet would only match some of the recall questions.
function pickBookletId(units) {
  const ids = new Set();
  for (const u of units) {
    const q0 = u[0];
    if (q0.domain === "learning_and_memory_recall" && q0.booklet_id) ids.add(q0.booklet_id);
  }
  const arr = Array.from(ids);
  if (!arr.length) return null;
  if (state.bookletId && arr.includes(state.bookletId)) return state.bookletId;
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickQuestions(all, limit) {
  const units = [], byId = new Map();
  for (const q of all) {
    const c = clusterId(q);
    if (!c) { units.push([q]); continue; }
    if (!byId.has(c)) { const u = []; byId.set(c, u); units.push(u); }
    byId.get(c).push(q);
  }
  const bookletId = pickBookletId(units);
  state.bookletId = bookletId;
  const eligible = units.filter(u => {
    const q0 = u[0];
    if (q0.domain === "learning_and_memory_recall" && q0.booklet_id) {
      return q0.booklet_id === bookletId;
    }
    return true;
  });
  shuffleUnits(eligible);

  const out = [];
  for (const u of eligible) {
    if (out.length + u.length > limit) continue;   // never split a cluster
    for (const q of u) out.push(q);
  }
  breakAnswerRuns(out);
  return out;
}

function shuffleUnits(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Prevent 3+ consecutive same correct answer. Only ever swaps two STANDALONE
// questions: swapping a clustered one would undo the grouping above.
function breakAnswerRuns(arr) {
  const free = i => arr[i] && !clusterId(arr[i]);
  for (let i = 2; i < arr.length; i++) {
    if (arr[i].correct === arr[i-1].correct && arr[i].correct === arr[i-2].correct) {
      if (!free(i)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        if (free(j) && arr[j].correct !== arr[i-1].correct) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
}

// ── access gate ───────────────────────────────────────────────────────────────
function setupAccessGate() {
  const attempt = () => {
    const val = document.getElementById("access-code-input").value.trim().toUpperCase();
    if (val === ACCESS_CODE) {
      document.getElementById("access-gate").style.display = "none";
      startExam();
    } else {
      const err = document.getElementById("access-error");
      err.textContent = "Incorrect access code. Please try again.";
      document.getElementById("access-code-input").value = "";
      document.getElementById("access-code-input").focus();
    }
  };
  document.getElementById("access-btn").addEventListener("click", attempt);
  document.getElementById("access-code-input").addEventListener("keydown",
    e => { if (e.key === "Enter") attempt(); });
}

// ── exam start ────────────────────────────────────────────────────────────────
function startExam() {
  if (state.submitted) {
    localStorage.removeItem(STORAGE_KEY);
    state = { phase: "gate", answers: {}, flags: {}, current: 1, timeLeft: EXAM_SECONDS, submitted: false, startTime: null, bookletId: state.bookletId };
  }
  const isFreshAttempt = !state.startTime;

  const launchApp = () => {
    document.getElementById("app").style.display = "flex";
    if (!state.startTime) state.startTime = Date.now();
    renderQuestion();
    startTimer();
    buildGrid();
    document.getElementById("submit-btn").addEventListener("click", confirmSubmit);
    document.getElementById("flag-btn").addEventListener("click",   toggleFlag);
    document.getElementById("prev-btn").addEventListener("click",   () => navigate(-1));
    document.getElementById("next-btn").addEventListener("click",   () => navigate(1));
    document.getElementById("map-btn").addEventListener("click",    openMapModal);
    document.getElementById("map-close").addEventListener("click",  closeMapModal);
    document.getElementById("map-backdrop").addEventListener("click", closeMapModal);
    document.addEventListener("keydown", keyHandler);
  };

  // Only a brand-new attempt shows the booklet. A resumed (already in
  // progress) attempt already saw it once — showing it again on every page
  // reload would let a reader keep re-studying mid-exam, defeating the point.
  if (isFreshAttempt && state.bookletId) {
    showBookletScreen(launchApp);
  } else {
    launchApp();
  }
}

// ── memory booklet lock screen ───────────────────────────────────────────────
function showBookletScreen(onDone) {
  const booklet = (window.MEMORY_BOOKLETS || []).find(b => b.id === state.bookletId);
  const screen  = document.getElementById("booklet-screen");
  if (!booklet || !screen) { onDone(); return; }

  const body = document.getElementById("booklet-body");
  const items = (booklet.memorize_items || []).map(i =>
    `<div class="booklet-item"><span class="booklet-item-label">${escapeHTML(i.label)}:</span> ${escapeHTML(i.value)}</div>`
  ).join("");
  const ar = booklet.arrest_report || {};
  const arFields = [
    ["subject_name", "Subject Name"], ["date_of_birth", "Date of Birth"],
    ["height_weight", "Height / Weight"], ["charge", "Charge"],
    ["arresting_officer", "Arresting Officer"], ["time_of_arrest", "Time of Arrest"],
    ["location_of_arrest", "Location of Arrest"], ["vehicle_involved", "Vehicle Involved"],
  ].filter(([k]) => ar[k]).map(([k, label]) =>
    `<div class="booklet-item"><span class="booklet-item-label">${escapeHTML(label)}:</span> ${escapeHTML(ar[k])}</div>`
  ).join("");

  body.innerHTML =
    `<h3 class="booklet-section-title">Crime Bulletin</h3>` +
    `<p class="booklet-text">${escapeHTML(booklet.crime_bulletin || "")}</p>` +
    `<h3 class="booklet-section-title">Information to Memorize</h3>${items}` +
    `<h3 class="booklet-section-title">Suspect Description</h3>` +
    `<p class="booklet-text">${escapeHTML(booklet.suspect_description || "")}</p>` +
    `<h3 class="booklet-section-title">Arrest Report Form</h3>${arFields}`;

  document.getElementById("access-gate").style.display = "none";
  screen.style.display = "flex";

  const beginBtn = document.getElementById("booklet-begin-btn");
  const timerEl  = document.getElementById("booklet-timer");
  const studySeconds  = (booklet.study_minutes || 15) * 60;
  // The real exam always waits the full study period. A self-practice tool
  // that forced the full period on every single replay would just train
  // people to tab away, so only the first minute is a hard wait; the rest
  // of the real timer still counts down for realism and can be watched out.
  const minWaitSeconds = Math.min(60, studySeconds);
  let left = studySeconds;
  beginBtn.disabled = true;

  const finish = () => { clearInterval(tick); screen.style.display = "none"; onDone(); };
  const tick = setInterval(() => {
    left--;
    const m = Math.floor(Math.max(left, 0) / 60), s = Math.max(left, 0) % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
    const elapsed = studySeconds - left;
    if (elapsed >= minWaitSeconds && beginBtn.disabled) {
      beginBtn.disabled = false;
      beginBtn.textContent = "Begin Test";
    } else if (beginBtn.disabled) {
      beginBtn.textContent = `Begin Test (available in ${minWaitSeconds - elapsed}s)`;
    }
    if (left <= 0) finish();
  }, 1000);
  timerEl.textContent = `${Math.floor(studySeconds/60)}:${String(studySeconds%60).padStart(2,"0")}`;
  beginBtn.textContent = `Begin Test (available in ${minWaitSeconds}s)`;

  beginBtn.onclick = () => { if (!beginBtn.disabled) finish(); };
}

// ── timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (state.submitted) return;
    state.timeLeft = Math.max(0, EXAM_SECONDS - Math.floor((Date.now() - state.startTime) / 1000));
    updateTimerDisplay();
    if (state.timeLeft === 0) submitExam();
    saveState();
  }, 1000);
}

function updateTimerDisplay() {
  const h = Math.floor(state.timeLeft / 3600);
  const m = Math.floor((state.timeLeft % 3600) / 60);
  const s = state.timeLeft % 60;
  document.getElementById("timer-display").textContent =
    h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
           : `${m}:${String(s).padStart(2,"0")}`;
}

// ── render ─────────────────────────────────────────────────────────────────────
// Any renderer that injects content as HTML must escape it first. This helper
// was missing from the scaffold entirely, so every cluster/passage renderer
// copied in from a finished project threw ReferenceError on its first item.
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A cluster's shared text is shown above EVERY question in that cluster, so a
// candidate never has to page backwards to reread it. It scrolls inside its own
// box: unbounded, a 450 word passage pushes the stem and options below the fold.
function renderCluster(q) {
  const wrap = document.getElementById("q-cluster-wrap");
  if (!wrap) return;
  const text = q.cluster_text || q.case_text || q.passage_text || "";
  if (!text) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
  const body = String(text).split("\n").filter(l => l.trim())
    .map(l => `<p>${escapeHTML(l.trim())}</p>`).join("");
  wrap.innerHTML = `<div class="cluster-label">${CLUSTER_LABEL} `
                 + `${escapeHTML(clusterId(q) || "")}</div>`
                 + `<div class="cluster-body">${body}</div>`;
  wrap.style.display = "block";
}

function renderQuestion() {
  const q = questions[state.current - 1];
  if (!q) return;
  renderCluster(q);
  document.getElementById("q-counter").textContent = `Question ${state.current} of ${questions.length}`;
  document.getElementById("q-domain").textContent  = domainLabel(q.domain);
  document.getElementById("question-text").textContent = q.question;
  const imgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    imgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    imgWrap.style.display = "block";
  } else {
    imgWrap.innerHTML = "";
    imgWrap.style.display = "none";
  }
  const fi = document.getElementById("q-flag-indicator");
  fi.style.display = state.flags[state.current] ? "inline-block" : "none";

  document.getElementById("explanation-box").style.display = "none";

  const ol = document.getElementById("options-list");
  ol.innerHTML = "";
  const chosen = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    div.className = "option" + (chosen === letter ? " selected" : "");
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    div.addEventListener("click", () => selectAnswer(state.current, letter));
    ol.appendChild(div);
  });

  // Scroll question panel to top on navigation
  const panel = document.querySelector(".question-panel");
  if (panel) panel.scrollTop = 0;

  updateProgress();
  updateGrid();
}

function selectAnswer(qNum, letter) {
  if (state.submitted) return;
  state.answers[qNum] = letter;
  renderQuestion();
  saveState();
}

function navigate(dir) {
  const next = state.current + dir;
  if (next >= 1 && next <= questions.length) {
    state.current = next;
    renderQuestion();
  }
}

function toggleFlag() {
  state.flags[state.current] = !state.flags[state.current];
  renderQuestion();
  saveState();
}

function updateProgress() {
  const pct = Object.keys(state.answers).length / questions.length * 100;
  document.getElementById("progress-bar").style.width = pct + "%";
}

// ── question map modal ────────────────────────────────────────────────────────
function openMapModal() {
  updateGrid();
  document.getElementById("map-modal").style.display = "flex";
}

function closeMapModal() {
  document.getElementById("map-modal").style.display = "none";
}

// ── grid ──────────────────────────────────────────────────────────────────────
function buildGrid() {
  const grid = document.getElementById("q-grid");
  grid.innerHTML = "";
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.createElement("button");
    btn.className = "grid-btn";
    btn.id = `gb-${i}`;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      state.current = i;
      closeMapModal();
      renderQuestion();
    });
    grid.appendChild(btn);
  }
}

function updateGrid() {
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.getElementById(`gb-${i}`);
    if (!btn) continue;
    btn.className = "grid-btn" +
      (state.answers[i]  ? " answered" : "") +
      (state.flags[i]    ? " flagged"  : "") +
      (state.current===i ? " active"   : "");
  }
}

// ── submit ────────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const unanswered = questions.length - Object.keys(state.answers).length;
  if (unanswered > 0) {
    alert(`You must answer all ${questions.length} questions before submitting.\n\n${unanswered} question${unanswered > 1 ? "s" : ""} still unanswered.\n\nTap "Question Map" to find unanswered questions.`);
    return;
  }
  if (confirm("Submit your exam now?")) submitExam();
}

function submitExam() {
  clearInterval(timerInterval);
  state.submitted = true;
  saveState();
  showResults();
}

// ── results ───────────────────────────────────────────────────────────────────
function showResults() {
  document.getElementById("app").style.display = "none";
  document.getElementById("results-screen").style.display = "flex";

  let correct = 0;
  const domainStats = {};
  questions.forEach((q, idx) => {
    const num = idx + 1;
    const userAns = state.answers[num];
    const isRight = userAns === q.correct;
    if (isRight) correct++;
    const dom = q.domain || "Other";
    if (!domainStats[dom]) domainStats[dom] = { correct: 0, total: 0 };
    domainStats[dom].total++;
    if (isRight) domainStats[dom].correct++;
  });

  const pct  = Math.round(correct / questions.length * 100);
  const passed = pct >= PASSING_PCT;
  document.getElementById("res-status").textContent = passed ? "PASS" : "FAIL";
  document.getElementById("res-status").style.color = passed ? "#059669" : "#DC2626";
  document.getElementById("res-score").textContent  = `${correct} / ${questions.length} (${pct}%)`;

  const domDiv = document.getElementById("res-domains");
  domDiv.innerHTML = "";
  Object.entries(domainStats).forEach(([dom, s]) => {
    const dp = Math.round(s.correct / s.total * 100);
    domDiv.innerHTML += `<div class="res-domain-row">
      <span class="res-domain-name">${domainLabel(dom)}</span>
      <div class="res-domain-bar-wrap"><div class="res-domain-bar" style="width:${dp}%;background:#1B3A6B"></div></div>
      <span class="res-domain-pct">${dp}%</span>
    </div>`;
  });

  document.getElementById("res-review-btn").addEventListener("click", () => {
    state.submitted = true;
    document.getElementById("results-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    renderReview();
  });
  document.getElementById("res-restart-btn").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function renderReview() {
  const ol = document.getElementById("options-list");
  const q  = questions[state.current - 1];
  if (!q) return;
  document.getElementById("q-counter").textContent = `Review, Question ${state.current} of ${questions.length}`;
  document.getElementById("question-text").textContent = q.question;
  const revImgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    revImgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    revImgWrap.style.display = "block";
  } else {
    revImgWrap.innerHTML = "";
    revImgWrap.style.display = "none";
  }
  ol.innerHTML = "";
  const userAns = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    let cls = "option";
    if (letter === q.correct)      cls += " correct";
    else if (letter === userAns)   cls += " incorrect";
    div.className = cls;
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    ol.appendChild(div);
  });

  const box  = document.getElementById("explanation-box");
  const expl = document.getElementById("explanation-text");
  if (q.explanation) {
    expl.textContent = q.explanation;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }

  document.getElementById("prev-btn").onclick = () => { navigate(-1); renderReview(); };
  document.getElementById("next-btn").onclick = () => { navigate(1);  renderReview(); };
}

// ── persistence ───────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}
function restoreState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { const s = JSON.parse(saved); Object.assign(state, s); }
  } catch(e) {}
}

// ── keyboard ──────────────────────────────────────────────────────────────────
function keyHandler(e) {
  const letter = e.key.toUpperCase();
  const q = questions[state.current - 1];
  if (["A", "B", "C", "D", "E"].includes(letter) && !e.ctrlKey && !e.metaKey && q?.options?.[letter]) {
    selectAnswer(state.current, letter);
  }
  if (e.key === "ArrowRight" && state.current < questions.length) navigate(1);
  if (e.key === "ArrowLeft"  && state.current > 1)                navigate(-1);
  if (e.key === "Escape") closeMapModal();
}
