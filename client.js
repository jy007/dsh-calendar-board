/**
 * Calendar board — a month view of every day's work.
 *
 * Registers two Client contributions:
 *  - `sidebar.panellist` / `calendar` — the sidebar icon that opens the board.
 *  - `main` / `calendar`             — the board itself, as a main panel.
 *
 * Data sources:
 *  - The user's own day entries, kept in this page's localStorage.
 *  - Scheduled reminders, read through the Client remote face of the Host
 *    `schedule` service and expanded into the visible month.
 */

// The Web client evaluates this file as a classic script, possibly more than
// once (HMR / re-registration). An IIFE keeps every declaration out of the
// global lexical scope, which would otherwise throw
// "Identifier 'STORE_KEY' has already been declared" on the second load.
(function () {
// #region helpers
const BUILD_TAG = '1.4.1';
const STORE_KEY = 'dsh-calendar-board.items.v1';
const NOTIFY_KEY = 'dsh-calendar-board.notify.v1';

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function dateKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function keyToDate(key) {
  const parts = String(key).split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) return new Date(NaN);
  return new Date(year, month - 1, day);
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
function isoDay(date) {
  const week = date.getDay();
  return week === 0 ? 7 : week;
}

function isoWeek(date) {
  const probe = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1));
  return Math.ceil(((probe.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function clockText(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function newId() {
  return 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Grid of whole weeks covering the month, Monday first. */
function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const start = addDays(first, 1 - isoDay(first));
  const last = new Date(year, month + 1, 0);
  const end = addDays(last, 7 - isoDay(last));
  const days = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

let lunarFormatter = null;
try {
  lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
} catch (error) {
  lunarFormatter = null;
}

function chineseDayLabel(day) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (day <= 0) return '';
  if (day <= 10) return '初' + digits[day];
  if (day < 20) return '十' + digits[day - 10];
  if (day === 20) return '二十';
  if (day < 30) return '廿' + digits[day - 20];
  if (day === 30) return '三十';
  return String(day);
}

function lunarParts(date) {
  if (!lunarFormatter) return null;
  try {
    const parts = lunarFormatter.formatToParts(date);
    let month = '';
    let day = 0;
    for (const part of parts) {
      if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = Number(String(part.value).replace(/[^0-9]/g, ''));
    }
    if (!day) return null;
    return { month: month, day: day };
  } catch (error) {
    return null;
  }
}

/** Compact lunar label for a cell: the month name on day one, 初一 … 三十 otherwise. */
function lunarText(date) {
  const parts = lunarParts(date);
  if (!parts) return '';
  return parts.day === 1 ? parts.month : chineseDayLabel(parts.day);
}

/** Full lunar label, e.g. 九月廿七. */
function lunarFullText(date) {
  const parts = lunarParts(date);
  if (!parts) return '';
  return parts.day === 1 ? parts.month : parts.month + chineseDayLabel(parts.day);
}

function ruleLabel(entry, t) {
  if (!entry) return '';
  const time = entry.time || '';
  if (entry.kind === 'daily') return time ? t('ruleDaily') + time : t('ruleDailyShort');
  if (entry.kind === 'weekly') {
    const names = Array.isArray(entry.weekdays) ? entry.weekdays : [];
    const days = names.map(function (n) { return t('weekShort' + n); }).join(' ');
    return time ? t('ruleWeekly', days + ' ' + time) : days;
  }
  if (entry.kind === 'every') {
    const seconds = Number(entry.everySeconds) || 0;
    if (seconds >= 3600) return t('ruleEveryHours', Math.round(seconds / 3600));
    return t('ruleEveryMinutes', Math.max(1, Math.round(seconds / 60)));
  }
  if (entry.kind === 'cron') return String(entry.expression || 'cron');
  return '';
}

const PALETTE = ['', 'red', 'amber', 'green', 'blue'];

/** Decoration classes shared by every renderer of one entry. */
function decorationClasses(entry) {
  const classes = [];
  if (entry.color && PALETTE.indexOf(entry.color) > 0) classes.push('dscb-color-' + entry.color);
  if (entry.done) classes.push('dscb-strike');
  if (entry.underline) classes.push('dscb-underline');
  if (entry.status === 'inactive') classes.push('dscb-ended');
  return classes;
}

function compareItems(left, right) {
  const leftTime = left.time || '99:99';
  const rightTime = right.time || '99:99';
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return String(left.title).localeCompare(String(right.title));
}

const SCHEDULE_GRACE_MS = 90000;
const DELIVERY_MATCH_MS = 5 * 60 * 1000;

/** When one occurrence of a schedule is meant to fire. */
function scheduleInstant(time, key, fallback) {
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    const date = keyToDate(key);
    date.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0);
    return date;
  }
  return fallback || keyToDate(key);
}

/**
 * How one schedule occurrence stands right now:
 *  done    – DSH already delivered it (or the one-shot ended)
 *  expired – its time passed without a delivery
 *  pending – still ahead
 */
function scheduleStateFor(entry, instant, now) {
  const deliveredAt = entry.lastDelivery && entry.lastDelivery.scheduledAt
    ? new Date(entry.lastDelivery.scheduledAt)
    : null;
  if (deliveredAt && !isNaN(deliveredAt.getTime()) && Math.abs(deliveredAt.getTime() - instant.getTime()) < DELIVERY_MATCH_MS) {
    return 'done';
  }
  if (entry.status === 'inactive') return 'done';
  if (instant.getTime() + SCHEDULE_GRACE_MS <= now.getTime()) return 'expired';
  return 'pending';
}

/**
 * Every entry (user + scheduled) that belongs to one day, ordered by time.
 *
 * Recurring schedules are only materialised for today and tomorrow: repeating a
 * daily reminder across a whole month turns the grid into noise, so the rest of
 * the month stays clean and the board shows what is actually actionable.
 */
function occurrencesForDay(items, entries, key, t, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const todayKey = opts.todayKey || dateKey(now);
  const tomorrowKey = dateKey(addDays(keyToDate(todayKey), 1));
  const isToday = key === todayKey;
  const isTomorrow = key === tomorrowKey;
  const showSchedules = isToday || isTomorrow;
  const date = keyToDate(key);
  const out = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.title) continue;
    const isDaily = item.repeat === 'daily';
    if (!isDaily && item.date !== key) continue;
    const doneDates = Array.isArray(item.doneDates) ? item.doneDates : [];
    out.push({
      key: 'user:' + item.id + ':' + key,
      id: item.id,
      source: 'user',
      date: key,
      time: item.time || '',
      title: item.title,
      repeat: item.repeat || 'none',
      color: item.color || '',
      underline: !!item.underline,
      done: doneDates.indexOf(key) >= 0,
    });
  }

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!showSchedules) break;
    if (!entry || !entry.title) continue;
    // A schedule DSH has retired is history, not something to act on.
    if (entry.status === 'inactive') continue;
    const status = entry.status === 'inactive' ? 'inactive' : 'active';
    const id = String(entry.id || entry.title);
    const base = {
      id: 'schedule:' + id,
      source: 'schedule',
      date: key,
      title: entry.title,
      status: status,
      rule: ruleLabel(entry, t),
    };
    const push = function (time, instant) {
      const state = scheduleStateFor(entry, instant, now);
      out.push(Object.assign({}, base, {
        key: base.id + ':' + key,
        time: time || '',
        state: state === 'pending' ? (isToday ? 'due' : 'next') : state,
      }));
    };
    if (entry.kind === 'daily') {
      push(entry.time || '', scheduleInstant(entry.time, key));
      continue;
    }
    if (entry.kind === 'weekly') {
      const weekdays = Array.isArray(entry.weekdays) ? entry.weekdays : [];
      if (weekdays.indexOf(isoDay(date)) < 0) continue;
      push(entry.time || '', scheduleInstant(entry.time, key));
      continue;
    }
    const when = entry.scheduledAt ? new Date(entry.scheduledAt) : null;
    if (!when || isNaN(when.getTime())) continue;
    if (dateKey(when) !== key) continue;
    push(clockText(when), when);
  }

  out.sort(compareItems);
  return out;
}

/** Coerce one Host item into the shape this page renders. */
function normalizeClientItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title == null ? '' : raw.title).trim();
  const date = String(raw.date || '');
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const doneDates = Array.isArray(raw.doneDates) ? raw.doneDates.filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); }) : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'it' + Math.random().toString(36).slice(2, 9),
    date: date,
    time: typeof raw.time === 'string' ? raw.time : '',
    title: title,
    repeat: raw.repeat === 'daily' ? 'daily' : 'none',
    doneDates: doneDates,
    color: typeof raw.color === 'string' ? raw.color : '',
    underline: raw.underline === true,
  };
}

/** Order-independent fingerprint used to detect a real change. */
function canonicalItems(list) {
  return JSON.stringify((Array.isArray(list) ? list : []).map(function (item) {
    return [
      item.id,
      item.date,
      item.time || '',
      item.title,
      item.repeat || 'none',
      (Array.isArray(item.doneDates) ? item.doneDates.slice().sort() : []).join(','),
      item.color || '',
      item.underline ? 1 : 0,
    ];
  }));
}

function readItems() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (item) { return item && typeof item.title === 'string'; });
  } catch (error) {
    return [];
  }
}

function writeItems(items) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(items));
  } catch (error) {
    /* storage unavailable — the session keeps working in memory */
  }
}

function readNotifyFlag() {
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function writeNotifyFlag(value) {
  try {
    window.localStorage.setItem(NOTIFY_KEY, value ? '1' : '0');
  } catch (error) {
    /* ignore */
  }
}

const SOUND_KEY = 'dsh-calendar-board.sound.v1';
const HIDDEN_KEY = 'dsh-calendar-board.hidden-sources.v1';

function readHiddenSources() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === 'string'; }) : [];
  } catch (error) {
    return [];
  }
}

function writeHiddenSources(ids) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch (error) {
    /* ignore */
  }
}

function readSoundFlag() {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== '0';
  } catch (error) {
    return true;
  }
}

function writeSoundFlag(value) {
  try {
    window.localStorage.setItem(SOUND_KEY, value ? '1' : '0');
  } catch (error) {
    /* ignore */
  }
}
// #endregion helpers

window.__ModuleLoader__.load({
  id: 'dsh-calendar-board',
  factory(require) {
    const React = require('react');
    if (!React || typeof React.createElement !== 'function') {
      return { apply() {} };
    }
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const DICT = {
      zh: {
        panelTitle: '日历看板',
        subtitle: '月视图 · 每日事项与定时任务',
        today: '今天',
        prevMonth: '上个月',
        nextMonth: '下个月',
        addToday: '添加今天',
        notifyOn: '每日提醒已开启',
        notifyEnable: '开启每日提醒',
        notifyDenied: '系统通知已被拒绝',
        notifyUnsupported: '当前环境不支持系统通知',
        syncReady: function (count) { return '定时任务 ' + count + ' 项'; },
        syncEmpty: '暂无定时任务',
        syncLoading: '正在同步定时任务',
        syncError: '定时任务同步失败',
        syncUnavailable: '定时任务不可用',
        refresh: '重新同步定时任务',
        weekdays: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
        weekShort1: '周一',
        weekShort2: '周二',
        weekShort3: '周三',
        weekShort4: '周四',
        weekShort5: '周五',
        weekShort6: '周六',
        weekShort7: '周日',
        monthLabel: function (year, month) { return year + '年' + month + '月'; },
        dayLabel: function (month, day) { return month + '月' + day + '日'; },
        lunarPrefix: '农历',
        taskCount: function (count) { return '今天 ' + count + ' 项'; },
        taskDone: function (done, total) { return '已完成 ' + done + ' / ' + total; },
        todayLine: function (done, total) { return '今天 ' + done + ' / ' + total + ' 已完成'; },
        moreItems: function (count) { return '还有 ' + count + ' 项'; },
        addPlaceholder: '添加这一天的待办，回车保存',
        add: '添加',
        repeatDaily: '每天',
        noItems: '这一天还没有安排',
        emptyHint: '写下一件事，它就会留在这张日历上。',
        remove: '删除',
        scheduleTag: '定时任务',
        endedTag: '已结束',
        ruleDaily: '每天 ',
        ruleDailyShort: '每天',
        ruleWeekly: function (value) { return '每周 ' + value; },
        ruleEveryMinutes: function (value) { return '每 ' + value + ' 分钟'; },
        ruleEveryHours: function (value) { return '每 ' + value + ' 小时'; },
        cellAdd: '添加事项…',
        scheduleInline: function (count) { return '定时任务 ' + count; },
        legendTitle: '日历来源',
        legendLocal: '我的事项',
        connectCalendar: '本机日历',
        connectTitle: '把本机「日历」里已同步的日历加到看板',
        localCalendarsTitle: '本机日历（macOS）',
        localCalendarsHint: '读取系统「日历」里已同步的日历，含 Google / 飞书 / Outlook 账号',
        localCalendarsEmpty: '没有可用的本机日历，或未授予日历权限',
        localCalendarsLoading: '正在读取本机日历…',
        localAdd: '加到看板',
        localRemove: '移除',
        legendSchedule: '定时任务',
        subscribe: '订阅日历',
        subscribeTitle: '添加 iCal 订阅（Google / 飞书 / Outlook 的“私密 iCal 地址”）',
        nameLabel: '名称',
        urlLabel: 'iCal 地址',
        colorLabel: '颜色',
        addSubscription: '添加',
        cancel: '取消',
        calendarTag: '订阅',
        schedDue: '待运行',
        schedNext: '明日',
        schedDone: '已运行',
        schedExpired: '已过期',
        calendarInline: function (count) { return '订阅日程 ' + count; },
        allDayLabel: '全天',
        colorNames: { blue: '蓝', green: '绿', amber: '橙', red: '红', gray: '灰' },
        removeSubscription: '取消订阅',
        subscribeFailed: '订阅失败',
        noCalendarEvents: '这一天没有订阅来源的日程',
        calendarSection: '日历日程',
        syncHost: '已同步 Host',
        syncLocal: '仅本机保存',
        cellHint: '点击日期格即可编辑 · 回车保存 · Esc 退出',
        editHint: '点击文字直接修改，失焦自动保存',
        toolsUnderline: '下划线',
        toolsColor: '文字颜色',
        toolsDone: '标记完成',
        cheer: function (title) { return '完成：' + title; },
        cheerFallback: '完成一项，干得漂亮',
        previewCheer: '烟花预览 · 恭喜恭喜',
        previewTitle: '预览烟花与音效',
        soundOn: '完成音效已开',
        soundOff: '完成音效已关',
        soundToggle: '完成音效',
        todaySection: '今日安排',
        weekNumber: '周',
        hint: '提醒会在设定的时刻弹出系统通知。',
      },
      en: {
        panelTitle: 'Calendar Board',
        subtitle: 'Month view · daily work and scheduled reminders',
        today: 'Today',
        prevMonth: 'Previous month',
        nextMonth: 'Next month',
        addToday: 'Add for today',
        notifyOn: 'Daily nudge on',
        notifyEnable: 'Enable daily nudge',
        notifyDenied: 'System notifications are blocked',
        notifyUnsupported: 'System notifications are unavailable here',
        syncReady: function (count) { return count + ' scheduled reminder' + (count === 1 ? '' : 's'); },
        syncEmpty: 'No scheduled reminders',
        syncLoading: 'Syncing scheduled reminders',
        syncError: 'Scheduled reminders failed to load',
        syncUnavailable: 'Scheduled reminders unavailable',
        refresh: 'Resync scheduled reminders',
        weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        weekShort1: 'Mon',
        weekShort2: 'Tue',
        weekShort3: 'Wed',
        weekShort4: 'Thu',
        weekShort5: 'Fri',
        weekShort6: 'Sat',
        weekShort7: 'Sun',
        monthLabel: function (year, month) { return year + '-' + pad2(month); },
        dayLabel: function (month, day) { return pad2(month) + '-' + pad2(day); },
        lunarPrefix: 'Lunar',
        taskCount: function (count) { return count + ' item' + (count === 1 ? '' : 's') + ' today'; },
        taskDone: function (done, total) { return done + ' / ' + total + ' done'; },
        todayLine: function (done, total) { return 'Today ' + done + ' / ' + total + ' done'; },
        moreItems: function (count) { return '+' + count + ' more'; },
        addPlaceholder: 'Add an item for this day, press Enter',
        add: 'Add',
        repeatDaily: 'Daily',
        noItems: 'Nothing planned for this day',
        emptyHint: 'Write one thing down and it stays on this calendar.',
        remove: 'Remove',
        scheduleTag: 'Scheduled',
        endedTag: 'Ended',
        ruleDaily: 'daily ',
        ruleDailyShort: 'daily',
        ruleWeekly: function (value) { return 'weekly ' + value; },
        ruleEveryMinutes: function (value) { return 'every ' + value + ' min'; },
        ruleEveryHours: function (value) { return 'every ' + value + ' h'; },
        cellAdd: 'Add an item…',
        scheduleInline: function (count) { return count + ' scheduled'; },
        legendTitle: 'Calendars',
        legendLocal: 'My entries',
        connectCalendar: 'This Mac',
        connectTitle: 'Add calendars already synced into Calendar.app on this Mac',
        localCalendarsTitle: 'This Mac (macOS)',
        localCalendarsHint: 'Reads the calendars already synced into Calendar.app, including Google / Feishu / Outlook accounts',
        localCalendarsEmpty: 'No local calendars, or calendar access was not granted',
        localCalendarsLoading: 'Reading local calendars…',
        localAdd: 'Add to board',
        localRemove: 'Remove',
        legendSchedule: 'Scheduled',
        subscribe: 'Subscribe',
        subscribeTitle: 'Add an iCal subscription (the secret iCal address from Google / Feishu / Outlook)',
        nameLabel: 'Name',
        urlLabel: 'iCal address',
        colorLabel: 'Color',
        addSubscription: 'Add',
        cancel: 'Cancel',
        calendarTag: 'Feed',
        schedDue: 'Due',
        schedNext: 'Tomorrow',
        schedDone: 'Ran',
        schedExpired: 'Expired',
        calendarInline: function (count) { return count + ' calendar event' + (count === 1 ? '' : 's'); },
        allDayLabel: 'All day',
        colorNames: { blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', gray: 'Gray' },
        removeSubscription: 'Unsubscribe',
        subscribeFailed: 'Subscription failed',
        noCalendarEvents: 'No subscribed events on this day',
        calendarSection: 'Calendar events',
        syncHost: 'Synced to Host',
        syncLocal: 'Local only',
        cellHint: 'Click a day to edit · Enter saves · Esc exits',
        editHint: 'Click the text to edit; changes save on blur',
        toolsUnderline: 'Underline',
        toolsColor: 'Text color',
        toolsDone: 'Mark done',
        cheer: function (title) { return 'Done: ' + title; },
        cheerFallback: 'One down. Nice work.',
        previewCheer: 'Fireworks preview',
        previewTitle: 'Preview fireworks and sound',
        soundOn: 'Completion sound on',
        soundOff: 'Completion sound off',
        soundToggle: 'Completion sound',
        todaySection: 'Today',
        weekNumber: 'W',
        hint: 'Nudges appear as system notifications at the time you set.',
      },
    };

    const CSS = [
      '.dscb-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:480px;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;font-family:inherit;}',
      '.dscb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}',
      '.dscb-head-main{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.dscb-title{font-size:20px;font-weight:600;letter-spacing:.01em;white-space:nowrap;}',
      '.dscb-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dscb-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}',
      '.dscb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease;}',
      '.dscb-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}',
      '.dscb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}',
      '.dscb-btn-primary:hover{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);opacity:.9;}',
      '.dscb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease;}',
      '.dscb-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dscb-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dscb-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none;}',
      '.dscb-dot-ready{background:var(--dsw-alias-state-success-primary);}',
      '.dscb-dot-error{background:var(--dsw-alias-state-error-primary);}',
      '.dscb-dot-loading{background:var(--dsw-alias-state-warn-primary);}',
      '.dscb-body{display:flex;flex:1;min-height:0;min-width:0;}',
      '.dscb-cal{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;}',
      '.dscb-weekrow{display:grid;grid-template-columns:44px repeat(7,minmax(0,1fr));border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dscb-weekhead{padding:8px 10px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);text-align:center;}',
      '.dscb-weekhead.is-weekend{color:var(--dsw-alias-label-primary);}',
      '.dscb-grid{display:grid;grid-template-columns:44px repeat(7,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);flex:1;min-height:360px;}',
      '.dscb-weeknum{display:flex;align-items:flex-start;justify-content:center;padding:8px 0;font-size:11px;color:var(--dsw-alias-label-secondary);border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dscb-cell{display:flex;flex-direction:column;gap:3px;min-width:0;min-height:0;padding:6px 8px 8px;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;outline:none;overflow:hidden;transition:background .15s ease;}',
      '.dscb-cell:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.dscb-cell:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l2);}',
      '.dscb-cell.is-selected{background:var(--dsw-alias-bg-layer-2);}',
      '.dscb-cell.is-today{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:8px;}',
      '.dscb-cell.is-outside .dscb-daynum,.dscb-cell.is-outside .dscb-lunar{color:var(--dsw-alias-state-idle-primary);}',
      '.dscb-cell-head{display:flex;align-items:baseline;gap:6px;min-width:0;}',
      '.dscb-daynum{font-size:14px;font-weight:600;letter-spacing:.01em;}',
      '.dscb-cell.is-today .dscb-daynum{color:var(--dsw-alias-brand-primary);}',
      '.dscb-lunar{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dscb-cell-badge{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-brand-primary);white-space:nowrap;}',
      '.dscb-cell-items{display:flex;flex-direction:column;gap:2px;min-height:0;overflow:hidden;}',
      '.dscb-line{display:flex;align-items:center;gap:5px;min-width:0;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-1);font-size:11.5px;}',
      '.dscb-line.is-schedule{background:transparent;border:1px dashed var(--dsw-alias-border-l1);}',
      '.dscb-line.is-done .dscb-line-title{text-decoration:line-through;color:var(--dsw-alias-label-secondary);}',
      '.dscb-line.is-ended{opacity:.55;}',
      '.dscb-line-mark{width:5px;height:5px;border-radius:999px;flex:none;background:var(--dsw-alias-brand-primary);}',
      '.dscb-line.is-schedule .dscb-line-mark{border-radius:2px;background:var(--dsw-alias-state-warn-primary);}',
      '.dscb-line.is-schedule.is-due{border-color:var(--dsw-alias-state-error-primary);}',
      '.dscb-line.is-schedule.is-due .dscb-line-mark{background:var(--dsw-alias-state-error-primary);}',
      '.dscb-line.is-schedule.is-due .dscb-line-title{color:var(--dsw-alias-state-error-primary);}',
      '.dscb-line.is-schedule.is-next .dscb-line-mark{background:var(--dsw-alias-state-warn-primary);}',
      '.dscb-line.is-schedule.is-next .dscb-line-title{color:var(--dsw-alias-state-warn-primary);}',
      '.dscb-line.is-schedule.is-done,.dscb-line.is-schedule.is-expired{opacity:.45;}',
      '.dscb-task.is-schedule.is-due{border-left:3px solid var(--dsw-alias-state-error-primary);}',
      '.dscb-task.is-schedule.is-due .dscb-task-title{color:var(--dsw-alias-state-error-primary);}',
      '.dscb-task.is-schedule.is-next{border-left:3px solid var(--dsw-alias-state-warn-primary);}',
      '.dscb-task.is-schedule.is-next .dscb-task-title{color:var(--dsw-alias-state-warn-primary);}',
      '.dscb-task.is-schedule.is-done,.dscb-task.is-schedule.is-expired{opacity:.55;}',
      '.dscb-tag-due{background:var(--dsw-alias-state-error-primary);color:#fff;}',
      '.dscb-tag-next{background:var(--dsw-alias-state-warn-primary);color:#fff;}',
      '.dscb-line-time{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;}',
      '.dscb-line-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}',
      '.dscb-more{font-size:11px;color:var(--dsw-alias-label-secondary);padding-left:4px;}',
      '.dscb-rail{display:flex;flex-direction:column;gap:12px;width:312px;flex:none;min-height:0;padding:16px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.dscb-rail-date{font-size:16px;font-weight:600;}',
      '.dscb-rail-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;flex-wrap:wrap;}',
      '.dscb-progress{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:10px;}',
      '.dscb-progress span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s ease;}',
      '.dscb-progress-text{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.dscb-add{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dscb-add-row{display:flex;align-items:center;gap:8px;}',
      '.dscb-input{flex:1;min-width:0;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;}',
      '.dscb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.dscb-input-time{flex:none;width:96px;font-variant-numeric:tabular-nums;}',
      '.dscb-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;user-select:none;}',
      '.dscb-task{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dscb-task.is-schedule{background:transparent;border-style:dashed;}',
      '.dscb-check{appearance:none;-webkit-appearance:none;width:16px;height:16px;margin:2px 0 0;flex:none;border-radius:5px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;position:relative;}',
      '.dscb-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dscb-check:checked:after{content:"";position:absolute;left:4px;top:1px;width:5px;height:9px;border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(42deg);}',
      '.dscb-task-main{flex:1;min-width:0;}',
      '.dscb-task-title{font-size:12.5px;word-break:break-word;}',
      '.dscb-task.is-done .dscb-task-title{text-decoration:line-through;color:var(--dsw-alias-label-secondary);}',
      '.dscb-task-meta{margin-top:2px;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}',
      '.dscb-tag{padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;}',
      '.dscb-task-remove{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:22px;height:22px;border-radius:6px;flex:none;font-size:14px;line-height:1;}',
      '.dscb-task-remove:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);}',
      '.dscb-list{display:flex;flex-direction:column;gap:8px;}',
      '.dscb-section{font-size:11.5px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);}',
      '.dscb-empty{padding:14px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;}',
      '.dscb-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dscb-scroll{display:flex;flex-direction:column;gap:10px;min-height:0;}',
      '.dscb-color-red{color:var(--dsw-alias-state-error-primary);}',
      '.dscb-color-amber{color:var(--dsw-alias-state-warn-primary);}',
      '.dscb-color-green{color:var(--dsw-alias-state-success-primary);}',
      '.dscb-color-blue{color:var(--dsw-alias-brand-primary);}',
      '.dscb-strike{text-decoration:line-through;}',
      '.dscb-underline{text-decoration:underline;}',
      '.dscb-strike.dscb-underline{text-decoration:underline line-through;}',
      '.dscb-ended{opacity:.55;}',
      '.dscb-text{flex:1;min-width:0;width:100%;border:none;background:transparent;font:inherit;font-size:12.5px;color:inherit;padding:1px 4px;border-radius:4px;outline:none;}',
      '.dscb-text:focus{background:var(--dsw-alias-bg-layer-2);}',
      '.dscb-cell-input{width:100%;min-width:0;border:none;background:transparent;font:inherit;font-size:11.5px;color:inherit;padding:1px 5px;border-radius:5px;outline:none;}',
      '.dscb-cell-input:focus{background:var(--dsw-alias-bg-layer-2);}',
      '.dscb-cell-row{display:flex;align-items:center;gap:2px;min-width:0;}',
      '.dscb-cell-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1;padding:0 2px;border-radius:4px;opacity:0;flex:none;}',
      '.dscb-cell-row:hover .dscb-cell-x{opacity:1;}',
      '.dscb-cell-x:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dscb-cell.is-editing{background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);cursor:text;}',
      '.dscb-task-tools{display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .12s ease;flex:none;}',
      '.dscb-task:hover .dscb-task-tools,.dscb-task:focus-within .dscb-task-tools{opacity:1;}',
      '.dscb-tool{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;background:transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;line-height:1;}',
      '.dscb-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dscb-tool.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);}',
      '.dscb-tool-dot{width:9px;height:9px;border-radius:999px;background:currentColor;}',
      '.dscb-index{flex:none;min-width:15px;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.dscb-task-line{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.dscb-src-blue{--dscb-src:var(--dsw-alias-brand-primary);}',
      '.dscb-src-green{--dscb-src:var(--dsw-alias-state-success-primary);}',
      '.dscb-src-amber{--dscb-src:var(--dsw-alias-state-warn-primary);}',
      '.dscb-src-red{--dscb-src:var(--dsw-alias-state-error-primary);}',
      '.dscb-src-gray{--dscb-src:var(--dsw-alias-label-secondary);}',
      '.dscb-legend{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dscb-legend-title{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-right:2px;}',
      '.dscb-source{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;}',
      '.dscb-source:hover{border-color:var(--dsw-alias-border-l2);}',
      '.dscb-source.is-off{opacity:.45;text-decoration:line-through;}',
      '.dscb-source-dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--dscb-src,var(--dsw-alias-label-secondary));}',
      '.dscb-source-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:0 0 0 2px;}',
      '.dscb-source-x:hover{color:var(--dsw-alias-state-error-primary);}',
      '.dscb-source-add{height:24px;padding:0 10px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:inherit;cursor:pointer;}',
      '.dscb-source-add:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dscb-sub-form{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);}',
      '.dscb-sub-row{display:flex;align-items:center;gap:8px;}',
      '.dscb-select{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;}',
      '.dscb-line.is-calendar{background:transparent;border-left:2px solid var(--dscb-src,var(--dsw-alias-border-l2));}',
      '.dscb-line.is-calendar .dscb-line-mark{background:var(--dscb-src);}',
      '.dscb-task.is-calendar{background:transparent;border-left:3px solid var(--dscb-src,var(--dsw-alias-border-l2));}',
      '.dscb-fireworks{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;}',
      '.dscb-confetti{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:6;}',
      '.dscb-confetti-piece{position:absolute;border-radius:2px;opacity:0;animation:dscb-confetti-fly 1.05s cubic-bezier(.2,.7,.3,1) forwards;}',
      '@keyframes dscb-confetti-fly{0%{opacity:1;transform:translate(-50%,-50%) rotate(0) scale(1);}70%{opacity:1;}100%{opacity:0;transform:translate(calc(-50% + var(--x)),calc(-50% + var(--y))) rotate(var(--r)) scale(.65);}}',
      '.dscb-cheer{position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:7;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12.5px;box-shadow:0 10px 28px rgba(0,0,0,.18);pointer-events:none;animation:dscb-cheer-in .22s ease-out;}',
      '.dscb-cheer-dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--dsw-alias-state-success-primary);}',
      '.dscb-cheer-text{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '@keyframes dscb-cheer-in{from{opacity:0;transform:translate(-50%,-8px) scale(.96);}to{opacity:1;transform:translate(-50%,0) scale(1);}}',
      '@media (prefers-reduced-motion:reduce){.dscb-cheer{animation:none;}}',
      '@media (max-width:1080px){.dscb-rail{width:264px;}}',
      '@media (max-width:920px){.dscb-rail{display:none;}.dscb-weekrow{grid-template-columns:36px repeat(7,minmax(0,1fr));}.dscb-grid{grid-template-columns:36px repeat(7,minmax(0,1fr));}}',
      '.dscb-icon{display:block;}',
    ].join('\n');

    function Styles() {
      return h('style', { 'data-dscb-styles': '' }, CSS);
    }

    function safeGet(context, name) {
      try {
        if (!context || typeof context.get !== 'function') return undefined;
        return context.get(name);
      } catch (error) {
        return undefined;
      }
    }

    function makeTranslate(localeService) {
      return function translate(key) {
        const args = Array.prototype.slice.call(arguments, 1);
        let lang = 'zh';
        try {
          const snapshot = localeService && typeof localeService.getLocale === 'function'
            ? localeService.getLocale()
            : null;
          const raw = snapshot && (snapshot.id || snapshot.locale || snapshot.language || snapshot.current);
          if (typeof raw === 'string' && raw.toLowerCase().indexOf('en') === 0) lang = 'en';
        } catch (error) {
          lang = 'zh';
        }
        const dict = DICT[lang] || DICT.zh;
        let value = dict[key];
        if (value === undefined) value = DICT.zh[key];
        if (typeof value === 'function') return value.apply(null, args);
        return value === undefined ? key : value;
      };
    }

    /** Find the Client remote face of the Host schedule service. */
    function resolveScheduleCatalog(context) {
      const roots = [];
      const viaGet = safeGet(context, 'remote');
      if (viaGet) roots.push(viaGet);
      try {
        if (context && context.remote) roots.push(context.remote);
      } catch (error) {
        /* ignore */
      }
      for (const root of roots) {
        for (const name of ['schedule', 'schedules', 'scheduleService']) {
          let namespace = null;
          try {
            namespace = root[name];
          } catch (error) {
            namespace = null;
          }
          if (!namespace) continue;
          for (const method of ['catalog', 'list']) {
            let fn = null;
            try {
              fn = namespace[method];
            } catch (error) {
              fn = null;
            }
            if (typeof fn === 'function') {
              return function callCatalog() {
                return fn.call(namespace);
              };
            }
          }
        }
      }
      return null;
    }

    function ChevronIcon(props) {
      const path = props.direction === 'right' ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5';
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        className: 'dscb-icon',
      }, h('path', {
        d: path, stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function RefreshIcon() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        className: 'dscb-icon',
      },
      h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M13.4 1.8v3.1h-3.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function CalendarGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, className: 'dscb-icon',
      },
      h('rect', { x: 3.2, y: 5, width: 17.6, height: 15.4, rx: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', { d: 'M3.2 9.8h17.6', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', { d: 'M8 3.2v3.4M16 3.2v3.4', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      h('circle', { cx: 8.4, cy: 13.6, r: 1.2, fill: 'currentColor' }),
      h('circle', { cx: 12, cy: 13.6, r: 1.2, fill: 'currentColor', opacity: 0.6 }),
      h('circle', { cx: 15.6, cy: 13.6, r: 1.2, fill: 'currentColor', opacity: 0.6 }),
      h('circle', { cx: 8.4, cy: 17.2, r: 1.2, fill: 'currentColor', opacity: 0.6 }),
      h('circle', { cx: 12, cy: 17.2, r: 1.4, fill: 'currentColor' }),
      h('circle', { cx: 15.6, cy: 17.2, r: 1.2, fill: 'currentColor', opacity: 0.6 }));
    }

    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h(React.Fragment, null, h(Styles, null), h(CalendarGlyph, { size: size, active: props && props.active }));
    }

    /** A short, soft three-note chime, synthesised so the bundle ships no audio file. */
    function playChime(audioRef) {
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return;
        if (!audioRef.current) audioRef.current = new AudioCtor();
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.state === 'suspended' && typeof audio.resume === 'function') audio.resume();
        const start = audio.currentTime;
        const notes = [880, 1174.66, 1567.98];
        notes.forEach(function (frequency, index) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const at = start + index * 0.085;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, at);
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.55);
        });
      } catch (error) {
        /* audio is optional */
      }
    }

    /** Transparent canvas that plays one short firework volley each time `token` changes. */
    function Fireworks(props) {
      const canvasRef = useRef(null);
      const token = props.token;

      useEffect(function () {
        if (!token) return undefined;
        const canvas = canvasRef.current;
        if (!canvas || typeof canvas.getContext !== 'function') return undefined;
        try {
          if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
        } catch (error) {
          /* treat as motion allowed */
        }
        const width = canvas.clientWidth || 720;
        const height = canvas.clientHeight || 480;
        if (!width || !height) return undefined;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        const surface = canvas.getContext('2d');
        if (!surface) return undefined;
        surface.setTransform(ratio, 0, 0, ratio, 0, 0);

        const palette = ['#ffb703', '#fb8500', '#8ecae6', '#219ebc', '#ff5d8f', '#a7f432', '#c77dff'];
        const bursts = [];
        const burstCount = 3;
        for (let index = 0; index < burstCount; index += 1) {
          const centerX = width * (0.26 + Math.random() * 0.48);
          const centerY = height * (0.2 + Math.random() * 0.3);
          const color = palette[Math.floor(Math.random() * palette.length)];
          const particles = [];
          const count = 44;
          for (let particle = 0; particle < count; particle += 1) {
            const angle = (Math.PI * 2 * particle) / count + Math.random() * 0.25;
            const speed = 55 + Math.random() * 150;
            particles.push({
              x: centerX,
              y: centerY,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 0.85 + Math.random() * 0.55,
              delay: index * 0.11 + Math.random() * 0.06,
              size: 1.4 + Math.random() * 1.8,
            });
          }
          bursts.push({ color: color, particles: particles });
        }

        let started = 0;
        let handle = 0;
        function frame(timestamp) {
          if (!started) started = timestamp;
          const elapsed = (timestamp - started) / 1000;
          surface.globalCompositeOperation = 'destination-out';
          surface.fillStyle = 'rgba(0,0,0,0.28)';
          surface.fillRect(0, 0, width, height);
          surface.globalCompositeOperation = 'lighter';
          let alive = false;
          for (const burst of bursts) {
            for (const particle of burst.particles) {
              const local = elapsed - particle.delay;
              if (local <= 0 || local > particle.life) continue;
              alive = true;
              const drag = Math.exp(-local * 1.7);
              const x = particle.x + (particle.vx * (1 - drag)) / 1.7;
              const y = particle.y + (particle.vy * (1 - drag)) / 1.7 + 110 * local * local;
              const alpha = Math.max(0, 1 - local / particle.life);
              surface.globalAlpha = alpha;
              surface.fillStyle = burst.color;
              surface.beginPath();
              surface.arc(x, y, particle.size * alpha + 0.5, 0, Math.PI * 2);
              surface.fill();
            }
          }
          surface.globalAlpha = 1;
          surface.globalCompositeOperation = 'source-over';
          if (alive && elapsed < 2.4) {
            handle = requestAnimationFrame(frame);
          } else {
            surface.clearRect(0, 0, width, height);
          }
        }
        handle = requestAnimationFrame(frame);
        return function () {
          cancelAnimationFrame(handle);
        };
      }, [token]);

      return h('canvas', { ref: canvasRef, className: 'dscb-fireworks', 'aria-hidden': true });
    }

    /** Pure-CSS confetti burst: visible even where canvas drawing is unavailable. */
    function Confetti(props) {
      const token = props.token;
      const pieces = useMemo(function () {
        if (!token) return [];
        const colors = ['#ffb703', '#fb8500', '#8ecae6', '#219ebc', '#ff5d8f', '#a7f432', '#c77dff'];
        const out = [];
        for (let index = 0; index < 24; index += 1) {
          const angle = (Math.PI * 2 * index) / 24 + Math.random() * 0.35;
          const distance = 80 + Math.random() * 150;
          out.push({
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance - 30,
            rot: Math.round(Math.random() * 720 - 360),
            delay: Math.round(Math.random() * 130),
            size: 5 + Math.random() * 5,
            color: colors[index % colors.length],
          });
        }
        return out;
      }, [token]);

      if (!token) return null;
      return h('div', { key: 'confetti-' + token, className: 'dscb-confetti', 'aria-hidden': true },
        pieces.map(function (piece, index) {
          return h('span', {
            key: index,
            className: 'dscb-confetti-piece',
            style: {
              left: '50%',
              top: '42%',
              width: piece.size + 'px',
              height: (piece.size * 0.62) + 'px',
              background: piece.color,
              animationDelay: piece.delay + 'ms',
              '--x': Math.round(piece.x) + 'px',
              '--y': Math.round(piece.y) + 'px',
              '--r': piece.rot + 'deg',
            },
          });
        }));
    }

    function SparkleIcon() {
      return h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        className: 'dscb-icon',
      },
      h('path', {
        d: 'M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z',
        fill: 'currentColor', fillOpacity: 0.9,
      }));
    }

    function SpeakerIcon(props) {
      const muted = props && props.muted;
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        className: 'dscb-icon',
      },
      h('path', {
        d: 'M3 6.2h2.1L8.3 3.6v8.8L5.1 9.8H3z',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
      }),
      muted
        ? h('path', { d: 'M10.6 6.2l3 3m0-3l-3 3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })
        : h('path', {
          d: 'M10.4 6a2.8 2.8 0 0 1 0 4M12.1 4.4a5 5 0 0 1 0 7.2',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }));
    }

    function createBoard(ctx) {
      const localeService = safeGet(ctx, 'locale');
      const t = makeTranslate(localeService);

      return function CalendarBoard() {
        const [localeTick, setLocaleTick] = useState(0);
        const [view, setView] = useState(function () {
          const now = new Date();
          return { year: now.getFullYear(), month: now.getMonth() };
        });
        const [selected, setSelected] = useState(function () { return dateKey(new Date()); });
        const [items, setItems] = useState(readItems);
        const [sync, setSync] = useState('unknown');
        const [sources, setSources] = useState([]);
        const [external, setExternal] = useState([]);
        const [hidden, setHidden] = useState(readHiddenSources);
        const [subForm, setSubForm] = useState(null);
        const [connectOpen, setConnectOpen] = useState(false);
        const [localCals, setLocalCals] = useState({ loaded: false, error: '', items: [] });
        const [subError, setSubError] = useState('');
        const [feedTick, setFeedTick] = useState(0);
        const [nowTick, setNowTick] = useState(0);
        const [schedule, setSchedule] = useState({ status: 'loading', entries: [], source: null });
        const [notifyOn, setNotifyOn] = useState(readNotifyFlag);
        const [notice, setNotice] = useState('');
        const [draft, setDraft] = useState({ title: '', time: '', repeat: false });
        const [editing, setEditing] = useState(null);
        const [cellDraft, setCellDraft] = useState('');
        const [soundOn, setSoundOn] = useState(readSoundFlag);
        const [cheer, setCheer] = useState(null);
        const [fireworks, setFireworks] = useState(0);
        const itemsRef = useRef(items);
        const connectedRef = useRef(false);
        const hostRef = useRef('unknown');
        const dirtyRef = useRef(false);
        const pushTimerRef = useRef(null);
        const catalogRef = useRef(undefined);
        const inputRef = useRef(null);
        const cellAddRef = useRef(null);
        const audioRef = useRef(null);
        const firedRef = useRef(null);
        if (!firedRef.current) firedRef.current = new Set();

        useEffect(function () {
          if (!localeService || typeof localeService.subscribe !== 'function') return undefined;
          return localeService.subscribe(function () { setLocaleTick(function (n) { return n + 1; }); });
        }, []);

        useEffect(function () {
          writeItems(items);
        }, [items]);

        useEffect(function () {
          const timer = setInterval(function () { setNowTick(function (n) { return n + 1; }); }, 30000);
          return function () { clearInterval(timer); };
        }, []);

        function pushToHost(list) {
          if (hostRef.current !== 'host') return;
          try {
            fetch('/calendar-board/items', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ items: list }),
            }).then(function (response) {
              if (!response || !response.ok) throw new Error('push refused');
              dirtyRef.current = false;
            }).catch(function () {
              hostRef.current = 'local';
              setSync('local');
            });
          } catch (error) {
            hostRef.current = 'local';
            setSync('local');
          }
        }

        /** Every mutation goes through here so the Host copy follows the page. */
        function commitItems(compute) {
          const next = compute(itemsRef.current);
          itemsRef.current = next;
          setItems(next);
          if (hostRef.current !== 'host') return;
          dirtyRef.current = true;
          if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
          pushTimerRef.current = setTimeout(function () {
            pushTimerRef.current = null;
            pushToHost(itemsRef.current);
          }, 350);
        }

        function adoptHost(list) {
          itemsRef.current = list;
          setItems(list);
          writeItems(list);
        }

        /**
         * Pull the Host copy. The first success decides the mode; when the Host
         * store is still empty the page hands its localStorage entries over once.
         * Later successes only replace local state when nothing is mid-edit.
         */
        function connectHost() {
          if (typeof fetch !== 'function') {
            setSync('local');
            return;
          }
          fetch('/calendar-board/items', { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response || !response.ok) throw new Error('items route refused');
              return response.json();
            })
            .then(function (payload) {
              if (!payload || payload.ok !== true || !Array.isArray(payload.items)) throw new Error('items payload');
              const remote = payload.items.map(normalizeClientItem).filter(Boolean);
              const first = !connectedRef.current;
              connectedRef.current = true;
              hostRef.current = 'host';
              setSync('host');
              if (first) {
                const local = itemsRef.current || [];
                if (remote.length === 0 && local.length > 0) {
                  pushToHost(local);
                  return;
                }
                if (canonicalItems(remote) !== canonicalItems(local)) adoptHost(remote);
                return;
              }
              if (dirtyRef.current) return;
              if (canonicalItems(remote) !== canonicalItems(itemsRef.current)) adoptHost(remote);
            })
            .catch(function () {
              if (connectedRef.current) return;
              hostRef.current = 'local';
              setSync('local');
            });
        }

        useEffect(function () {
          connectHost();
          const timer = setInterval(function () {
            if (dirtyRef.current) return;
            connectHost();
            setFeedTick(function (n) { return n + 1; });
          }, 15000);
          return function () { clearInterval(timer); };
        }, []);

        /** Calendar subscriptions: the source list and their events in the shown grid. */
        function loadFeeds() {
          if (typeof fetch !== 'function') return;
          const grid = monthMatrix(view.year, view.month);
          const from = dateKey(grid[0]);
          const to = dateKey(grid[grid.length - 1]);
          fetch('/calendar-board/sources', { headers: { accept: 'application/json' } })
            .then(function (response) { return response && response.ok ? response.json() : null; })
            .then(function (payload) {
              if (payload && payload.ok && Array.isArray(payload.sources)) setSources(payload.sources);
            })
            .catch(function () {});
          fetch('/calendar-board/events?from=' + from + '&to=' + to, { headers: { accept: 'application/json' } })
            .then(function (response) { return response && response.ok ? response.json() : null; })
            .then(function (payload) {
              if (payload && payload.ok && Array.isArray(payload.events)) setExternal(payload.events);
            })
            .catch(function () {});
        }

        useEffect(loadFeeds, [view.year, view.month, feedTick]);

        const externalByDay = useMemo(function () {
          const map = new Map();
          for (const event of external) {
            if (hidden.indexOf(event.sourceId) >= 0) continue;
            if (!map.has(event.date)) map.set(event.date, []);
            map.get(event.date).push(event);
          }
          for (const list of map.values()) {
            list.sort(function (a, b) { return (a.time || '00:00').localeCompare(b.time || '00:00'); });
          }
          return map;
        }, [external, hidden]);

        const legend = useMemo(function () {
          const builtins = [
            { id: 'local', kind: 'local', color: 'blue', name: t('legendLocal') },
            { id: 'schedule', kind: 'schedule', color: 'amber', name: t('legendSchedule') },
          ];
          const feeds = sources
            .filter(function (source) { return source.kind === 'ics'; })
            .map(function (source) {
              return {
                id: source.id,
                kind: 'ics',
                color: source.color || 'green',
                name: source.name,
                error: source.lastError,
                pending: source.pending === true,
              };
            });
          return builtins.concat(feeds);
        }, [sources, localeTick]);

        function toggleSource(id) {
          const next = hidden.indexOf(id) >= 0
            ? hidden.filter(function (item) { return item !== id; })
            : hidden.concat([id]);
          setHidden(next);
          writeHiddenSources(next);
        }

        function submitSubscription() {
          const form = subForm || {};
          if (!form.url || !String(form.url).trim()) {
            setSubError(t('subscribeFailed'));
            return;
          }
          fetch('/calendar-board/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'add',
              name: form.name || '',
              url: form.url,
              color: form.color || 'green',
            }),
          })
            .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
            .then(function (result) {
              if (!result.ok || !result.body || result.body.ok !== true) {
                throw new Error((result.body && result.body.error) || 'refused');
              }
              setSubForm(null);
              setSubError('');
              setFeedTick(function (n) { return n + 1; });
            })
            .catch(function (error) {
              setSubError(t('subscribeFailed') + ': ' + String((error && error.message) || error));
            });
        }


        function loadLocalCalendars() {
          fetch('/calendar-board/calendars?provider=local', { headers: { accept: 'application/json' } })
            .then(function (response) { return response && response.ok ? response.json() : null; })
            .then(function (payload) {
              if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'failed');
              setLocalCals({ loaded: true, error: '', items: Array.isArray(payload.calendars) ? payload.calendars : [] });
            })
            .catch(function (error) {
              setLocalCals({ loaded: true, error: String((error && error.message) || error), items: [] });
            });
        }

        useEffect(function () {
          if (connectOpen) loadLocalCalendars();
        }, [connectOpen]);

        function toggleLocalCalendar(item) {
          const body = item.subscribed
            ? { action: 'remove', id: item.sourceId }
            : { action: 'add', provider: 'local', calendarId: item.id, color: 'green' };
          fetch('/calendar-board/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function () {
              loadLocalCalendars();
              setFeedTick(function (n) { return n + 1; });
            })
            .catch(function () {});
        }

        function unsubscribeSource(id) {
          fetch('/calendar-board/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'remove', id: id }),
          })
            .then(function () { setFeedTick(function (n) { return n + 1; }); })
            .catch(function () {});
        }

        const loadSchedules = useCallback(function () {
          if (catalogRef.current === undefined) {
            catalogRef.current = resolveScheduleCatalog(ctx) || null;
          }
          const call = catalogRef.current;
          let outcome = null;
          if (call) {
            try {
              outcome = call();
            } catch (error) {
              outcome = null;
            }
          }
          const remote = outcome && typeof outcome.then === 'function' ? outcome : Promise.resolve(outcome);
          Promise.resolve(remote).then(function (value) {
            if (!Array.isArray(value)) throw new Error('unexpected schedule payload');
            return { entries: value, source: 'remote' };
          }).catch(function () {
            if (typeof fetch !== 'function') throw new Error('fetch unavailable');
            return fetch('/calendar-board/schedules', { headers: { accept: 'application/json' } })
              .then(function (response) {
                if (!response || !response.ok) throw new Error('schedule route refused');
                return response.json();
              })
              .then(function (payload) {
                if (!payload || payload.ok !== true || !Array.isArray(payload.entries)) {
                  throw new Error('schedule route payload');
                }
                return { entries: payload.entries, source: 'route' };
              });
          }).then(function (settled) {
            setSchedule({ status: 'ready', entries: settled.entries, source: settled.source });
          }, function () {
            setSchedule(function (prev) {
              return {
                status: call ? 'error' : 'unavailable',
                entries: prev.entries,
                source: prev.source || null,
              };
            });
          });
        }, []);

        useEffect(function () {
          loadSchedules();
          const timer = setInterval(loadSchedules, 120000);
          return function () { clearInterval(timer); };
        }, [loadSchedules]);

        const days = useMemo(function () {
          return monthMatrix(view.year, view.month);
        }, [view.year, view.month]);

        const clockNow = useMemo(function () { return new Date(); }, [nowTick]);
        const todayKey = dateKey(clockNow);
        const occurrenceOptions = useMemo(function () {
          return { now: clockNow, todayKey: todayKey };
        }, [clockNow, todayKey]);

        const grid = useMemo(function () {
          return days.map(function (day) {
            const key = dateKey(day);
            const calendarItems = (externalByDay.get(key) || []).map(function (event) {
              return {
                key: 'cal:' + event.sourceId + ':' + key + ':' + event.title + ':' + event.time,
                id: event.sourceId,
                source: 'calendar',
                color: event.color,
                sourceName: event.sourceName,
                title: event.title,
                time: event.time,
                allDay: !!event.allDay,
                date: key,
              };
            });
            return {
              date: day,
              key: key,
              items: calendarItems.concat(occurrencesForDay(items, schedule.entries, key, t, occurrenceOptions)),
            };
          });
        }, [days, items, schedule.entries, externalByDay, localeTick, occurrenceOptions]);

        const selectedItems = useMemo(function () {
          return occurrencesForDay(items, schedule.entries, selected, t, occurrenceOptions);
        }, [items, schedule.entries, selected, localeTick, occurrenceOptions]);

        const todayItems = useMemo(function () {
          return occurrencesForDay(items, schedule.entries, todayKey, t, occurrenceOptions);
        }, [items, schedule.entries, todayKey, localeTick, occurrenceOptions]);

        const selectedEvents = externalByDay.get(selected) || [];

        useEffect(function () {
          if (!notifyOn) return undefined;
          function tick() {
            const now = new Date();
            const key = dateKey(now);
            const clock = clockText(now);
            const list = occurrencesForDay(items, schedule.entries, key, t, { now: now, todayKey: key });
            for (const entry of list) {
              if (entry.source !== 'user' || entry.done || !entry.time) continue;
              if (entry.time !== clock) continue;
              if (firedRef.current.has(entry.key)) continue;
              firedRef.current.add(entry.key);
              try {
                if (typeof Notification === 'function' && Notification.permission === 'granted') {
                  new Notification(clock + ' · ' + entry.title, { body: t('panelTitle') });
                }
              } catch (error) {
                /* ignore notification failures */
              }
            }
          }
          tick();
          const timer = setInterval(tick, 30000);
          return function () { clearInterval(timer); };
        }, [notifyOn, items, schedule.entries, localeTick]);

        function addItemFor(dayKey, title, options) {
          const clean = String(title || '').trim();
          if (!clean) return;
          const extra = options || {};
          commitItems(function (prev) {
            return prev.concat([{
              id: newId(),
              date: dayKey,
              time: extra.time || '',
              title: clean,
              repeat: extra.repeat ? 'daily' : 'none',
              doneDates: [],
              color: '',
              underline: false,
            }]);
          });
          setNotice('');
        }

        function commitDraft() {
          const title = draft.title.trim();
          if (!title) return;
          addItemFor(selected, title, { time: draft.time, repeat: draft.repeat });
          setDraft({ title: '', time: draft.time, repeat: draft.repeat });
        }

        function patchItem(id, patch) {
          commitItems(function (prev) {
            return prev.map(function (item) {
              return item.id === id ? Object.assign({}, item, patch) : item;
            });
          });
        }

        function cycleColor(entry) {
          const current = entry.color || '';
          const index = PALETTE.indexOf(current);
          const next = PALETTE[(index + 1) % PALETTE.length];
          patchItem(entry.id, { color: next });
        }

        function toggleUnderline(entry) {
          patchItem(entry.id, { underline: !entry.underline });
        }

        function beginEditing(dayKey) {
          if (editing && editing !== dayKey) commitCellDraft();
          setSelected(dayKey);
          setEditing(dayKey);
          setCellDraft('');
        }

        function commitCellDraft() {
          const title = cellDraft.trim();
          if (!title) return;
          addItemFor(editing || selected, title);
          setCellDraft('');
        }

        function focusCellInput() {
          const node = cellAddRef.current;
          if (node && typeof node.focus === 'function') node.focus();
        }

        useEffect(function () {
          if (editing) focusCellInput();
        }, [editing]);

        useEffect(function () {
          if (!cheer) return undefined;
          const timer = setTimeout(function () { setCheer(null); }, 1900);
          return function () { clearTimeout(timer); };
        }, [cheer]);

        function celebrate(title, preview) {
          let text = title ? t('cheer', title) : t('cheerFallback');
          if (preview) text = t('previewCheer');
          setCheer({ id: Date.now() + Math.random(), text: text });
          setFireworks(function (n) { return n + 1; });
          if (soundOn) playChime(audioRef);
        }

        function toggleItem(entry) {
          if (!entry.done) celebrate(entry.title);
          commitItems(function (prev) {
            return prev.map(function (item) {
              if (item.id !== entry.id) return item;
              const doneDates = Array.isArray(item.doneDates) ? item.doneDates.slice() : [];
              const index = doneDates.indexOf(entry.date);
              if (index >= 0) doneDates.splice(index, 1);
              else doneDates.push(entry.date);
              return Object.assign({}, item, { doneDates: doneDates });
            });
          });
        }

        function removeItem(entry) {
          commitItems(function (prev) {
            return prev.filter(function (item) { return item.id !== entry.id; });
          });
        }

        function shiftMonth(delta) {
          const next = new Date(view.year, view.month + delta, 1);
          setView({ year: next.getFullYear(), month: next.getMonth() });
          setSelected(dateKey(next));
        }

        function goToday() {
          const now = new Date();
          setView({ year: now.getFullYear(), month: now.getMonth() });
          setSelected(dateKey(now));
        }

        function addForToday() {
          goToday();
          setNotice('');
          setTimeout(function () {
            if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus();
          }, 0);
        }

        function enableNotifications() {
          if (notifyOn) {
            setNotifyOn(false);
            writeNotifyFlag(false);
            setNotice('');
            return;
          }
          try {
            if (typeof Notification !== 'function') {
              setNotice(t('notifyUnsupported'));
              return;
            }
            if (Notification.permission === 'granted') {
              setNotifyOn(true);
              writeNotifyFlag(true);
              setNotice('');
              return;
            }
            if (Notification.permission === 'denied') {
              setNotice(t('notifyDenied'));
              return;
            }
            const request = Notification.requestPermission();
            if (request && typeof request.then === 'function') {
              request.then(function (result) {
                if (result === 'granted') {
                  setNotifyOn(true);
                  writeNotifyFlag(true);
                  setNotice('');
                } else {
                  setNotice(t('notifyDenied'));
                }
              }, function () { setNotice(t('notifyDenied')); });
            }
          } catch (error) {
            setNotice(t('notifyUnsupported'));
          }
        }

        const scheduleChip = (function () {
          if (schedule.status === 'ready') {
            const count = schedule.entries.length;
            return { dot: count ? 'ready' : '', text: count ? t('syncReady', count) : t('syncEmpty') };
          }
          if (schedule.status === 'loading') return { dot: 'loading', text: t('syncLoading') };
          if (schedule.status === 'error') return { dot: 'error', text: t('syncError') };
          if (schedule.status === 'unavailable') return { dot: 'error', text: t('syncUnavailable') };
          return { dot: '', text: t('syncLoading') };
        })();

        const selectedDate = keyToDate(selected);
        const selectedDone = selectedItems.filter(function (entry) { return entry.done; }).length;
        const totalCount = todayItems.length;
        const doneCount = todayItems.filter(function (entry) { return entry.done; }).length;
        const progress = selectedItems.length ? Math.round((selectedDone / selectedItems.length) * 100) : 0;
        const weekdayLabels = t('weekdays');
        const selectedWeekday = weekdayLabels[isoDay(selectedDate) - 1];

        const headerLeft = h('div', { className: 'dscb-head-main' },
          h('button', {
            type: 'button',
            className: 'dscb-icon-btn',
            title: t('prevMonth'),
            'aria-label': t('prevMonth'),
            onClick: function () { shiftMonth(-1); },
          }, h(ChevronIcon, { direction: 'left' })),
          h('button', {
            type: 'button',
            className: 'dscb-icon-btn',
            title: t('nextMonth'),
            'aria-label': t('nextMonth'),
            onClick: function () { shiftMonth(1); },
          }, h(ChevronIcon, { direction: 'right' })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'dscb-title' }, t('monthLabel', view.year, view.month + 1)),
            h('div', { className: 'dscb-sub' },
              t('dayLabel', selectedDate.getMonth() + 1, selectedDate.getDate()) + ' · ' +
              selectedWeekday + ' · ' + t('lunarPrefix') + ' ' + lunarFullText(selectedDate) + ' · ' +
              t('taskCount', totalCount))));

        const headerRight = h('div', { className: 'dscb-head-actions' },
          h('span', {
            className: 'dscb-chip',
            title: t('subtitle') + (schedule.source ? ' · ' + schedule.source : ''),
          },
            h('span', { className: 'dscb-dot' + (scheduleChip.dot ? ' dscb-dot-' + scheduleChip.dot : '') }),
            scheduleChip.text),
          h('button', { type: 'button', className: 'dscb-btn', title: t('today'), onClick: goToday }, t('today')),
          h('button', { type: 'button', className: 'dscb-btn dscb-btn-primary', onClick: addForToday },
            '+ ' + t('addToday')),
          h('button', { type: 'button', className: 'dscb-btn', title: t('hint'), onClick: enableNotifications },
            notifyOn ? t('notifyOn') : t('notifyEnable')),
          h('button', {
            type: 'button',
            className: 'dscb-icon-btn',
            title: t('previewTitle'),
            'aria-label': t('previewTitle'),
            onClick: function () { celebrate('', true); },
          }, h(SparkleIcon, null)),
          h('button', {
            type: 'button',
            className: 'dscb-icon-btn',
            title: soundOn ? t('soundOn') : t('soundOff'),
            'aria-label': t('soundToggle'),
            'aria-pressed': soundOn,
            onClick: function () {
              const next = !soundOn;
              setSoundOn(next);
              writeSoundFlag(next);
              if (next) playChime(audioRef);
            },
          }, h(SpeakerIcon, { muted: !soundOn })),
          h('button', {
            type: 'button',
            className: 'dscb-icon-btn',
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: loadSchedules,
          }, h(RefreshIcon, null)));

        const header = h('header', { className: 'dscb-head' }, headerLeft, headerRight);

        const legendBar = h('div', { className: 'dscb-legend' },
          h('span', { className: 'dscb-legend-title' }, t('legendTitle')),
          legend.map(function (source) {
            const off = hidden.indexOf(source.id) >= 0;
            return h('span', {
              key: source.id,
              role: 'button',
              tabIndex: 0,
              className: 'dscb-source dscb-src-' + source.color + (off ? ' is-off' : ''),
              title: source.name + (source.error ? ' · ' + source.error : ''),
              onClick: function () { toggleSource(source.id); },
              onKeyDown: function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleSource(source.id);
                }
              },
            },
            h('span', { className: 'dscb-source-dot' }),
            h('span', null, source.name + (source.pending ? ' …' : '')),
            source.kind === 'ics'
              ? h('span', {
                className: 'dscb-source-x',
                role: 'button',
                tabIndex: 0,
                title: t('removeSubscription'),
                'aria-label': t('removeSubscription'),
                onClick: function (event) {
                  event.stopPropagation();
                  unsubscribeSource(source.id);
                },
              }, '×')
              : null);
          }),
          h('button', {
            type: 'button',
            className: 'dscb-source-add',
            title: t('subscribeTitle'),
            onClick: function () {
              setSubForm(subForm ? null : { name: '', url: '', color: 'green' });
              setSubError('');
            },
          }, '+ ' + t('subscribe')),
          h('button', {
            type: 'button',
            className: 'dscb-source-add',
            title: t('connectTitle'),
            onClick: function () {
              setConnectOpen(!connectOpen);
              setOauthError('');
            },
          }, '+ ' + t('connectCalendar')));

        const weekHead = h('div', { className: 'dscb-weekrow' },
          h('div', { className: 'dscb-weekhead', 'aria-hidden': true }, t('weekNumber')),
          weekdayLabels.map(function (label, index) {
            return h('div', {
              key: label,
              className: 'dscb-weekhead' + (index >= 5 ? ' is-weekend' : ''),
            }, label);
          }));

        function readOnlyLine(entry) {
          const lineClasses = ['dscb-line'];
          if (entry.source === 'schedule') lineClasses.push('is-schedule', 'is-' + (entry.state || 'due'));
          if (entry.source === 'calendar') lineClasses.push('is-calendar', 'dscb-src-' + (entry.color || 'gray'));
          if (entry.done) lineClasses.push('is-done');
          if (entry.status === 'inactive') lineClasses.push('is-ended');
          return h('div', {
            key: entry.key,
            className: lineClasses.join(' '),
            title: entry.title + (entry.rule ? ' · ' + entry.rule : ''),
          },
          h('span', { className: 'dscb-line-mark' }),
          entry.time ? h('span', { className: 'dscb-line-time' }, entry.time) : null,
          h('span', { className: ['dscb-line-title'].concat(decorationClasses(entry)).join(' ') }, entry.title));
        }

        const cells = [];
        for (let index = 0; index < grid.length; index += 7) {
          const week = grid.slice(index, index + 7);
          cells.push(h('div', { key: 'w' + index, className: 'dscb-weeknum' }, String(isoWeek(week[0].date))));
          for (const cell of week) {
            const outside = cell.date.getMonth() !== view.month;
            const isEditing = editing === cell.key;
            const classes = ['dscb-cell'];
            if (outside) classes.push('is-outside');
            if (cell.key === todayKey) classes.push('is-today');
            if (cell.key === selected) classes.push('is-selected');
            if (isEditing) classes.push('is-editing');

            const userEntries = cell.items.filter(function (entry) { return entry.source === 'user'; });
            const scheduleEntries = cell.items.filter(function (entry) { return entry.source === 'schedule'; });

            let lines;
            if (isEditing) {
              const rows = userEntries.map(function (entry) {
                return h('div', { key: entry.key, className: 'dscb-cell-row' },
                  h('input', {
                    className: ['dscb-cell-input'].concat(decorationClasses(entry)).join(' '),
                    value: entry.title,
                    'aria-label': entry.title,
                    onChange: function (event) { patchItem(entry.id, { title: event.target.value }); },
                    onBlur: function (event) {
                      if (!String(event.target.value).trim()) removeItem(entry);
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        focusCellInput();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setEditing(null);
                      }
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dscb-cell-x',
                    title: t('remove'),
                    'aria-label': t('remove'),
                    onMouseDown: function (event) { event.preventDefault(); },
                    onClick: function () { removeItem(entry); },
                  }, '×'));
              });
              lines = rows.concat([
                h('input', {
                  key: '__new',
                  ref: cellAddRef,
                  className: 'dscb-cell-input',
                  placeholder: t('cellAdd'),
                  value: cellDraft,
                  'aria-label': t('cellAdd'),
                  onChange: function (event) { setCellDraft(event.target.value); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitCellDraft();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      commitCellDraft();
                      setEditing(null);
                    }
                  },
                }),
              ]);
              const calendarCount = cell.items.filter(function (entry) { return entry.source === 'calendar'; }).length;
              if (scheduleEntries.length) {
                lines.push(h('div', { key: '__schedules', className: 'dscb-more' }, t('scheduleInline', scheduleEntries.length)));
              }
              if (calendarCount) {
                lines.push(h('div', { key: '__calendar', className: 'dscb-more' }, t('calendarInline', calendarCount)));
              }
            } else {
              const shown = cell.items.slice(0, 3);
              const rest = cell.items.length - shown.length;
              lines = shown.map(readOnlyLine);
              if (rest > 0) lines.push(h('div', { key: '__more', className: 'dscb-more' }, t('moreItems', rest)));
            }

            const cellProps = {
              key: cell.key,
              className: classes.join(' '),
              onClick: function () {
                if (!isEditing) beginEditing(cell.key);
              },
              onMouseDown: function (event) {
                if (!isEditing) return;
                const target = event.target;
                const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
                if (tag === 'input' || tag === 'button') return;
                event.preventDefault();
                focusCellInput();
              },
              onBlur: function (event) {
                if (!isEditing) return;
                const next = event.relatedTarget;
                if (next && event.currentTarget.contains(next)) return;
                commitCellDraft();
                setEditing(null);
                setCellDraft('');
              },
            };
            if (!isEditing) {
              cellProps.role = 'button';
              cellProps.tabIndex = 0;
              cellProps.title = t('cellHint');
              cellProps['aria-label'] = t('dayLabel', cell.date.getMonth() + 1, cell.date.getDate()) + ' ' + lunarText(cell.date);
              cellProps.onKeyDown = function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  beginEditing(cell.key);
                }
              };
            }

            cells.push(h('div', cellProps,
              h('div', { className: 'dscb-cell-head' },
                h('span', { className: 'dscb-daynum' }, String(cell.date.getDate())),
                h('span', { className: 'dscb-lunar' }, lunarText(cell.date)),
                cell.items.length ? h('span', { className: 'dscb-cell-badge' }, String(cell.items.length)) : null),
              h('div', { className: 'dscb-cell-items' }, lines)));
          }
        }

        const taskRows = selectedItems.length
          ? selectedItems.map(function (entry, index) {
            const isSchedule = entry.source === 'schedule';
            const taskClasses = ['dscb-task'];
            if (isSchedule) taskClasses.push('is-schedule', 'is-' + (entry.state || 'due'));
            if (entry.done) taskClasses.push('is-done');
            const meta = [];
            if (entry.time) meta.push(h('span', { key: 'time' }, entry.time));
            if (isSchedule) {
              meta.push(h('span', { key: 'tag', className: 'dscb-tag' }, t('scheduleTag')));
              if (entry.state) {
                const label = entry.state === 'due' ? t('schedDue')
                  : entry.state === 'next' ? t('schedNext')
                    : entry.state === 'done' ? t('schedDone')
                      : t('schedExpired');
                meta.push(h('span', { key: 'state', className: 'dscb-tag dscb-tag-' + entry.state }, label));
              }
              if (entry.rule) meta.push(h('span', { key: 'rule' }, entry.rule));
              if (entry.status === 'inactive') {
                meta.push(h('span', { key: 'status', className: 'dscb-tag' }, t('endedTag')));
              }
            } else if (entry.repeat === 'daily') {
              meta.push(h('span', { key: 'repeat', className: 'dscb-tag' }, t('repeatDaily')));
            }

            const titleNode = isSchedule
              ? h('span', { className: ['dscb-task-title'].concat(decorationClasses(entry)).join(' ') }, entry.title)
              : h('input', {
                className: ['dscb-text'].concat(decorationClasses(entry)).join(' '),
                value: entry.title,
                'aria-label': entry.title,
                title: t('editHint'),
                onChange: function (event) { patchItem(entry.id, { title: event.target.value }); },
                onBlur: function (event) {
                  if (!String(event.target.value).trim()) removeItem(entry);
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (inputRef.current && inputRef.current.focus) inputRef.current.focus();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    if (event.target && event.target.blur) event.target.blur();
                  }
                },
              });

            const tools = isSchedule ? null : h('div', { className: 'dscb-task-tools' },
              h('button', {
                type: 'button',
                className: 'dscb-tool' + (entry.underline ? ' is-on' : ''),
                title: t('toolsUnderline'),
                'aria-label': t('toolsUnderline'),
                onMouseDown: function (event) { event.preventDefault(); },
                onClick: function () { toggleUnderline(entry); },
              }, h('span', { style: { textDecoration: 'underline' } }, 'U')),
              h('button', {
                type: 'button',
                className: 'dscb-tool',
                title: t('toolsColor'),
                'aria-label': t('toolsColor'),
                onMouseDown: function (event) { event.preventDefault(); },
                onClick: function () { cycleColor(entry); },
              }, h('span', {
                className: ['dscb-tool-dot'].concat(entry.color ? ['dscb-color-' + entry.color] : []).join(' '),
              })),
              h('button', {
                type: 'button',
                className: 'dscb-tool',
                title: t('remove'),
                'aria-label': t('remove'),
                onMouseDown: function (event) { event.preventDefault(); },
                onClick: function () { removeItem(entry); },
              }, '×'));

            return h('div', { key: entry.key, className: taskClasses.join(' ') },
              isSchedule
                ? h('span', { className: 'dscb-line-mark', style: { marginTop: 6 } })
                : h('input', {
                  type: 'checkbox',
                  className: 'dscb-check',
                  checked: !!entry.done,
                  'aria-label': entry.title,
                  title: t('toolsDone'),
                  onChange: function () { toggleItem(entry); },
                }),
              h('div', { className: 'dscb-task-main' },
                h('div', { className: 'dscb-task-line' },
                  h('span', { className: 'dscb-index' }, String(index + 1) + '.'),
                  titleNode),
                meta.length ? h('div', { className: 'dscb-task-meta' }, meta) : null),
              tools);
          })
          : h('div', { className: 'dscb-empty' },
            h('div', null, t('noItems')),
            h('div', { className: 'dscb-hint', style: { marginTop: 4 } }, t('emptyHint')));

        const addForm = h('form', {
          className: 'dscb-add',
          onSubmit: function (event) { event.preventDefault(); commitDraft(); },
          onBlur: function (event) {
            const next = event.relatedTarget;
            if (next && event.currentTarget.contains(next)) return;
            if (draft.title.trim()) commitDraft();
          },
        },
        h('input', {
          ref: inputRef,
          className: 'dscb-input',
          value: draft.title,
          placeholder: t('addPlaceholder'),
          'aria-label': t('addPlaceholder'),
          onChange: function (event) {
            const value = event.target.value;
            setDraft(function (prev) { return Object.assign({}, prev, { title: value }); });
          },
        }),
        h('div', { className: 'dscb-add-row' },
          h('input', {
            type: 'time',
            className: 'dscb-input dscb-input-time',
            value: draft.time,
            'aria-label': 'time',
            onChange: function (event) {
              const value = event.target.value;
              setDraft(function (prev) { return Object.assign({}, prev, { time: value }); });
            },
          }),
          h('label', { className: 'dscb-switch' },
            h('input', {
              type: 'checkbox',
              className: 'dscb-check',
              checked: draft.repeat,
              onChange: function (event) {
                const checked = event.target.checked;
                setDraft(function (prev) { return Object.assign({}, prev, { repeat: checked }); });
              },
            }),
            t('repeatDaily')),
          h('button', { type: 'submit', className: 'dscb-btn dscb-btn-primary', style: { marginLeft: 'auto' } }, t('add'))));

        const rail = h('aside', { className: 'dscb-rail' },
          h('div', null,
            h('div', { className: 'dscb-rail-date' },
              t('dayLabel', selectedDate.getMonth() + 1, selectedDate.getDate()) + ' ' + selectedWeekday),
            h('div', { className: 'dscb-rail-meta' },
              h('span', null, t('lunarPrefix') + ' ' + lunarFullText(selectedDate)),
              h('span', null, t('taskDone', selectedDone, selectedItems.length))),
            h('div', { className: 'dscb-progress' }, h('span', { style: { width: progress + '%' } })),
            h('div', { className: 'dscb-progress-text' }, t('taskDone', selectedDone, selectedItems.length)),
            selected === todayKey ? null : h('div', { className: 'dscb-progress-text' }, t('todayLine', doneCount, totalCount))),
          connectOpen
            ? h('div', { className: 'dscb-sub-form' },
              h('div', { className: 'dscb-hint', style: { fontWeight: 600 } }, t('localCalendarsTitle')),
              h('div', { className: 'dscb-hint' }, t('localCalendarsHint')),
              localCals.error
                ? h('div', { className: 'dscb-hint' }, localCals.error)
                : !localCals.loaded
                  ? h('div', { className: 'dscb-hint' }, t('localCalendarsLoading'))
                  : localCals.items.length === 0
                    ? h('div', { className: 'dscb-hint' }, t('localCalendarsEmpty'))
                    : h('div', { className: 'dscb-list' }, localCals.items.map(function (item) {
                      return h('div', { key: item.id, className: 'dscb-task' },
                        h('div', { className: 'dscb-task-main' },
                          h('div', { className: 'dscb-task-title' }, item.name)),
                        h('button', {
                          type: 'button',
                          className: 'dscb-btn' + (item.subscribed ? '' : ' dscb-btn-primary'),
                          onClick: function () { toggleLocalCalendar(item); },
                        }, item.subscribed ? t('localRemove') : t('localAdd')));
                    })))
            : null,
          subForm
            ? h('form', {
              className: 'dscb-sub-form',
              onSubmit: function (event) { event.preventDefault(); submitSubscription(); },
            },
            h('div', { className: 'dscb-sub-row' },
              h('input', {
                className: 'dscb-input',
                placeholder: t('nameLabel'),
                value: subForm.name,
                'aria-label': t('nameLabel'),
                onChange: function (event) {
                  const value = event.target.value;
                  setSubForm(function (prev) { return Object.assign({}, prev, { name: value }); });
                },
              }),
              h('button', {
                type: 'button',
                className: 'dscb-tool',
                title: t('cancel'),
                onClick: function () { setSubForm(null); setSubError(''); },
              }, '×')),
            h('input', {
              className: 'dscb-input',
              placeholder: t('urlLabel'),
              value: subForm.url,
              'aria-label': t('urlLabel'),
              onChange: function (event) {
                const value = event.target.value;
                setSubForm(function (prev) { return Object.assign({}, prev, { url: value }); });
              },
            }),
            h('div', { className: 'dscb-sub-row' },
              h('span', { className: 'dscb-hint' }, t('colorLabel')),
              h('select', {
                className: 'dscb-select',
                value: subForm.color,
                'aria-label': t('colorLabel'),
                onChange: function (event) {
                  const value = event.target.value;
                  setSubForm(function (prev) { return Object.assign({}, prev, { color: value }); });
                },
              }, ['green', 'blue', 'amber', 'red', 'gray'].map(function (color) {
                return h('option', { key: color, value: color }, t('colorNames')[color] || color);
              })),
              h('button', {
                type: 'submit',
                className: 'dscb-btn dscb-btn-primary',
                style: { marginLeft: 'auto' },
              }, t('addSubscription'))),
            subError ? h('div', { className: 'dscb-hint' }, subError) : null)
            : null,
          addForm,
          selectedEvents.length
            ? h('div', { className: 'dscb-scroll' },
              h('div', { className: 'dscb-section' }, t('calendarSection')),
              h('div', { className: 'dscb-list' }, selectedEvents.map(function (event) {
                return h('div', {
                  key: 'ev:' + event.sourceId + ':' + event.date + ':' + event.time + ':' + event.title,
                  className: 'dscb-task is-calendar dscb-src-' + (event.color || 'gray'),
                },
                h('span', { className: 'dscb-line-mark', style: { marginTop: 6 } }),
                h('div', { className: 'dscb-task-main' },
                  h('div', { className: 'dscb-task-title' }, event.title),
                  h('div', { className: 'dscb-task-meta' },
                    h('span', null, event.time || t('allDayLabel')),
                    h('span', { className: 'dscb-tag' }, event.sourceName || t('calendarTag')))));
              })))
            : null,
          h('div', { className: 'dscb-scroll' },
            h('div', { className: 'dscb-section' }, t('todaySection')),
            h('div', { className: 'dscb-list' }, taskRows),
            h('div', { className: 'dscb-hint' }, t('editHint'))),
          notice ? h('div', { className: 'dscb-hint' }, notice) : null,
          h('div', { className: 'dscb-hint' },
            t('hint') + ' · ' + BUILD_TAG +
            (sync === 'host' ? ' · ' + t('syncHost') : sync === 'local' ? ' · ' + t('syncLocal') : '')));

        return h('div', { className: 'dscb-root' },
          h(Styles, null),
          header,
          legendBar,
          h('div', { className: 'dscb-body' },
            h('section', { className: 'dscb-cal' }, weekHead, h('div', { className: 'dscb-grid' }, cells)),
            rail),
          h(Fireworks, { token: fireworks }),
          h(Confetti, { token: fireworks }),
          cheer
            ? h('div', { className: 'dscb-cheer', role: 'status' },
              h('span', { className: 'dscb-cheer-dot' }),
              h('span', { className: 'dscb-cheer-text' }, cheer.text))
            : null);
      };
    }

    class BoardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      render() {
        if (this.state.failed) {
          return h('div', {
            style: {
              padding: '24px',
              margin: '24px',
              borderRadius: '12px',
              border: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          }, 'Calendar board could not render.');
        }
        return this.props.children;
      }
    }

    const MIGRATED_KEY = 'dsh-calendar-board.migrated.v1';

    /** Hand a page's pre-1.1 entries to the Host store once, panel open or not. */
    function migrateToHost() {
      try {
        if (window.localStorage.getItem(MIGRATED_KEY) === '1') return;
      } catch (error) {
        return;
      }
      if (typeof fetch !== 'function') return;
      const mark = function () {
        try { window.localStorage.setItem(MIGRATED_KEY, '1'); } catch (error) { /* ignore */ }
      };
      fetch('/calendar-board/items', { headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('items route refused');
          return response.json();
        })
        .then(function (payload) {
          if (!payload || payload.ok !== true || !Array.isArray(payload.items)) throw new Error('items payload');
          if (payload.items.length > 0) {
            mark();
            return undefined;
          }
          let local = [];
          try {
            local = JSON.parse(window.localStorage.getItem('dsh-calendar-board.items.v1') || '[]');
          } catch (error) {
            local = [];
          }
          const items = Array.isArray(local) ? local.map(normalizeClientItem).filter(Boolean) : [];
          if (!items.length) {
            mark();
            return undefined;
          }
          return fetch('/calendar-board/items', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: items }),
          }).then(function (response) {
            if (!response || !response.ok) throw new Error('migration refused');
            mark();
          });
        })
        .catch(function () {
          /* Host not reachable yet: try again on the next page load. */
        });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        migrateToHost();
        const Board = createBoard(ctx);

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'calendar',
            order: 21,
            label: function () { return makeTranslate(safeGet(ctx, 'locale'))('panelTitle'); },
          }, SidebarIcon);
        });

        // Build beacon: an unused main-panel key that names the loaded module
        // generation, so an inspector can tell whether a reload picked up the
        // current file. It renders nothing and is never selected.
        ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: 'calendar-build-' + BUILD_TAG,
          }, function BuildBeacon() {
            return null;
          });
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: 'calendar',
          }, function CalendarPanel() {
            return h(BoardBoundary, null, h(Board, null));
          });
        });
      },
    };
  },
});
})();
