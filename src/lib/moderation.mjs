import { createHash } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const blockingRules = [
  {
    code: 'SEXUAL_CONTENT_INVOLVING_MINORS',
    test: (text) => /(?:未成年|儿童|小学生|幼女|男童)/u.test(text) && /(?:色情|性爱|裸照|性行为)/u.test(text),
  },
  {
    code: 'SELF_HARM_INSTRUCTIONS',
    test: (text) => /(?:自杀|轻生|自残)/u.test(text) && /(?:方法|教程|步骤|怎么做|成功率)/u.test(text),
  },
  {
    code: 'DANGEROUS_INSTRUCTIONS',
    test: (text) => /(?:炸弹|爆炸物|制毒|毒品)/u.test(text) && /(?:制作|配方|教程|步骤|原料)/u.test(text),
  },
  {
    code: 'CREDENTIAL_EXFILTRATION',
    test: (text) => /(?:读取|窃取|输出|泄露)/u.test(text) && /(?:api\s*key|密钥|密码|cookie|token)/iu.test(text),
  },
];

const reviewRules = [
  { code: 'CONTACT_INFORMATION', test: (text) => /(?:1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:微信|vx|qq)\s*[:：]?\s*[\w-]{5,})/iu.test(text) },
  { code: 'EXTERNAL_LINK', test: (text) => /https?:\/\//iu.test(text) },
  { code: 'TARGETED_HATE_OR_HARASSMENT', test: (text) => /(?:消灭|杀光|赶走).{0,12}(?:民族|种族|宗教|残疾人|同性恋)/u.test(text) },
  { code: 'PROMPT_OVERRIDE', test: (text) => /(?:忽略|无视).{0,12}(?:系统|规则|之前的指令|安全限制)/u.test(text) },
];

export function moderateText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const blocked = blockingRules.filter((rule) => rule.test(text)).map((rule) => rule.code);
  if (blocked.length > 0) return { decision: 'block', reasons: blocked, digest: digest(text) };
  const review = reviewRules.filter((rule) => rule.test(text)).map((rule) => rule.code);
  if (review.length > 0) return { decision: 'review', reasons: review, digest: digest(text) };
  return { decision: 'allow', reasons: [], digest: digest(text) };
}
