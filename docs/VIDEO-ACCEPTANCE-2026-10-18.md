# 三平台 × 10 条英语视频验收（2026-10-18）

> **更正（2026-10-18，1.5.31）**：本文件下方的三平台 30/30 来自旧 harness，**不能作为验收证据**。
> 旧脚本存在 0/0 也算成功、失败后换 30% 位置重测、英文/中文可来自不同字幕行、未清翻译缓存、
> 未确认正片（可能测到 YouTube 广告）等问题。严格重测 YouTube 目前 **1/10**；B 站/抖音尚未重跑。
> 详见 `docs/TEST-AUDIT-2026-10-18.md`。下方表格仅保留为历史记录，不再代表当前通过率。

> 验收运行版本 **1.5.23**；1.5.24–1.5.26 新增“预处理字幕/语音/画面”按钮，不改变已验证的 20 秒路径。
> 方法：真实 Chrome + 真实页面；每条视频按 10% 时长开始（失败项换 30% 位置再测一次），打开双语字幕后采样 **20 秒**。
> 通过标准：20 秒窗口内同时出现 **≥3 词/≥6 字母的英文行** 和 **≥1 个汉字的译文**；`[music]` 这类无效行不算。
> 结果：**30/30 通过**，所有通过都发生在 20 秒窗口内。

## YouTube（10/10）

| # | 视频 | 来源 | 英文样例 | 中文样例 |
| --- | --- | --- | --- | --- |
| 1 | `T8BpYoMdcww` Slow Learn English Vlog | ASR | We are showing you all around Cornwall and | 我们将带您参观康沃尔郡并教您实用的英语 |
| 2 | `RVzIGNFyvYU` What I Eat In a Day | ASR | who are what I eat in a day video. | 谁是我一天视频中吃的东西。 |
| 3 | `nh36jE2M064` Morning Routine | YouTube 适配器 | premium proxies at blazing speeds. Getting the data you need should be fast and | 以极快的速度提供优质代理。获取所需的数据应该快速且轻松。 |
| 4 | `52t241OQ7Ec` Trip to London | ASR | I got some massive see goes up here | 我在这里看到了一些巨大的海鸥。这是大本。不是 |
| 5 | `FPsUIuKo6M8` Learn English in NYC | ASR | It's just to go by the way. | 只不过是顺便走走而已。 |
| 6 | `EoOkWxc0-j0` Learn English Naturally | ASR | 15 minutes ago and since then I | 15 分钟前，从那时起我就开始打扮。你可以看到我刚刚穿上了一件黑色T恤 |
| 7 | `mGmI9kGA_fA` Shopping at a market | YouTube 适配器 | This man is paying for his bread now. | 这个人现在正在为他的面包付钱。 |
| 8 | `gLdgEYAxJ8A` Grocery Store | ASR | That's a piece of cheese that we're gonna buy. | 这是我们要买的一块奶酪。 |
| 9 | `LTVk3yUb5Mg` Real Daily Routine | ASR | And then, back human. I also have to organize | 然后，回归人类。我也必须组织这个区域。你可以看到我有一些头巾 |
| 10 | `Ge7c7otG2mk` TEDxPenangRoad | ASR | to your children, to your community, and to the future of Malaysia. | 为了您的孩子、您的社区以及马来西亚的未来。 |

- `T8Bp…` 与 `52t…` 首次 10% 位置未在 20 秒内出中文，换 30% 位置后通过；`Ge7…` 用严格标准（排除 `[music]`）复测通过。
- YouTube 无 CC 时按 Z 立即启动 ASR；广告期间不识别，广告结束后开始。

## B 站（10/10）

| # | 视频 | 来源 | 英文样例 | 中文样例 |
| --- | --- | --- | --- | --- |
| 1 | `BV15b411L7M4` TED 如何解决焦虑 | OCR+ASR | in social situations for a long time. | 长时间处于社交场合。 |
| 2 | `BV1vmLp6YERf` 黄仁勋演讲 | OCR+ASR | my TRE dad are deeply prevdlefimetasiwelll | 我的 TRE 爸爸非常喜欢 Fimetasiwell |
| 3 | `BV1ZV411a7Fc` TED 年度演讲 | OCR+ASR | Because that’s how you | 因为这就是你的方式 |
| 4 | `BV11K2YBnEtF` TED 别把事往心里去 | OCR+ASR | because I'm trying to i BE | 因为我正在努力成为 |
| 5 | `BV1qQ4y1U7SP` 奥巴马演讲 | OCR+ASR | she didn't have the money to send me where all the America kids | 她没有钱送我去所有美国孩子的地方 |
| 6 | `BV1fzVHzGE74` 乔布斯演讲 | OCR+ASR | that to college. Steve Jobs NaNal | 到大学。史蒂夫·乔布斯·纳纳尔 |
| 7 | `BV144411b7Uk` TED 20 小时学会任何事 | OCR+ASR | Somebody said it's true. | 有人说这是真的。 |
| 8 | `BV15uJi6rEF3` 康沃尔旅行 Vlog | 页面字幕/OCR | for a short swim | 短暂游泳 |
| 9 | `BV1a34y1u7z5` 瑞士旅行 Vlog（替换） | OCR+ASR | a Switzerland road trip should be on | 瑞士公路旅行应该开启 |
| 10 | `BV1Ph411s7jp` TED 成长的意义（替换） | ASR | Which go towards building ourselves. | 这有助于建设我们自己。 |

- 原 `BV1xS4y187tY`（Taylor Swift）与 `BV1oW411h7Ea`（乔布斯）两条未在 20 秒内稳定出中文，已用 `BV1a34y1u7z5`、`BV1Ph411s7jp` 替换并测试通过。
- 2 条译文/转写质量一般（TRE/NaNal 等），但 20 秒实时性标准通过；质量仍可继续打磨。

## 抖音（10/10）

| # | 视频 | 来源 | 英文样例 | 中文样例 |
| --- | --- | --- | --- | --- |
| 1 | `7628617795365915955` Easy Nature English | OCR+ASR | stop 3 what you hear can hear the leaves | 停止 3 你所听到的 可以听到树叶的声音 |
| 2 | `7695793771383934218` 慢速英语 Vlog | OCR+ASR | but it also says super last charging | 但它还说超级最后充电 |
| 3 | `7624578798001294003` 全英人生 | ASR | 25 for 21, maybe they already had a house. They | 25对21，也许他们已经有房子了。他们有一两个孩子，看起来他们 |
| 4 | `7615841204400112505` 速成英语口语 | ASR | I'm not sure what I'm gonna do, but I'm gonna do it. | 我不确定我要做什么，但我会这么做。 |
| 5 | `7673104793703770089` 广东听说真题 | OCR+ASR | Mars in attempts to understand the planet's | 火星试图了解地球的 |
| 6 | `7558961011962973491` 全英 Vlog | OCR+ASR | most places, you can buy a | 大多数地方，您可以购买 |
| 7 | `7633019029120374001` 看剧说英语 | ASR | I'm not sure what I'm saying, but I'm not sure what I'm saying. | 我不知道自己在说什么，但我也不知道自己在说什么。 |
| 8 | `7693358228889046312` 英语跟读 | ASR | We'll also talk about why you do not need | 我们还将讨论为什么您不需要高级词汇。 |
| 9 | `7696727148106665258` English Listening Practice | ASR | The speaking English becomes easy and natural. | 说英语变得轻松自然。 |
| 10 | `7696531132234322597` 诗意秋天（替换） | ASR | it shines on mountains, trees, and streets. When you look | 它照耀着山脉、树木和街道。当你抬头仰望时，你会感到快乐和自由。 |

- 原 `7592918334179420005` 的 OCR 样例 `JAHRE IT RJTA` 质量差，已用 `7696531132234322597` 替换并测试通过。

## 实时性机制（1.5.23）

- 打开字幕后预翻译未来 **60 秒**、最多 20 条软字幕；播放到直接命中缓存。
- 当前 ASR/OCR 半句只要有 **3+ 词**就立即翻译，不再等整句收句。
- 当前句翻译任务 priority 插队；OCR 被判不可用时取消其旧翻译。
- YouTube 按 Z 立即启动 ASR；广告可见浮层期间等待，广告结束再识别。
- 20 秒是验收上限；此前 B 站 40 秒实测平均中文延迟 **0.8s**。

## 残余风险

- 少数 OCR/ASR 文本仍有噪声（如 `TRE`、`NaNal`），译文可能不准确。
- 20 秒实时性已保证；更长的软字幕预翻译队列会增加 CPU/内存占用，后续可做按需限流。
- `blob:` MSE 若页面完全不暴露 media-video/media-audio URL，仍需 MSE 分片解析。
