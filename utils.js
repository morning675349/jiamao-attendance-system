function getTaipeiTime() {
  const now = new Date();
  const tz = { timeZone: 'Asia/Taipei' };
  return {
    date: now.toLocaleDateString('en-CA', tz),       // YYYY-MM-DD
    time: now.toLocaleTimeString('en-GB', tz).slice(0, 5), // HH:MM
    fullTime: now.toLocaleTimeString('en-GB', tz),   // HH:MM:SS
    month: now.toLocaleDateString('en-CA', tz).slice(0, 7), // YYYY-MM
  };
}

function isLate(checkInTime, workStart) {
  const ws = workStart || process.env.WORK_START || '09:00';
  const [ch, cm] = checkInTime.split(':').map(Number);
  const [wh, wm] = ws.split(':').map(Number);
  return ch * 60 + cm > wh * 60 + wm;
}

function getLateMinutes(checkInTime, workStart) {
  const ws = workStart || process.env.WORK_START || '09:00';
  const [ch, cm] = checkInTime.split(':').map(Number);
  const [wh, wm] = ws.split(':').map(Number);
  const diff = ch * 60 + cm - (wh * 60 + wm);
  return diff > 0 ? diff : 0;
}

function calcWorkHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [h1, m1] = checkIn.split(':').map(Number);
  const [h2, m2] = checkOut.split(':').map(Number);
  let minutes = h2 * 60 + m2 - h1 * 60 - m1;
  // 扣除午休 12:00~13:00（若工作時段有涵蓋午休則扣 60 分鐘）
  const lunchStart = 12 * 60, lunchEnd = 13 * 60;
  const workStart = h1 * 60 + m1, workEnd = h2 * 60 + m2;
  const overlapStart = Math.max(workStart, lunchStart);
  const overlapEnd = Math.min(workEnd, lunchEnd);
  if (overlapEnd > overlapStart) minutes -= (overlapEnd - overlapStart);
  return Math.round(minutes / 6) / 10;
}

// 分段工時加總：把當天每個「已閉合」時段（有 in 也有 out）的時數相加，
// 並扣除每段與午休 12:00~13:00 重疊的部分（午休選項1：中午不打卡、照舊自動扣）。
// 未閉合（外出中、尚未回來）的時段不計入。
function calcWorkHoursFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  const lunchStart = 12 * 60, lunchEnd = 13 * 60;
  let minutes = 0;
  for (const s of segments) {
    if (!s || !s.in || !s.out) continue;
    const [h1, m1] = s.in.split(':').map(Number);
    const [h2, m2] = s.out.split(':').map(Number);
    const segStart = h1 * 60 + m1, segEnd = h2 * 60 + m2;
    let seg = segEnd - segStart;
    if (seg <= 0) continue;
    const overlap = Math.min(segEnd, lunchEnd) - Math.max(segStart, lunchStart);
    if (overlap > 0) seg -= overlap;
    minutes += seg;
  }
  return Math.round(minutes / 6) / 10;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 計算特休天數：入職第一年 7 天，之後每年 +1 天
// 若有手動覆蓋（annualLeaveOverride）則使用覆蓋值
function calcAnnualLeaveDays(joinDate, override) {
  if (override !== null && override !== undefined && override !== '') return Number(override);
  if (!joinDate) return 7;
  const joined = new Date(joinDate);
  const now = new Date();
  const years = Math.floor((now - joined) / (365.25 * 24 * 60 * 60 * 1000));
  return 7 + Math.max(0, years);
}

module.exports = { getTaipeiTime, isLate, getLateMinutes, calcWorkHours, calcWorkHoursFromSegments, WEEKDAYS, calcAnnualLeaveDays };
