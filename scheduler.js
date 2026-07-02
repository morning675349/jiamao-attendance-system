const db = require('./db');
const client = require('./lineClient');
const { getTaipeiTime } = require('./utils');

function adminIds() {
  return db.getAllEmployees().filter(e => e.role === 'admin').map(e => e.lineId);
}
function nameOf(lineId) {
  return (db.getAllEmployees().find(e => e.lineId === lineId) || {}).name || '員工';
}
function pushAdmins(text) {
  adminIds().forEach(id => client.pushMessage({ to: id, messages: [{ type: 'text', text }] }).catch(() => {}));
}

// 早上 10:00：中午用餐統計（需要便當 = 選「用餐」者）
function notifyLunchStats() {
  const { date } = getTaipeiTime();
  const today = db.getAllAttendance().filter(a => a.date === date && a.checkIn);
  const need = today.filter(a => a.lunchMeal !== false);   // 用餐 = 需要公司便當
  const noNeed = today.filter(a => a.lunchMeal === false);  // 不用餐 = 補 80 元
  const names = need.map(a => '・' + nameOf(a.lineId)).join('\n') || '（無）';
  pushAdmins(`🍱 今日中午用餐統計（${date}）\n────────────\n需要便當：${need.length} 人\n不需要：${noNeed.length} 人\n\n【需要便當名單】\n${names}`);
}

// 早上 09:30：每日出勤彙總（一次一則，取代每筆打卡推播，省 LINE 額度）
function notifyAttendanceSummary() {
  const { date } = getTaipeiTime();
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(date).getDay()];
  const emps = db.getAllEmployees().filter(e => e.role === 'employee');
  const today = db.getAllAttendance().filter(a => a.date === date && a.checkIn);
  const inIds = new Set(today.map(a => a.lineId));
  const late = today.filter(a => a.status === 'late');
  const notYet = emps.filter(e => !inIds.has(e.lineId));
  const lateNames = late.map(a => `・${nameOf(a.lineId)}（${a.checkIn}）`).join('\n') || '（無）';
  const notYetNames = notYet.map(e => '・' + e.name).join('\n') || '（無）';
  pushAdmins(
    `📊 今日出勤彙總（${date} 週${w}）\n` +
    `────────────\n` +
    `已出勤：${today.length} 人\n遲到：${late.length} 人\n未打卡：${notYet.length} 人\n\n` +
    `【遲到】\n${lateNames}\n\n【未打卡】\n${notYetNames}\n\n` +
    `※ 完整記錄請看後台「出勤記錄」`
  );
}

// 每 30 秒檢查台北時間，到點推播；同日只發一次
// 加班便當改由員工填加班單時選、主管於後台加班單查看，不再定時推播
function start() {
  const sent = {};
  setInterval(() => {
    let date, time;
    try { ({ date, time } = getTaipeiTime()); } catch (e) { return; }
    if (time === '09:30' && sent.summary !== date) {
      sent.summary = date;
      try { notifyAttendanceSummary(); } catch (e) { console.error('summary notify error:', e.message); }
    }
    if (time === '10:00' && sent.lunch !== date) {
      sent.lunch = date;
      try { notifyLunchStats(); } catch (e) { console.error('lunch notify error:', e.message); }
    }
  }, 30 * 1000);
  console.log('⏱️  排程已啟動（09:30 出勤彙總、10:00 中午用餐統計）');
}

module.exports = { start, notifyLunchStats, notifyAttendanceSummary };
