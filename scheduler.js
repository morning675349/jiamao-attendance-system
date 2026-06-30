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

// 下午 15:30：加班便當數（加班申請選「需要便當」者）
function notifyOtMealStats() {
  const { date } = getTaipeiTime();
  const ot = db.getAllOvertimeRequests().filter(o => o.date === date && o.status !== 'rejected');
  const need = ot.filter(o => o.meal);
  const names = need.map(o => `・${nameOf(o.lineId)}（${o.startTime}-${o.endTime}）`).join('\n') || '（無）';
  pushAdmins(`🍱 今晚加班便當（${date}）\n────────────\n需要便當：${need.length} 個\n（加班申請共 ${ot.length} 件）\n\n【便當名單】\n${names}`);
}

// 每 30 秒檢查台北時間，到點推播；同日只發一次
function start() {
  const sent = {};
  setInterval(() => {
    let date, time;
    try { ({ date, time } = getTaipeiTime()); } catch (e) { return; }
    if (time === '10:00' && sent.lunch !== date) {
      sent.lunch = date;
      try { notifyLunchStats(); } catch (e) { console.error('lunch notify error:', e.message); }
    }
    if (time === '15:30' && sent.ot !== date) {
      sent.ot = date;
      try { notifyOtMealStats(); } catch (e) { console.error('ot notify error:', e.message); }
    }
  }, 30 * 1000);
  console.log('⏱️  用餐統計排程已啟動（10:00 中午、15:30 加班便當）');
}

module.exports = { start, notifyLunchStats, notifyOtMealStats };
