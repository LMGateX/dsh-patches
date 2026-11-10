# 0002 — 复用有内部来源证明的不可变持久化事件（实验性）

**状态：最终差异复核、隔离红绿回归、本地安装及安装后34项兼容回归已通过；长期线上效果仍待验证。** 提供[受哈希保护的双文件应用/回滚工具](apply.py)，工具不会停止或重启DSH。

适用版本：DSH、dsh-session、dsh-session-persistence-jsonl 0.2.2-rc.1；已测试Node24.12.0。完整原始/输出SHA-256见[manifest.json](manifest.json)，43行、两个模块的生产差异见[fix.patch](fix.patch)。

## 修复什么

Session.append及插件记录路径已经先复制JSON对象结构、再冻结新构造的完整事件。持久化入队再次structuredClone会复制大字符串载荷。本候选在Session内部用私有WeakSet记录实际由这两条路径构造的事件，仅对身份命中的事件复用已有不可变图。

- 只读来源查询不提供标记能力；WeakSet不会强引用事件。
- 普通输入、调用方手动冻结的对象、代理、恢复种子及其他模块副本生成的事件都保持原有structuredClone行为。
- 标记仅发生在新事件完成JSON快照、冻结和验证之后、commit发布之前；不从任意commit、恢复或公有辅助函数标记。
- 标记前还要求事件type为原始字符串、seq/time为非负安全整数且不是负零。
- 写入批次的materializeAppendBatch、顺序检查、失败重排队和存储格式不改变。
- 写入端对来源查询使用可选调用：只更新一侧时保守回退原克隆。这是混合版本的兼容保险，不是只部署一侧的建议。

## 为什么不只检查冻结与原型

初版研究候选可被改过prototype的Date、Map、装箱值等内置对象绕过，改变原有拒绝行为，因此已撤回，未部署。本目录只包含替代它的来源标记方案，不使用不完整的内置类型黑名单。

## 隔离验证

从本目录运行：

~~~sh
# 在两个模块均为原始版本时，预览准确生产差异，并验证基线红/候选绿。
# 不会修改任何安装文件。
env -u NODE_OPTIONS node --max-old-space-size=128 regression.mjs --preview

# 部署两个模块后检查磁盘上实际安装的实现；修改磁盘仍不等于已更新运行中DSH。
env -u NODE_OPTIONS node --max-old-space-size=128 regression.mjs
~~~

默认通过npm root -g定位DSH；非全局安装可用DSH_ROOT指定DSH包根目录。无需额外安装依赖。

[regression.mjs](regression.mjs)先核对包版本和两份完整源文件哈希，将[fix.patch](fix.patch)准确应用到内存字符串，并确认输出哈希及[预览变换](preview-transform.mjs)完全一致。之后顺序启动限额子进程：

- 真实Session.create及appendPluginRecord生成4MiB事件，使用实际持久化写入类的enqueueLive、drainLive、materializeAppendBatch和persistContiguous；只有存储写入为可延迟mock。
- 两组内存红绿重复：基线额外保留约4MiB；候选入队约5.7KiB、延迟写入期间约15.3KiB。
- 基线33项、完整候选34项、只更新写入端33项、只更新Session33项兼容测试全部通过。
- 包含可变输入所有权、getter次数、代理零陷阱、改原型内置对象、负零时间、实际来源事件、普通冻结对象回退、延迟失败重排队及顺序JSON读回。

具体数字与解释见[RESULTS.md](RESULTS.md)。GC仅在带--expose-gc的隔离内存子进程内调用，不对运行中DSH求值、采样操作或强制GC。

## 应用与回滚

从本目录执行，先停止相关任务；不要在两文件替换期间启动新的DSH进程：

~~~sh
DSH_ROOT="$(npm root -g)/@deepseek-ai/dsh"
python3 apply.py --root "$DSH_ROOT"             # 只读检查
sudo python3 apply.py --root "$DSH_ROOT" --apply
# 如需回滚，只回滚0002，不影响0001：
sudo python3 apply.py --root "$DSH_ROOT" --rollback
~~~

应用器校验根包/依赖包名称、版本、完整源文件哈希、精确上下文与输出哈希；提前备份原件并暂存两文件，保留权限及属主。逐文件替换是原子的，但不是跨文件同时提交；失败时尝试还原本次已替换文件，若提示回滚不完整，先检查状态，不要启动服务。发现混合或未知哈希即拒绝修改。

备份保存在DSH包根目录的.local-patch-backups/0002-immutable-live-events中。已在一次性安装副本验证应用、重复应用、回滚、第二文件替换故障恢复及未知源文件拒绝。

## 部署方案与限制

1. 先暂停父会话、子Agent及相关独立后台任务；不要为了等待候选整理而消耗最后的内存余量。
2. 核对两个包版本及原始SHA-256，保留当前其他补丁，不强行覆盖升级或其他修改。
3. 备份两份原文件。43行差异必须作为同一个部署单元审查；精确上下文或哈希不匹配即停止。
4. 维护者在暂停后实施两文件替换，检查两个输出SHA-256；任一失败回滚，禁止半成品继续运行。
5. 正常重启DSH。修改磁盘不会替换当前进程已加载的模块，也不会立即释放已有分配。
6. 先在空会话和合成回归上确认，再逐步恢复目标工作负载并观察内存、持久化错误与重排队。

这不是删除历史、放宽JSON验证、限制所有缓存或清理现有队列的补丁。它减少一个确定的冗余复制来源，不能承诺所有OOM或活跃原始历史增长均消失，也没有证明线上队列已经发生积压。

不混入尚未覆盖带AbortSignal查询的冷加载单飞实验。仓库只保留通用差异与合成测试，真实诊断资料不在本目录。
