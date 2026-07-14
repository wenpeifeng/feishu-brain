// Fallback data used when Feishu lark-cli is not available or USE_MOCK=true
const MOCK_ANSWER = `清分单是电力交易中心发布的、用于对市场主体进行电量和电费清分结算的正式日清分账单。

**关键特征：**

| 维度 | 说明 |
|------|------|
| 来源 | 各省电力交易中心，例如“吉林电力交易中心 → 我的结算 → 结算单查询 → 省内现货日清分账单” |
| 周期 | 以日为单位发布，所以通常叫“日清分单” |
| 内容 | 包含市场成员（交易单元）每日各时点（如 96点 或 24点）的电量、电价、电费等结算数据 |
| 作用 | 是交易中心对市场出清结果进行清分、结算后的官方凭证 |

**清分单在平台中的用途：**
1. 清分单分析：按日期、交易单元、资产、点位等维度，对日清分单进行查询、汇总和统计分析。
2. 清分单校核：将日清分单的数据与平台内部的“复盘表”数据进行对比校验，检查偏差。
3. 统一结算点限价的官方来源：平台原先用自身公式计算限价，但交易中心在清分单上的限价是“黑盒”计算，交易员要求统一结算点限价以交易中心清分单上的数据为准。

简单说，清分单就是交易中心出的“官方结算账单”，平台很多价格和费用数据最终都要以它为准。`;

const MOCK_REFERENCES = [
  { index: 1, title: '边际电价、节点边际电价、分区边际电价', owner: '伊双双', date: '2025-11-04', url: 'https://example.com/doc1' },
  { index: 2, title: '电力交易基础知识培训', owner: '伊双双', date: '2025-09-20', url: 'https://example.com/doc2' },
  { index: 3, title: '从电网运行到电力市场-课件.pdf', owner: '黄蓉', date: '2025-11-14', url: 'https://example.com/doc3' },
  { index: 4, title: '节点边际电价', owner: '黄蓉', date: '2025-11-15', url: 'https://example.com/doc4' },
  { index: 5, title: '智能纪要：“从电网运行到电力市场”外部嘉宾专题分享 2025年11月15日', owner: '黄蓉', date: '2025-11-15', url: 'https://example.com/doc5' },
  { index: 6, title: '电力现货市场101问.pdf', owner: '朱剑飞', date: '2025-09-23', url: 'https://example.com/doc6' },
  { index: 7, title: '试卷题库（精选V2 2026.7）.xlsx', owner: '陈浩', date: '2026-07-06', url: 'https://example.com/doc7' },
  { index: 8, title: '2025.11.15 从电网运行到电力市场.pdf', owner: '黄蓉', date: '2025-11-17', url: 'https://example.com/doc8' },
  { index: 9, title: 'IT专业术语-全部词条', owner: '孙以龙', date: '2025-09-09', url: 'https://example.com/doc9' },
];

const MOCK_SOURCES = [
  { title: '清分单分析', url: 'https://example.com/s1' },
  { title: '发电侧清分单校核', url: 'https://example.com/s2' },
  { title: '文字记录：发售电平台0806迭代scope评审会', url: 'https://example.com/s3' },
];

module.exports = { MOCK_ANSWER, MOCK_REFERENCES, MOCK_SOURCES };
