# 立体声宽度兼容约定（去相关 · 声道归一 · 单声道折叠）

本文件是宽度处理链的**行为契约**：它描述代码实际做了什么，而不是希望它做什么。
文中所有形如 `[%tag%] 数值` 的数字都由 `test/maintenance-check.mjs` 对照生产 DSP
重新计算；若文档与实现漂移，检查失败。样例音频见 `doc/samples/`，可执行、可复核。

> 图形入口是本仓库的主界面（`node server.js` → `http://127.0.0.1:8770/`）。
> 命令行（`npm test`、`test/*.mjs`）只是辅助复核，**不是**宽度处理的主入口。

## 1. 预设参数（与 `web/js/config.js` 一致）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `width` | 1.25 | M/S 侧声增益，0=单声，1=原样，上限 2.5 |
| `structure` | `ap` | 去相关结构：`ms`/`ap`/`delay`/`haas` |
| `decorr` | 0.32 | 去相关湿声量 0–1 |
| `delayMs` | 6 | 短延迟结构延迟（ms） |
| `haasMs` | 9 | Haas 结构非对称延迟（ms） |
| `stageMode` | `crossover` | `preserve`/`widen`/`crossover` |
| `crossover` | true | 是否启用 LR4 分频 |
| `fc` | 180 | 分频点（Hz），UI 范围 80–800 |
| `lowMode` | `auto` | `auto`/`center`/`rescue`/`preserve` |
| `broadcast` | `auto` | `auto`/`direct_mid`/`fold_stage`/`phase_safe` |
| `autoProtect` | true | 反相低频时自动改走救援/相位安全 |
| `centerLock` | true | 去相关发送对 M 正交，锁定声像中心 |
| `foldPolarity` | `plain` | 监听折叠：`plain`=(L+R)/2；`auto`=先纠正反相信道 |

`test/verify-width-package.mjs` 的 `defaults` 项逐字段核对上表。

## 2. 去相关结构契约

每种结构对**单声道折叠**的承诺不同，实现由 `web/js/dsp/contract.js` 的
`DECORRELATOR_CONTRACT` 声明，并由脉冲响应实测复核。

| 结构 | 折叠是否 = M | 引入延迟 | 风险 | 说明 |
| --- | --- | --- | --- | --- |
| `ms` | 是 | 否 | 无 | S′=width·S，折叠严格 = 2M；对纯单声道不产生侧声 |
| `ap` | 是 | 否 | 低 | 幅度平坦、相位色散；正交发送保持左右平衡 |
| `delay` | 是 | 是 | 中 | 侧声内容被整数延迟搬移，折叠仍 = M |
| `haas` | **否** | 是 | **高** | 只在右声道加延迟回声，折叠出现真实梳状染色与能量偏置 |

全通链脉冲实测：幅度最大偏差 `[%ap-max-dev-db%] 0` dB，相位行程
`[%ap-phase-span-rad%] 31.89` rad。短延迟命令与实测峰一致：
`[%delay-command-samples%] 288` 采样（6 ms @48 kHz）。
`samples-regen` 与 `fold-coherence` 两项在净目录复算这些值。

## 3. 声道归一与双口径功率

实现里有两个**互不等价**的功率口径，文档和测试都不得混用：

1. **各声道功率相等**：`E_L ≈ E_R`（源左右平衡被保持）。
2. **合并后声能相等**：`E_fold == E_M`（单声道折叠保住中轨能量）。

- 对称拓扑（`ms`/`ap`/`delay`）下二者可同时成立：折叠 = M，偏差
  `[%symmetric-fold-mid-delta-db%] 0` dB，且 `E_L ≈ E_R`。
- 非对称 `haas` 下口径 1 会被故意打破：左右平衡
  `[%haas-balance-db%] -2.66` dB。此时只有口径 2 仍可用来判断单声道是否安全。

`test/verify-width-package.mjs` 的 `power-accounts` 项与自检
`dual_power_accounts` 同时断言"两口径分离"，防止把某一读数当成普遍结论。

## 4. 极性复核

监听折叠可读取随工程保存的侧声策略（`foldPolarity`）：

- `plain`：标准 `(L+R)/2`，反相信道会完全抵消。
- `auto`：先按总相关符号纠正反相信道再折叠，能量得以回收。

样例 `doc/samples/sample-phase-antiphase-80hz.wav` 为 80 Hz 左右完全反相的立体声：
标准折叠比单声道电平低 `[%phase-delta-vs-channel-db%] -110.97` dB（即完全抵消），
而 `auto` 折叠可回收约 109 dB。用该文件在面板里听/看折叠即可复核。

## 5. 频率样例与抵消风险位置

`doc/samples/sample-band-split-180hz.wav`：低频反相、高频同相。以 180 Hz 分频测量：

- 低带相关 `[%band-low-rho%] -1`（反相）→ 低带在标准折叠中抵消。
- 高带相关 `[%band-high-rho%] 0.9994`（同相）→ 高带保持。

结论：**抵消风险只落在分频点以下**。这与 `lowMode` 的语义一致，也是为什么分频
处理要把低频居中或按能量救援。

## 6. 哪些设置有抵消风险

| 设置 | 风险 | 依据 |
| --- | --- | --- |
| `lowMode=preserve` + 反相低频 | **高**：低带完全抵消 | `antiPhaseFold` 实测最差带 `[%antiphase-worst-retention-db%] -27.42` dB |
| `lowMode=center` + 反相低频 | 低：低频被居中，保留近满 | `[%center-worst-retention-db%] -0.97` dB |
| `structure=haas`（任何低频策略） | 高：折叠梳状 + 能量偏置 | 见第 2 节与 `width-not-quality` |
| `structure=ap/delay`（低频居中） | 低：折叠 = M | 对称结构精确保持 |

**宽度增大 ≠ 质量改善。** 以非对称结构对比 width 1.0 → 2.2：侧声相关从
0.4752 降到 -0.1011（确实更"宽"），但最差带折叠保留从 -9.06 dB 变为 -9.66 dB、
HF 梳状仍在 3.7 dB 量级——更宽伴随折叠与梳状代价。文档与 UI 均不得把"更宽"
单独表述为改进；`width-not-quality` 项会复核这一结论。

## 7. 低频截止点与"改扩宽频带不抹掉居中低音"

分频点 `fc` 只移动**高频扩宽带**的下边界；低频居中策略下，改动 `fc` 或宽度不应
把居中的低音拖垮。净目录检查 `bandwidth-no-erase` 实测：fc=180/300、width=1.6/2.2
时 sub/bass 带保留均 > -0.1 dB，证明扩宽频带变化不会意外抹掉原居中低音。

建议导出时同时产出**双声道舞台版**与**折叠版**，并在折叠版上确认低音仍在。

## 8. 失真频带回传宽度自动化

`measureRender` 按固定子带（sub/bass/lowmid/mid/himid/presence/high）计算每个子带
相对单声道通道的**折叠保留量**，取最差带写入 `measurements.distortedBand`，并由
`widthAutomation.distortedBand` 与 `suggestion` 回传给宽度自动化。自动化据此在
该频带降低宽度/湿声，而不是盲目增大整体宽度。

## 9. 维护与复核方式

| 命令 | 作用 |
| --- | --- |
| `npm test` | 15 项自检（含双口径、极性、相位/频带样例、契约一致性） |
| `node test/verify-width-package.mjs` | **净临时目录**内跑宽度资料校验，输出报告到临时目录 |
| `node test/maintenance-check.mjs` | 契约维护检查：文档引用/样例字节/证据 JSON/折叠相关度 |
| `node test/gen-width-samples.mjs <dir>` | 由生产 DSP 重新生成样例与 `width-evidence.json` |

维护检查覆盖：反相声道、低频、折叠响应与分频相关度；它不依赖手改数据——
所有数值在调用时重新测量。
