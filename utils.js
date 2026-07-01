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

// 計算特休天數（勞基法 §38，依年資級距）；有手動覆蓋則使用覆蓋值
//  未滿6個月：0　6個月~未滿1年：3　1~未滿2年：7　2~未滿3年：10
//  3~未滿5年：14　5~未滿10年：15　10年以上：每滿1年加1日，上限30日
//  （即 10年=16、11年=17…24年起封頂 30）
function calcAnnualLeaveDays(joinDate, override) {
  if (override !== null && override !== undefined && override !== '') return Number(override);
  if (!joinDate) return 0;
  const joined = new Date(joinDate);
  if (isNaN(joined.getTime())) return 0;
  const years = (new Date() - joined) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 0.5) return 0;
  if (years < 1)   return 3;
  if (years < 2)   return 7;
  if (years < 3)   return 10;
  if (years < 5)   return 14;
  if (years < 10)  return 15;
  return Math.min(30, Math.floor(years) + 6);
}

// 是否為週末（六、日）。用日期部件避免時區偏移
function isWeekend(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日, 6=六
  return dow === 0 || dow === 6;
}

// 加班時數拆分：前 2 小時（×1.34）、2 小時之後（×1.67）
function splitOT(hours) {
  const h = Number(hours) || 0;
  return { ot134: Math.min(h, 2), ot167: Math.max(0, h - 2) };
}

module.exports = { getTaipeiTime, isLate, getLateMinutes, calcWorkHours, calcWorkHoursFromSegments, WEEKDAYS, calcAnnualLeaveDays, isWeekend, splitOT };
