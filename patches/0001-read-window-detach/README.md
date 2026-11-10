# 0001 — Detach retained read-window strings

## 问题

原生read工具在文件小于默认10MiB阈值时，先整份解码，再按行切取返回窗口。V8可能用SlicedString表示小片段，使返回行及工具展示元数据仍引用整份源字符串。重复分页读取会使实际保留内存远超返回文本的大小，即使GC后仍存在。

这是读文件窗口的内存保留问题，不需要任何特定项目或真实会话数据即可复现；不是文件内容错误，也不是简单提高堆上限能解决的问题。

## 修复

通过行数、截断和UTF-8字节预算检查后，只对真正返回的行执行UTF-16LE往返复制，解除对完整源字符串的引用。保留原有代码单元，包括截断形成的孤立surrogate；不使用会改变这些边界情况的UTF-8往返。

修改范围仅为发布包中consumeLine函数的两行新增和一个字段替换：[fix.patch](fix.patch)。

## 适用范围

- @deepseek-ai/dsh：0.2.2-rc.1
- @deepseek-ai/dsh-tool-fs：0.2.2-rc.1
- Node：24.12.0已测试
- Python：3.9+（应用工具）
- 应用器还要求[manifest.json](manifest.json)中的完整原文件SHA-256匹配。相同版本但构建内容不同也会拒绝，不会强行覆盖。

## 回归测试

从仓库根目录运行：

    node --expose-gc --max-old-space-size=512 patches/0001-read-window-detach/regression.mjs

测试从npm全局安装目录定位DSH；可通过DSH_ROOT环境变量指定其他安装根目录。它只生成并清理独立临时合成文件，不读取真实项目或会话。

测试使用已安装的实际read工具、LocalFileSystem和工具结果流水线，保留12次单行读取的最终展示元数据。合成文件约9MiB，总返回文本约1.2K字符。原代码在Node24.12.0上GC后约保留108MiB，超过16MiB断言，预期exit1；修复后应通过。内存数值会随V8和平台变化，重点是固定上限断言及语义测试。

同时验证行号、offset/limit、总行数、UTF-8字节预算、中文、emoji、CRLF和surrogate截断边界。

## 检查、应用、回滚

先指定安装根目录（不是本补丁仓库目录）：

    export DSH_ROOT="$(npm root -g)/@deepseek-ai/dsh"
    python3 patches/0001-read-window-detach/apply.py --root "$DSH_ROOT" --check

应用（仅在安装目录需要管理员权限时使用sudo）：

    sudo python3 patches/0001-read-window-detach/apply.py --root "$DSH_ROOT" --apply

然后重新运行回归测试，再正常重启DSH。应用工具不发信号、不附加调试器、不自动重启任何服务。当前进程已加载的旧模块和已经保留的对象不会因为磁盘文件修改立即消失。

回滚：

    sudo python3 patches/0001-read-window-detach/apply.py --root "$DSH_ROOT" --revert

应用前会在安装目录的.local-patch-backups/0001-read-window-detach/下保存原始代码。备份不在本仓库中，也不应提交。

应用器严格检查版本、已知源文件hash、单一精确补丁上下文和输出hash；重复应用是无操作。应用和回滚均使用同目录临时文件原子替换，保留权限；未知文件修改或损坏备份会导致拒绝执行。只对可信安装运行，并在操作期间停止包管理器更新；原子替换不等于可抵御并发更新或断电的多文件事务。

## 维护与限制

本补丁不包含日志恢复并发去重等其他改动，也不承诺所有OOM均由该问题引起。发布包升级可能覆盖补丁；升级后重新检查，不要复用不匹配的hash。生产任务仍需在正常重启后验证。

请勿在公开issue、测试输出或新补丁中添加真实文件、项目名称、session标识、用户路径、heapprofile或诊断报告。
