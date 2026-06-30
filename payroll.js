// 2026年（民國115年1月）勞健保投保金額分級表 — 員工負擔（官方金額）
// a=投保金額, l=勞保員工負擔, h=健保員工負擔(本人)。勞保投保薪資上限 45,800（l 之後固定 1,145），健保續算。
const INSURANCE_TABLE = [
  {a:29500,l:738,h:458}, {a:30300,l:758,h:470}, {a:31800,l:795,h:493},
  {a:33300,l:833,h:516}, {a:34800,l:870,h:540}, {a:36300,l:908,h:563},
  {a:38200,l:955,h:592}, {a:40100,l:1002,h:622}, {a:42000,l:1050,h:651},
  {a:43900,l:1098,h:681}, {a:45800,l:1145,h:710}, {a:48200,l:1145,h:748},
  {a:50600,l:1145,h:785}, {a:53000,l:1145,h:822}, {a:55400,l:1145,h:859},
  {a:57800,l:1145,h:896}, {a:60800,l:1145,h:943}, {a:63800,l:1145,h:990},
  {a:66800,l:1145,h:1036}, {a:69800,l:1145,h:1083}, {a:72800,l:1145,h:1129},
  {a:76500,l:1145,h:1187}, {a:80200,l:1145,h:1244}, {a:83900,l:1145,h:1301},
  {a:87600,l:1145,h:1359}, {a:92100,l:1145,h:1428}, {a:96600,l:1145,h:1498},
  {a:101100,l:1145,h:1568}, {a:105600,l:1145,h:1638}, {a:110100,l:1145,h:1708},
  {a:115500,l:1145,h:1791}, {a:120900,l:1145,h:1875}, {a:126300,l:1145,h:1959},
  {a:131700,l:1145,h:2043}, {a:137100,l:1145,h:2126}, {a:142500,l:1145,h:2210},
  {a:147900,l:1145,h:2294}, {a:150000,l:1145,h:2327}, {a:156400,l:1145,h:2426},
  {a:162800,l:1145,h:2525}, {a:169200,l:1145,h:2624}, {a:175600,l:1145,h:2724},
  {a:182000,l:1145,h:2823}, {a:189500,l:1145,h:2939}, {a:197000,l:1145,h:3055},
  {a:204500,l:1145,h:3172}, {a:212000,l:1145,h:3288}, {a:219500,l:1145,h:3404},
  {a:228200,l:1145,h:3539}, {a:236900,l:1145,h:3674}, {a:245600,l:1145,h:3809},
  {a:254300,l:1145,h:3944}, {a:263000,l:1145,h:4079}, {a:273000,l:1145,h:4234},
  {a:283000,l:1145,h:4389}, {a:293000,l:1145,h:4544}, {a:303000,l:1145,h:4700},
  {a:313000,l:1145,h:4855},
];
const LABOR_BRACKETS = INSURANCE_TABLE.map(r => r.a);

function findBracket(salary) {
  for (const r of INSURANCE_TABLE) if (salary <= r.a) return r.a;
  return INSURANCE_TABLE[INSURANCE_TABLE.length - 1].a;
}

function bracketRow(amount) {
  return INSURANCE_TABLE.find(r => r.a === Number(amount))
      || INSURANCE_TABLE.find(r => Number(amount) <= r.a)
      || INSURANCE_TABLE[INSURANCE_TABLE.length - 1];
}

// 勞保員工負擔（2026 官方金額；投保上限 45,800 → 固定 1,145）
function calcLaborInsurance(bracket) {
  return bracketRow(bracket).l;
}

// 健保員工負擔 = 本人金額 ×（1 + 眷屬數）；眷屬上限 3 口（2026 官方金額）
function calcHealthInsurance(bracket, dependents) {
  const deps = Math.min(Math.max(Number(dependents) || 0, 0), 3);
  return bracketRow(bracket).h * (1 + deps);
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

// 伙食津貼：當天「不用餐」且「遲到 ≤ 60 分」→ 80元（未選視為用餐，不補）
function calcMealAllowance(attendance) {
  return (attendance || []).reduce((sum, a) => {
    if (!a.checkIn) return sum;                          // 沒上班不算
    const ate = a.lunchMeal !== false;                  // 未設或 true 視為用餐
    const lateOver1hr = (Number(a.lateMinutes) || 0) > 60;
    return sum + ((!ate && !lateOver1hr) ? 80 : 0);
  }, 0);
}

// 加班伙食津貼：核准加班 ≥ 2hr 且申請時選「不需要便當」→ 80元（每場）
// （需要便當 meal=true → 公司供餐不另發；不需要 meal=false → 補 80）
function calcOvertimeMealAllowance(approvedOT) {
  return (approvedOT || []).filter(o => Number(o.hours) >= 2 && o.meal === false).length * 80;
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
    mealAllowance:       calcMealAllowance(attendance),
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
