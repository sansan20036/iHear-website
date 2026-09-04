const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
const IGNORED = /(?:https?:\/\/|mailto:)[^\s]+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|⟦IH_[^⟧]+⟧/giu;

// Common simplified-only characters. OpenCC performs the authoritative
// conversion; this list only decides whether the helper should be offered.
const SIMPLIFIED_HINT = /[万与专业东丝两严丧个临为丽举义乌乐乔习乡书买乱争于亏云亚产亩亲亿仅从仓仪们价众优会伞伟传伤伦伪体余佣侠侣侥侦侧侨俩俭债倾偿储儿兑党兰关兴养兽冈册写军农冯冲决况冻净准凉减凑凤凭凯击划刘则刚创删别刮制剂剑剧劝办务动励劲劳势勋匀区医华协单卖卢卫却厂厅历厉压厌厕厦厨县叁参双发变叙叶号叹吓吕吗吨听启吴员呛呜咏咙咸响哑哒哓哔哗哙哜哝哟唤啧啬啭啮啰喂喷喽嗫嘘嘤嘱噜嚣团园围国图圆圣场坏块坚坛坝坞坟坠垄垒垦垫埘埙埚堑墙壮声壳壶处备复够头夸夹夺奋奖奥妇妈妆姗姜娄娱婴孙学宁宝实宠审宪宫宽宾对寻导寿将尔尘尝层届属岁岂岗岛岭岳峡币帅师帐帘帜带帮庄庆庐库应庙废广归当录彦彻径忆忧怀态怂总恋恳恶恼悦悬惊惧惨惩惫惯愤愿慑懒戏户拥拦拟拢拣担据损换挥捞损摇摄摆摊撑撵敌数斋斓斗断无旧时旷昙昼显晋晒晓暂术朴机杀杂权条来杨杰松板极构枪柜标栈栋栏树样桥桨档梦检楼欢欧歼残殴毁毕气汇汉汤沟没泪泼泽洁洼浅浆浇济浑浓涂涌涛涡涣润涧涨涩淀渊渐渔湾湿溃溅滚满滞滤滥滨滩潇潜澜灭灯灵灾灿炉炖点炼烁烂烛烟烦烧烫热爱爷牵犹狈狞独狭狮狱猎猪猫献玛环现电画畅疗疟疡疮疯痪瘫瘾皱盘盖盗监盘眯着矿码砖础硕确礼祷祸离种积称秽稳穷窃窍竞笔笋筛筹签简类粮紧纠红纤约级纪纬纯纱纲纳纵纷纸纹纺纽线练组细织终绍经绑绒结绕绘给络绝统绣继绩绪续绳维绿缀缅缆缩缴网罗罚罢羁职联聪肃肠肤肾肿胀胆胜脑脚脱脸腻腾舆舰舱艺节芜苇苍苏苹范茎荐药莲获莹营萧萨葱蒋蓝蓟蔷蕴薮虚虫虽虾蚀蚂蚕蛮蛰蝇蝉蜡蝎蝼衅补装裤见观规视览觉触订计认讨让训议讯记讲讳讷许论讼设访证评识诈诉诊词译试诗诚话询该详诫语误说请诸诺读课谁调谈谊谋谍谎谓谢谣谨谱贝负贡财责贤败账货质贩贪贫购贮贯贴贵贷费贺贼贾赃资赋赌赏赐赔赖赞赵赶趋跃践踊踪车轨轩转轮软轰轴轻载较辅辆辈辉辑输辙辽达迁过迈运还这进远违连迟适选递逻遗邮邻郁郑酝酱酿释里鉴针钉钙钝钟钢钥钦钩钱钳钻铁铃铅铐铛铜铝铭银铺链销锁锅锋锐错锡锣锤锥锦键锯锻镀镇镜长门闪闭问闯闲间闷闸闹闻阁阀阅队阳阴阵阶际陆陈险随隐隶难雾霁静顶项顺须顽顾顿颁颂预领颇频题颜额风飘飞饥饭饮饰饱饲饼馆马驭驮驯驰驱驳驻驼驾骂骄骆验骑骗骚骤鱼鲁鲜鸟鸡鸣鸥鸦鸭鸳鸵鹅鹤鹰麦黄齐齿龄龙龟]/u;

function meaningfulLetters(value) {
  return Array.from(String(value || "").replace(IGNORED, "")).filter((character) => LETTER.test(character));
}

export function inspectEnglishSource(value) {
  const letters = meaningfulLetters(value);
  const hanCount = letters.filter((character) => HAN.test(character)).length;
  const ratio = letters.length ? hanCount / letters.length : 0;
  return { warning: letters.length > 0 && ratio > 0.2, ratio, hanCount, letterCount: letters.length };
}

export function inspectChineseField(value) {
  const letters = meaningfulLetters(value);
  const hanCount = letters.filter((character) => HAN.test(character)).length;
  return {
    missingHan: letters.length > 10 && hanCount === 0,
    likelySimplified: hanCount > 0 && SIMPLIFIED_HINT.test(String(value || "")),
    hanCount,
    letterCount: letters.length,
  };
}

export function hasRiskyEnglish(values) {
  return values.some((value) => inspectEnglishSource(value).warning);
}

const browserMessages = {
  en: { english: "⚠️ Chinese content was detected. English is the source for automatic translation; enter English here for the most accurate result.", accept: "Translate this content anyway", missing: "⚠️ This Chinese field contains no Chinese characters. Check whether English was pasted here by mistake.", simplified: "Simplified Chinese may be present in the Traditional Chinese field.", convert: "Convert to Taiwan Traditional Chinese", preview: "Conversion preview", apply: "Apply conversion", cancel: "Cancel", failed: "Could not convert this text." },
  zhHant: { english: "⚠️ 偵測到中文內容：系統以英文為自動翻譯來源，建議在此輸入英文以確保翻譯準確。", accept: "仍以此內容翻譯", missing: "⚠️ 此欄位未包含中文字元，請確認是否誤貼英文。", simplified: "偵測到繁中欄位可能含有簡體字或中國大陸用語。", convert: "一鍵轉為台灣繁中", preview: "轉換預覽", apply: "套用轉換", cancel: "取消", failed: "目前無法轉換這段文字。" },
  zhHans: { english: "⚠️ 检测到中文内容：系统以英文为自动翻译来源，建议在此输入英文以确保翻译准确。", accept: "仍以此内容翻译", missing: "⚠️ 此字段未包含中文字符，请确认是否误贴英文。", simplified: "检测到繁体中文字段可能含有简体字或中国大陆用语。", convert: "一键转为台湾繁体中文", preview: "转换预览", apply: "应用转换", cancel: "取消", failed: "目前无法转换这段文字。" },
};

export function renderLanguageGuard(container, options) {
  if (!container) return { blocked: false };
  const { language, value = "", uiLocale = "en", englishAccepted = false, disabled = false, onAcceptEnglish, onChange } = options || {};
  const text = browserMessages[uiLocale] || browserMessages.en;
  const englishWarning = language === "en" && inspectEnglishSource(value).warning && !englishAccepted;
  const chinese = language === "en" ? null : inspectChineseField(value);
  container.replaceChildren(); container.hidden = true;
  const paragraph = (message) => { const node = document.createElement("p"); node.textContent = message; container.appendChild(node); };
  const button = (label, action) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.disabled = disabled; node.addEventListener("click", action); container.appendChild(node); return node; };
  if (englishWarning) { paragraph(text.english); button(text.accept, () => onAcceptEnglish?.()); }
  if (chinese?.missingHan) paragraph(text.missing);
  if (language === "zhHant" && chinese?.likelySimplified) {
    paragraph(text.simplified);
    const convert = button(text.convert, async () => {
      convert.disabled = true;
      try {
        const response = await fetch("/api/admin/translations/traditionalize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.value) throw new Error(data?.error || text.failed);
        const preview = document.createElement("div"); preview.className = "language-guard-conversion";
        const title = document.createElement("strong"), before = document.createElement("del"), after = document.createElement("ins"), actions = document.createElement("div");
        title.textContent = text.preview; before.textContent = value; after.textContent = data.value;
        const apply = document.createElement("button"); apply.type = "button"; apply.textContent = text.apply; apply.addEventListener("click", () => onChange?.(data.value));
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = text.cancel; cancel.addEventListener("click", () => preview.remove());
        actions.append(apply, cancel); preview.append(title, before, after, actions); container.appendChild(preview);
      } catch (error) { paragraph(error?.message || text.failed); }
      finally { convert.disabled = disabled; }
    });
  }
  container.hidden = !container.childNodes.length;
  return { blocked: englishWarning };
}
