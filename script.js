(() => {
  'use strict';

  const STORAGE_KEY = 'soft-signal-v1';
  const DEFAULTS = {
    durations: { focus: 25, shortBreak: 5, longBreak: 15 },
    preferences: { chime: false, autoTransition: false },
    sounds: {
      rain: { enabled: false, volume: 38 },
      wind: { enabled: false, volume: 25 },
      noise: { enabled: false, volume: 18 }
    }
  };
  const MODE_LABELS = { focus: 'TIME TO FOCUS', shortBreak: 'A SMALL PAUSE', longBreak: 'A LONGER PAUSE' };
  const MODE_BUTTON_LABELS = { focus: 'Start focus', shortBreak: 'Start break', longBreak: 'Start long break' };
  const MAX_HISTORY = 2000;
  const CIRCLE_LENGTH = 2 * Math.PI * 126;
  let toastTimeout;
  let timerInterval;
  let audioContext = null;
  const activeAudio = new Map();

  const safeStorage = {
    get() {
      try { return window.localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
    },
    set(value) {
      try { window.localStorage.setItem(STORAGE_KEY, value); return true; } catch (_) { return false; }
    }
  };

  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function cleanString(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
  function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }
  function makeId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }
  function parseStored() {
    const raw = safeStorage.get();
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return isObject(value) ? value : null;
    } catch (_) { return null; }
  }
  function validTask(task) {
    if (!isObject(task)) return null;
    const title = cleanString(task.title);
    if (!title || typeof task.id !== 'string') return null;
    return {
      id: task.id.slice(0, 100), title,
      completed: task.completed === true,
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : Date.now(),
      completedAt: Number.isFinite(task.completedAt) ? task.completedAt : null
    };
  }
  function loadState() {
    const stored = parseStored() || {};
    let systemTheme = 'light';
    try { systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) {}
    const durations = isObject(stored.durations) ? stored.durations : {};
    const preferences = isObject(stored.preferences) ? stored.preferences : {};
    const sounds = isObject(stored.sounds) ? stored.sounds : {};
    const timer = isObject(stored.timer) ? stored.timer : {};
    const sessions = Array.isArray(stored.sessions) ? stored.sessions.filter((session) => isObject(session) && Number.isFinite(session.endedAt) && Number.isFinite(session.durationMinutes) && session.durationMinutes > 0 && session.durationMinutes <= 180).slice(-MAX_HISTORY).map((session) => ({
      id: typeof session.id === 'string' ? session.id.slice(0, 100) : makeId(),
      endedAt: session.endedAt,
      durationMinutes: boundedNumber(session.durationMinutes, 25, 1, 180),
      taskTitle: cleanString(session.taskTitle, 120)
    })) : [];
    const tasks = Array.isArray(stored.tasks) ? stored.tasks.map(validTask).filter(Boolean).slice(-500) : [];
    const currentMode = ['focus', 'shortBreak', 'longBreak'].includes(timer.mode) ? timer.mode : 'focus';
    const remainingMs = Number.isFinite(timer.remainingMs) ? Math.max(0, timer.remainingMs) : DEFAULTS.durations[currentMode] * 60000;
    const running = timer.running === true && Number.isFinite(timer.deadline);
    return {
      theme: stored.theme === 'dark' || stored.theme === 'light' ? stored.theme : systemTheme,
      tasks,
      selectedTaskId: typeof stored.selectedTaskId === 'string' ? stored.selectedTaskId : null,
      durations: {
        focus: boundedNumber(durations.focus, DEFAULTS.durations.focus, 1, 180),
        shortBreak: boundedNumber(durations.shortBreak, DEFAULTS.durations.shortBreak, 1, 60),
        longBreak: boundedNumber(durations.longBreak, DEFAULTS.durations.longBreak, 1, 90)
      },
      preferences: { chime: preferences.chime === true, autoTransition: preferences.autoTransition === true },
      sounds: Object.fromEntries(['rain', 'wind', 'noise'].map((name) => [name, {
        enabled: isObject(sounds[name]) && sounds[name].enabled === true,
        volume: boundedNumber(isObject(sounds[name]) ? sounds[name].volume : undefined, DEFAULTS.sounds[name].volume, 0, 100)
      }])),
      sessions,
      focusCount: boundedNumber(stored.focusCount, 0, 0, 1000000),
      totalFocusMinutes: boundedNumber(stored.totalFocusMinutes, sessions.reduce((sum, session) => sum + session.durationMinutes, 0), 0, 1000000000),
      timer: {
        mode: currentMode,
        running,
        deadline: running ? timer.deadline : null,
        remainingMs: running ? Math.max(0, timer.deadline - Date.now()) : remainingMs,
        durationMinutes: boundedNumber(timer.durationMinutes, boundedNumber(durations[currentMode], DEFAULTS.durations[currentMode], 1, 180), 1, 180)
      }
    };
  }
  const state = loadState();

  function persist() {
    const saved = safeStorage.set(JSON.stringify(state));
    if (!saved) showToast('This browser could not save your changes.');
  }
  function durationMs(mode = state.timer.mode) { return state.durations[mode] * 60000; }
  function remainingMs() { return state.timer.running ? Math.max(0, state.timer.deadline - Date.now()) : state.timer.remainingMs; }
  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function localDayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function isToday(timestamp) { return localDayKey(new Date(timestamp)) === localDayKey(new Date()); }
  function completedToday() { return state.sessions.filter((session) => isToday(session.endedAt)); }
  function todayMinutes() { return completedToday().reduce((total, session) => total + session.durationMinutes, 0); }

  function showToast(message) {
    const toast = document.querySelector('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    const label = state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    const toggle = document.querySelector('#theme-toggle');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    toggle.title = label;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', state.theme === 'dark' ? '#182832' : '#f5f2e9');
  }
  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    persist();
  }

  function setView(name) {
    document.querySelectorAll('[data-view]').forEach((button) => {
      const active = button.dataset.view === name;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((view) => {
      const active = view.id === `view-${name}`;
      view.hidden = !active;
      view.classList.toggle('is-visible', active);
    });
    if (name === 'tasks') renderTasks();
    if (name === 'insights') renderInsights();
    if (name === 'focus') renderFocus();
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function renderTimer() {
    const { mode } = state.timer;
    const left = remainingMs();
    const fraction = Math.max(0, Math.min(1, left / (state.timer.durationMinutes * 60000)));
    document.querySelector('#timer-display').textContent = formatTime(left);
    document.querySelector('#timer-mode-label').textContent = MODE_LABELS[mode];
    document.querySelector('#timer-progress').style.strokeDasharray = String(CIRCLE_LENGTH);
    document.querySelector('#timer-progress').style.strokeDashoffset = String(CIRCLE_LENGTH * (1 - fraction));
    document.querySelector('.timer-wrap').dataset.mode = mode;
    document.querySelectorAll('.mode-button').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const toggle = document.querySelector('#timer-toggle');
    toggle.innerHTML = state.timer.running
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12m8-12v12"/></svg><span>Pause session</span>'
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 10 6-10 6z"/></svg><span>${state.timer.remainingMs > 0 && state.timer.remainingMs < state.timer.durationMinutes * 60000 ? 'Resume session' : MODE_BUTTON_LABELS[mode]}</span>`;
    document.querySelector('#timer-status').textContent = state.timer.running ? 'One thing at a time' : (state.timer.remainingMs > 0 && state.timer.remainingMs < state.timer.durationMinutes * 60000 ? 'Paused, take your time' : (mode === 'focus' ? 'A fresh start' : 'A moment to reset'));
    const count = state.focusCount % 4;
    document.querySelectorAll('#streak-dots i').forEach((dot, index) => dot.classList.toggle('is-complete', index < count));
    document.querySelector('#streak-dots').setAttribute('aria-label', `${count} of 4 focus sessions`);
    document.querySelector('#session-hint').textContent = `After ${4 - count} more focus session${4 - count === 1 ? '' : 's'}, take a longer pause.`;
  }

  function renderFocus() {
    const current = state.tasks.find((task) => task.id === state.selectedTaskId && !task.completed);
    document.querySelector('#current-task-title').textContent = current ? current.title : 'A little space to begin';
    document.querySelector('#current-task-subtitle').textContent = current ? 'This is what you’re making room for.' : 'Pick a task when you’re ready.';
    const activeCount = state.tasks.filter((task) => !task.completed).length;
    document.querySelector('#nav-task-count').textContent = String(activeCount);
    document.querySelector('#today-focus-summary').textContent = `${todayMinutes()} ${todayMinutes() === 1 ? 'minute' : 'minutes'} focused today`;
    renderTimer();
    renderSounds();
  }

  function renderTasks() {
    const active = state.tasks.filter((task) => !task.completed);
    const completed = state.tasks.filter((task) => task.completed).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    document.querySelector('#active-task-count').textContent = String(active.length);
    document.querySelector('#completed-task-count').textContent = String(completed.length);
    document.querySelector('#nav-task-count').textContent = String(active.length);
    const activeList = document.querySelector('#active-task-list');
    const completedList = document.querySelector('#completed-task-list');
    activeList.replaceChildren();
    completedList.replaceChildren();
    if (!active.length) activeList.append(createEmpty('A clear page. Add a task whenever you’re ready.'));
    active.forEach((task) => activeList.append(createTaskRow(task, false)));
    if (!completed.length) completedList.append(createEmpty('Finished tasks will find a home here.'));
    completed.forEach((task) => completedList.append(createTaskRow(task, true)));
  }

  function createEmpty(message) {
    const element = document.createElement('p');
    element.className = 'empty-state';
    const mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '·';
    element.append(mark, document.createTextNode(message));
    return element;
  }

  function createTaskRow(task, completed) {
    const row = document.createElement('div');
    row.className = `task-row${completed ? ' is-completed' : ''}${!completed && task.id === state.selectedTaskId ? ' is-focused' : ''}`;
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'task-check'; check.checked = completed;
    check.setAttribute('aria-label', `${completed ? 'Mark as active' : 'Mark complete'}: ${task.title}`);
    check.addEventListener('change', () => toggleTaskComplete(task.id));
    const title = document.createElement('span'); title.className = 'task-name'; title.textContent = task.title;
    const actions = document.createElement('div'); actions.className = 'task-actions';
    if (!completed) {
      const focus = document.createElement('button'); focus.type = 'button'; focus.className = 'focus-task-button';
      focus.textContent = task.id === state.selectedTaskId ? 'In focus' : 'Focus this';
      focus.setAttribute('aria-label', `Set as focus task: ${task.title}`);
      focus.addEventListener('click', () => { state.selectedTaskId = task.id; persist(); renderTasks(); renderFocus(); showToast('Your focus task is set.'); });
      actions.append(focus);
    }
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'task-action'; edit.textContent = 'Edit'; edit.setAttribute('aria-label', `Edit task: ${task.title}`);
    edit.addEventListener('click', () => editTask(task.id));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-action'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete task: ${task.title}`);
    remove.addEventListener('click', () => deleteTask(task.id));
    actions.append(edit, remove);
    row.append(check, title, actions);
    return row;
  }

  function addTask(title) {
    const cleaned = cleanString(title);
    if (!cleaned) return false;
    const task = { id: makeId(), title: cleaned, completed: false, createdAt: Date.now(), completedAt: null };
    state.tasks.unshift(task);
    if (!state.selectedTaskId) state.selectedTaskId = task.id;
    persist(); renderTasks(); renderFocus();
    showToast('A new task, ready when you are.');
    return true;
  }
  function editTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const answer = window.prompt('Edit task', task.title);
    if (answer === null) return;
    const cleaned = cleanString(answer);
    if (!cleaned) { showToast('A task needs a title.'); return; }
    task.title = cleaned;
    persist(); renderTasks(); renderFocus();
    showToast('Task updated.');
  }
  function deleteTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    state.tasks = state.tasks.filter((item) => item.id !== id);
    if (state.selectedTaskId === id) state.selectedTaskId = state.tasks.find((item) => !item.completed)?.id || null;
    persist(); renderTasks(); renderFocus(); showToast('Task removed.');
  }
  function toggleTaskComplete(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    task.completed = !task.completed;
    task.completedAt = task.completed ? Date.now() : null;
    if (task.completed && state.selectedTaskId === id) state.selectedTaskId = state.tasks.find((item) => !item.completed && item.id !== id)?.id || null;
    persist(); renderTasks(); renderFocus();
    showToast(task.completed ? 'One more thing done.' : 'Task moved back to your list.');
  }

  function renderInsights() {
    const today = todayMinutes();
    const total = state.totalFocusMinutes;
    document.querySelector('#stat-today').innerHTML = `${today}<span> min</span>`;
    document.querySelector('#stat-sessions').textContent = String(state.focusCount);
    document.querySelector('#stat-total').innerHTML = `${total}<span> min</span>`;
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index)); return date;
    });
    const dayData = dates.map((date) => {
      const key = localDayKey(date);
      return { date, today: key === localDayKey(new Date()), minutes: state.sessions.filter((session) => localDayKey(new Date(session.endedAt)) === key).reduce((sum, session) => sum + session.durationMinutes, 0) };
    });
    const max = Math.max(30, ...dayData.map((day) => day.minutes));
    const chart = document.querySelector('#activity-chart'); chart.replaceChildren();
    chart.setAttribute('aria-label', dayData.map((day) => `${day.date.toLocaleDateString('en', { weekday: 'long' })}: ${day.minutes} minutes`).join('; '));
    for (const day of dayData) {
      const col = document.createElement('div'); col.className = `chart-day${day.today ? ' today' : ''}`;
      const value = document.createElement('span'); value.className = 'chart-value'; value.textContent = day.minutes ? `${day.minutes}m` : '';
      const wrap = document.createElement('div'); wrap.className = 'chart-bar-wrap';
      const bar = document.createElement('div'); bar.className = 'chart-bar'; bar.style.height = `${day.minutes ? Math.max(7, (day.minutes / max) * 100) : 3}%`; wrap.append(bar);
      const label = document.createElement('span'); label.className = 'chart-label'; label.textContent = day.date.toLocaleDateString('en', { weekday: 'short' }).slice(0, 2).toUpperCase();
      col.append(value, wrap, label); chart.append(col);
    }
    const weekTotal = dayData.reduce((sum, day) => sum + day.minutes, 0);
    document.querySelector('#weekly-total').textContent = `${weekTotal} min total`;
    const recent = [...state.sessions].sort((a, b) => b.endedAt - a.endedAt).slice(0, 5);
    const recentContainer = document.querySelector('#recent-sessions'); recentContainer.replaceChildren();
    document.querySelector('#recent-count').textContent = `${state.sessions.length} ${state.sessions.length === 1 ? 'session' : 'sessions'}`;
    if (!recent.length) recentContainer.append(createEmpty('Your finished focus sessions will show up here.'));
    recent.forEach((session) => {
      const row = document.createElement('div'); row.className = 'recent-session';
      const title = document.createElement('span'); title.className = 'recent-session-title'; title.textContent = session.taskTitle || 'A quiet focus session';
      const when = document.createElement('span'); when.className = 'recent-session-time';
      const date = new Date(session.endedAt);
      when.textContent = `${isToday(session.endedAt) ? 'TODAY' : date.toLocaleDateString('en', { month: 'short', day: 'numeric' }).toUpperCase()} · ${date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })} · ${session.durationMinutes} MIN`;
      row.append(title, when); recentContainer.append(row);
    });
  }

  function chooseMode(mode, { auto = false } = {}) {
    if (!['focus', 'shortBreak', 'longBreak'].includes(mode)) return;
    state.timer.mode = mode;
    state.timer.running = auto;
    state.timer.durationMinutes = state.durations[mode];
    state.timer.remainingMs = durationMs(mode);
    state.timer.deadline = auto ? Date.now() + state.timer.remainingMs : null;
    persist(); renderTimer();
  }
  function toggleTimer() {
    if (state.timer.running) {
      state.timer.remainingMs = remainingMs();
      state.timer.running = false;
      state.timer.deadline = null;
    } else {
      if (state.timer.remainingMs <= 0) state.timer.remainingMs = durationMs();
      state.timer.running = true;
      state.timer.deadline = Date.now() + state.timer.remainingMs;
      if (state.preferences.chime) ensureAudioContext();
    }
    persist(); renderTimer();
  }
  function resetTimer() {
    state.timer.running = false;
    state.timer.deadline = null;
    state.timer.durationMinutes = state.durations[state.timer.mode];
    state.timer.remainingMs = durationMs();
    persist(); renderTimer(); showToast('Timer reset. Your progress is still here.');
  }
  function finishSession() {
    const finishedMode = state.timer.mode;
    state.timer.running = false;
    state.timer.deadline = null;
    state.timer.remainingMs = 0;
    if (finishedMode === 'focus') {
      const task = state.tasks.find((item) => item.id === state.selectedTaskId && !item.completed);
      state.sessions.push({ id: makeId(), endedAt: Date.now(), durationMinutes: state.timer.durationMinutes, taskTitle: task ? task.title : '' });
      if (state.sessions.length > MAX_HISTORY) state.sessions.splice(0, state.sessions.length - MAX_HISTORY);
      state.focusCount += 1;
      state.totalFocusMinutes += state.timer.durationMinutes;
    }
    if (state.preferences.chime) playChime();
    const nextMode = finishedMode === 'focus' ? (state.focusCount > 0 && state.focusCount % 4 === 0 ? 'longBreak' : 'shortBreak') : 'focus';
    state.timer.mode = nextMode;
    state.timer.durationMinutes = state.durations[nextMode];
    state.timer.remainingMs = durationMs(nextMode);
    if (state.preferences.autoTransition) {
      state.timer.running = true;
      state.timer.deadline = Date.now() + state.timer.remainingMs;
    }
    persist(); renderFocus(); renderInsights();
    showToast(finishedMode === 'focus' ? 'Focus session complete. Take a breath.' : 'A little pause, well spent.');
  }
  function tick() {
    if (!state.timer.running) return;
    if (state.timer.deadline <= Date.now()) { finishSession(); return; }
    renderTimer();
  }

  function ensureAudioContext() {
    if (!audioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) { showToast('Web Audio is not available in this browser.'); return null; }
      audioContext = new Context();
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  }
  function createNoiseBuffer(context) {
    const frameCount = context.sampleRate * 3;
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i += 1) channel[i] = Math.random() * 2 - 1;
    return buffer;
  }
  function startSound(name) {
    const context = ensureAudioContext();
    if (!context || activeAudio.has(name)) return;
    const source = context.createBufferSource(); source.buffer = createNoiseBuffer(context); source.loop = true;
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const volume = state.sounds[name].volume / 100;
    if (name === 'rain') {
      filter.type = 'bandpass'; filter.frequency.value = 1450; filter.Q.value = .55;
      gain.gain.value = volume * .11;
      const lfo = context.createOscillator(); const lfoGain = context.createGain();
      lfo.frequency.value = .16; lfoGain.gain.value = volume * .025;
      lfo.connect(lfoGain); lfoGain.connect(gain.gain); lfo.start(); activeAudio.set(name, { source, filter, gain, lfo, lfoGain });
    } else if (name === 'wind') {
      filter.type = 'lowpass'; filter.frequency.value = 360; filter.Q.value = .7;
      gain.gain.value = volume * .14;
      const lfo = context.createOscillator(); const lfoGain = context.createGain();
      lfo.frequency.value = .08; lfoGain.gain.value = volume * .1;
      lfo.connect(lfoGain); lfoGain.connect(gain.gain); lfo.start(); activeAudio.set(name, { source, filter, gain, lfo, lfoGain });
    } else {
      filter.type = 'lowpass'; filter.frequency.value = 7000;
      gain.gain.value = volume * .045;
      activeAudio.set(name, { source, filter, gain });
    }
    source.connect(filter); filter.connect(gain); gain.connect(context.destination); source.start();
  }
  function stopSound(name) {
    const nodes = activeAudio.get(name);
    if (!nodes) return;
    const context = audioContext;
    try {
      nodes.gain.gain.setTargetAtTime(0, context.currentTime, .04);
      window.setTimeout(() => {
        try { nodes.source.stop(); nodes.source.disconnect(); nodes.filter.disconnect(); nodes.gain.disconnect(); if (nodes.lfo) { nodes.lfo.stop(); nodes.lfo.disconnect(); nodes.lfoGain.disconnect(); } } catch (_) {}
      }, 220);
    } catch (_) {}
    activeAudio.delete(name);
  }
  function setSoundVolume(name, volume) {
    state.sounds[name].volume = boundedNumber(volume, DEFAULTS.sounds[name].volume, 0, 100);
    const nodes = activeAudio.get(name);
    if (nodes && audioContext) {
      const multiplier = name === 'rain' ? .11 : name === 'wind' ? .14 : .045;
      nodes.gain.gain.setTargetAtTime((state.sounds[name].volume / 100) * multiplier, audioContext.currentTime, .04);
    }
    persist();
  }
  function renderSounds() {
    let enabledCount = 0;
    document.querySelectorAll('[data-sound]').forEach((button) => {
      const name = button.dataset.sound;
      const sound = state.sounds[name];
      button.setAttribute('aria-pressed', String(sound.enabled));
      document.querySelector(`[data-volume="${name}"]`).value = String(sound.volume);
      document.querySelector(`[data-volume="${name}"]`).disabled = !sound.enabled;
      if (sound.enabled) enabledCount += 1;
    });
    document.querySelector('#sound-dot').classList.toggle('is-on', enabledCount > 0);
    document.querySelector('#sound-status-label').textContent = enabledCount ? `${enabledCount} ${enabledCount === 1 ? 'sound' : 'sounds'} on` : 'Quiet for now';
  }
  function toggleSound(name) {
    const sound = state.sounds[name];
    sound.enabled = !sound.enabled;
    if (sound.enabled) startSound(name); else stopSound(name);
    persist(); renderSounds();
    if (sound.enabled && !audioContext) showToast('This browser could not start audio.');
  }
  function playChime() {
    const context = ensureAudioContext();
    if (!context) return;
    [523.25, 659.25].forEach((frequency, index) => {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, context.currentTime + index * .15);
      gain.gain.exponentialRampToValueAtTime(.085, context.currentTime + index * .15 + .04);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + index * .15 + .6);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(context.currentTime + index * .15); oscillator.stop(context.currentTime + index * .15 + .65);
    });
  }

  const settingsDialog = document.querySelector('#settings-dialog');
  function openSettings() {
    for (const mode of ['focus', 'shortBreak', 'longBreak']) document.querySelector(`#duration-${mode}`).value = String(state.durations[mode]);
    document.querySelector('#sound-notification').checked = state.preferences.chime;
    document.querySelector('#auto-transition').checked = state.preferences.autoTransition;
    settingsDialog.showModal();
  }
  function saveSettings() {
    const constraints = { focus: [1, 180], shortBreak: [1, 60], longBreak: [1, 90] };
    for (const mode of Object.keys(constraints)) {
      const input = document.querySelector(`#duration-${mode}`);
      const [minimum, maximum] = constraints[mode];
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        input.setCustomValidity(`Choose a whole number from ${minimum} to ${maximum} minutes.`);
        input.reportValidity(); input.setCustomValidity(''); input.focus(); return;
      }
    }
    const previousDuration = durationMs();
    for (const mode of Object.keys(constraints)) state.durations[mode] = Number(document.querySelector(`#duration-${mode}`).value);
    state.preferences.chime = document.querySelector('#sound-notification').checked;
    state.preferences.autoTransition = document.querySelector('#auto-transition').checked;
    if (!state.timer.running && state.timer.remainingMs === previousDuration) {
      state.timer.remainingMs = durationMs();
      state.timer.durationMinutes = state.durations[state.timer.mode];
    }
    persist(); renderTimer(); settingsDialog.close(); showToast('Your preferences are saved.');
  }

  function initialize() {
    applyTheme(state.theme);
    document.querySelector('#today-label').textContent = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
    document.querySelector('#theme-toggle').addEventListener('click', toggleTheme);
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    document.querySelector('#timer-toggle').addEventListener('click', toggleTimer);
    document.querySelector('#timer-reset').addEventListener('click', resetTimer);
    document.querySelectorAll('.mode-button').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.mode === state.timer.mode) return;
      chooseMode(button.dataset.mode);
    }));
    document.querySelector('#task-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.querySelector('#task-input');
      if (addTask(input.value)) input.value = '';
    });
    document.querySelector('#choose-task').addEventListener('click', () => { setView('tasks'); document.querySelector('#task-input').focus(); });
    document.querySelector('#add-task-top').addEventListener('click', () => document.querySelector('#task-input').focus());
    ['#open-settings', '#open-settings-inline', '#mobile-open-settings'].forEach((selector) => document.querySelector(selector).addEventListener('click', openSettings));
    document.querySelector('#save-settings').addEventListener('click', saveSettings);
    document.querySelector('#cancel-settings').addEventListener('click', () => settingsDialog.close());
    document.querySelectorAll('[data-sound]').forEach((button) => button.addEventListener('click', () => toggleSound(button.dataset.sound)));
    document.querySelectorAll('[data-volume]').forEach((input) => input.addEventListener('input', () => setSoundVolume(input.dataset.volume, input.value)));
    document.addEventListener('click', () => {
      if (!Object.values(state.sounds).some((sound) => sound.enabled)) return;
      Object.entries(state.sounds).forEach(([name, sound]) => { if (sound.enabled) startSound(name); });
    }, { once: true });
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) showToast('Soft Signal changed in another tab. Refresh to sync.');
    });
    window.addEventListener('pagehide', persist);
    renderFocus(); renderTasks(); renderInsights();
    persist();
    if (state.timer.running && state.timer.deadline <= Date.now()) finishSession();
    timerInterval = window.setInterval(tick, 250);
  }

  initialize();
})();
