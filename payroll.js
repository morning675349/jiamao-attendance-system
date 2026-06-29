// 台灣勞保投保薪資分級表 (2025)
const LABOR_BRACKETS = [
  26400, 27600, 28800, 30300, 31800, 33300, 34800, 36300, 38200,
  40100, 42000, 43900, 45800, 48200, 50600, 53000, 55400, 57800,
  60800, 63800, 66800, 69800, 72800, 76500, 80300, 84000, 87600,
  92100, 96600, 101100, 105600, 110100, 115500, 120900, 126300,
  131700, 137100, 142500, 147900, 150000, 182000
];

function findBracket(salary) {
  for (const b of LABOR_BRACKETS) {
    if (salary <= b) return b;
  }
  return LABOR_BRACKETS[LABOR_BRACKETS.length - 1];
}

// 勞保：(勞保10.5% + 就業保險1%) × 員工負擔20%
function calcLaborInsurance(bracket) {
  return Math.round(bracket * 0.115 * 0.2);
}

// 健保：5.17% × 員工負擔30% × (1 + 眷屬人數)
function calcHealthInsurance(bracket, dependents) {
  return Math.round(bracket * 0.0517 * 0.3 * (1 + (dependents || 0)));
}

// 加班費：每日獨立計算，前2hr × 1.34，超2hr × 1.67
function calcOvertimePay(baseSalary, sessions) {
  const hourlyRate = baseSalary / 240;
  let total = 0;
  for (const s of sessions) {
    const h = Number(s.hours) || 0;
    if (h <= 2) {
      total += hourlyRate * 1.34 * h;
    } else {
      total += hourlyRate * 1.34 * 2 + hourlyRate * 1.67 * (h - 2);
    }
  }
  return Math.round(total);
}

// 遲到扣款：月薪 ÷ 240 × 遲到分鐘數 ÷ 60
function calcLateDeduction(baseSalary, lateMinutes) {
  const hourlyRate = baseSalary / 240;
  return Math.round(hourlyRate * ((lateMinutes || 0) / 60));
}

// 假別扣款
// 事假：月薪/240 × 小時
// 病假有文件：(月薪/240×8) × 0.5 × 天數（半薪）
// 病假無文件：以事假論，月薪/240 × 小時（全扣）
// 特休、生理假：不扣
function calcLeaveDeduction(baseSalary, leaves) {
  const hourlyRate = baseSalary / 240;
  const dailyRate = hourlyRate * 8;
  let total = 0;
  for (const l of leaves) {
    const hours = Number(l.hours) || 8;
    if (l.type === 'personal') {
      total += hourlyRate * hours;
    } else if (l.type === 'sick') {
      if (l.hasDocument) {
        total += dailyRate * 0.5 * (hours / 8);
      } else {
        total += hourlyRate * hours;
      }
    }
  }
  return Math.round(total);
}

// 伙食津貼：出勤天 × 80元
function calcMealAllowance(attendanceDays) {
  return (attendanceDays || 0) * 80;
}

// 加班伙食津貼：加班 >= 2hr 的場次每次 80元
function calcOvertimeMealAllowance(sessions) {
  return sessions.filter(s => Number(s.hours) >= 2).length * 80;
}

// 月薪資自動計算（草稿，admin可再手動調整）
function generatePayroll({ salarySettings, attendance, approvedLeaves, approvedOT }) {
  const s = salarySettings || {};
  const baseSalary = Number(s.baseSalary) || 0;

  const attendanceDays = attendance.filter(a => a.checkIn).length;
  const totalLateMinutes = attendance.reduce((sum, a) => sum + (Number(a.lateMinutes) || 0), 0);
  const totalOTHours = approvedOT.reduce((sum, o) => sum + (Number(o.hours) || 0), 0);

  const bracket = Number(s.insuranceBracket) || findBracket(baseSalary);

  const income = {
    baseSalary,
    jobAllowance:        Number(s.jobAllowance) || 0,
    perfectAttendance:   Number(s.perfectAttendance) || 0,
    mealAllowance:       calcMealAllowance(attendanceDays),
    overtimeMealAllowance: calcOvertimeMealAllowance(approvedOT),
    overtimePay:         calcOvertimePay(baseSalary, approvedOT),
    transportAllowance:  Number(s.transportAllowance) || 0,
    phoneAllowance:      Number(s.phoneAllowance) || 0,
    businessTripFuel:    Number(s.businessTripFuel) || 0,
    quarterBonus:        Number(s.quarterBonus) || 0,
    performanceBonus:    Number(s.performanceBonus) || 0,
    supportAllowance:    Number(s.supportAllowance) || 0,
    driverAllowance:     Number(s.driverAllowance) || 0,
    skillAllowance:      Number(s.skillAllowance) || 0,
    holidayGift:         Number(s.holidayGift) || 0,
    otherAllowance:      Number(s.otherAllowance) || 0,
  };

  const deductions = {
    laborInsurance:  calcLaborInsurance(bracket),
    healthInsurance: calcHealthInsurance(bracket, s.dependentCount),
    lateDeduction:   calcLateDeduction(baseSalary, totalLateMinutes),
    leaveDeduction:  calcLeaveDeduction(baseSalary, approvedLeaves),
  };

  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const totalDeductions = Object.values(deductions).reduce((a, b) => a + b, 0);

  return {
    income,
    deductions,
    totalIncome,
    totalDeductions,
    netSalary: totalIncome - totalDeductions,
    summary: {
      attendanceDays,
      totalLateMinutes,
      totalOTHours: Math.round(totalOTHours * 10) / 10,
      insuranceBracket: bracket,
    },
  };
}

module.exports = {
  LABOR_BRACKETS,
  findBracket,
  calcLaborInsurance,
  calcHealthInsurance,
  calcOvertimePay,
  calcLateDeduction,
  calcLeaveDeduction,
  calcMealAllowance,
  calcOvertimeMealAllowance,
  generatePayroll,
};
