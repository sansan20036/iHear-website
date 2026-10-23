// NT$ and US$ prices are set separately by the Academy team; never convert between them.
const prices = {
  TWD: { 45: { highschool: 800, college: 1000 }, 60: { highschool: 1000, college: 1400 } },
  USD: { 45: { highschool: 25, college: 34 }, 60: { highschool: 34, college: 45 } }
};
const symbols = { TWD: 'NT$', USD: 'US$' };
const packageSessions = 10;
const packagePercent = 90; // Ten-session packages are 10% off (九折).

function selected(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function money(currency, amount) {
  return symbols[currency] + amount.toLocaleString('en-US');
}

function updatePrice() {
  const currency = selected('currency');
  const minutes = selected('duration');
  const tutor = selected('tutor');
  const packagePlan = selected('plan') === 'package';
  const rate = prices[currency][minutes][tutor];
  const total = rate * packageSessions * packagePercent / 100;
  const saving = rate * packageSessions - total;
  const chinese = document.documentElement.lang === 'zh-Hant';
  const symbol = document.createElement('span');
  symbol.className = 'price-currency';
  symbol.textContent = symbols[currency];
  document.getElementById('price').replaceChildren(symbol, (packagePlan ? total : rate).toLocaleString('en-US'));
  document.querySelectorAll('[data-tutor-price]').forEach(node => {
    node.textContent = money(currency, prices[currency][minutes][node.dataset.tutorPrice]) + (chinese ? '／堂' : '/session');
  });
  if (chinese) {
    const tutorName = tutor === 'college' ? '大學生' : '高中生';
    document.getElementById('price-unit').textContent = packagePlan ? `/ 十堂・每堂 ${minutes} 分鐘` : `/ 堂・${minutes} 分鐘`;
    document.getElementById('price-detail').textContent = packagePlan
      ? `十堂 ${minutes} 分鐘課程共 ${money(currency, total)}（九折），比購買十堂單堂課程省下 ${money(currency, saving)}，相當於一堂課。由${tutorName}導師授課。`
      : `${tutorName}導師的一對一課程，每堂 ${minutes} 分鐘 ${money(currency, rate)}。本頁各項英文學習服務皆適用相同費率。`;
    return;
  }
  const tutorName = tutor === 'college' ? 'college' : 'high-school';
  document.getElementById('price-unit').textContent = packagePlan ? `/ ten ${minutes}-minute sessions` : `/ ${minutes}-minute session`;
  document.getElementById('price-detail').textContent = packagePlan
    ? `Ten ${minutes}-minute sessions with a ${tutorName} tutor: ${money(currency, total)} at 10% off, saving ${money(currency, saving)}, the cost of one session.`
    : `One ${minutes}-minute session with a ${tutorName} tutor: ${money(currency, rate)}. The same rate applies to all available subjects, including SAT/PSAT.`;
}
document.querySelectorAll('input[name="currency"], input[name="duration"], input[name="tutor"], input[name="plan"]').forEach(input => input.addEventListener('change', updatePrice));
updatePrice();
