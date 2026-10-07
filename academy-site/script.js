function updatePrice() {
  const college = document.querySelector('input[name="tutor"]:checked').value === 'college';
  const packagePlan = document.querySelector('input[name="plan"]:checked').value === 'package';
  const rate = college ? 40 : 35;
  const total = rate * 10 - 20;
  const tutor = college ? 'college' : 'high-school';
  const chinese = document.documentElement.lang === 'zh-Hant';
  document.getElementById('price').textContent = '$' + (packagePlan ? total : rate);
  if (chinese) {
    const tutorName = college ? '大學生' : '高中生';
    document.getElementById('price-unit').textContent = packagePlan ? '/ 十堂・每堂 60 分鐘' : '/ 堂・60 分鐘';
    document.getElementById('price-detail').textContent = packagePlan
      ? `平均每堂 USD ${total / 10}，由${tutorName}導師授課，整套方案節省 USD 20。本頁各項英文學習服務皆適用相同費率。`
      : `${tutorName}導師的一對一課程，每堂 60 分鐘。本頁各項英文學習服務皆適用相同費率。`;
    document.getElementById('package-note').textContent = `${tutorName}導師方案：十堂 60 分鐘課程共 USD ${total}，比十堂單堂課程節省 USD 20。其他時長或形式的費用需另行確認。`;
    return;
  }
  document.getElementById('price-unit').textContent = packagePlan ? '/ ten 60-minute sessions' : '/ 60-minute session';
  document.getElementById('price-detail').textContent = packagePlan
    ? '$' + (total / 10) + ' per session with a ' + tutor + ' tutor. Save $20. All available subjects, including SAT/PSAT, have the same rate.'
    : 'One 60-minute session with a ' + tutor + ' tutor. The same rate applies to all available subjects, including SAT/PSAT.';
  document.getElementById('package-note').textContent = (college ? 'College' : 'High-school') + ' tutor package: ten 60-minute sessions for $' + total + '. Save $20 compared with ten individual sessions. Other durations or formats require a separate quote.';
}
document.querySelectorAll('input[name="plan"], input[name="tutor"]').forEach(input => input.addEventListener('change', updatePrice));
updatePrice();
