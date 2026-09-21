# Reflex 4B 本机启动测试记录

测试日期：2026-09-22。结论：本次没有完成真实推理，不能报告延迟或判断质量。原版 float16 4B 权重已超过这台机器的默认 MPS 分配预算，不适合作为即开即用的本地服务。

## 实测环境

| 项目 | 值 |
| --- | --- |
| 设备 | Apple M4，16 GiB 统一内存 |
| Python | 3.12.14 |
| PyTorch / Transformers | 2.14.0 / 5.17.0 |
| MPS | 实测可用 |
| `torch.mps.recommended_max_memory()` | 11,453,251,584 字节 |
| Reflex 默认 high watermark | 0.7；约 8.02 GB 分配预算 |
| Qwen3.5-4B 权重索引 `total_size` | 9,319,737,856 字节（9.32 GB），尚未计入推理缓存 |

运行环境和模型下载缓存放在外置盘的 `output/reflex-runtime/`。使用独立的测试环境，未修改用户快速判断配置；快速判断仍默认关闭。

## 实际执行与结果

1. 拉取上游 `stable`，commit 为 `19586a1374dca138eddf5d7b8889cae8dfa505f6`。发现该版本还没有 README 中介绍的 MPS 支持模块。
2. 改用包含 Mac 支持的上游 commit `e21b3b23afdfeee7021a6604fa38f57e7ff5187f`，成功执行 `uv sync --no-sources`，安装真实推理依赖。
3. 启动真实 Reflex 服务，参数为 `--stable --model Qwen/Qwen3.5-4B --device mps --dtype float16 --port 8008`。模型 revision 为 `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`。
4. 启动进入权重下载阶段，Hugging Face Xet CAS 通道报请求错误，进程退出。
5. 设置 `HF_HUB_DISABLE_XET=1` 后重试，普通 HTTP 下载有进展。考虑到权重本身已超出默认 MPS 预算，主动停止下载和进程，没有提高内存上限。

**没有实际观察到模型加载 OOM**：模型尚未下载完整。内存不匹配的判断来自实际设备返回值、上游默认内存保护参数和该模型权重索引，而不是一次完成的模型加载实验。

也没有运行真实模型连接测试、上下文裁剪推理或性能基准。此前通过的回归测试验证的是接口、配置和回退行为，不能当作本机 4B 性能结果。

本机原始记录位于 `output/reflex-benchmark/environment-result.json`、`4b-startup.log` 和 `4b-startup-http.log`；这些本地测试产物不随产品发布。

## 对接入的影响

- 保持快速判断默认关闭；默认选中 Reflex 4B 不表示已经下载、启动或启用它。
- 已修正 Apple Silicon 启动文档，明确使用包含 MPS 支持的代码版本。
- 要在这台机器上验证实用速度，需要另行实现／验证适合的量化后端，或选择更小的模型。它们不能冒充本次原版 4B 的测试成绩。

参考：[Reflex 源码](https://github.com/kshetrajna12/reflex/tree/e21b3b23afdfeee7021a6604fa38f57e7ff5187f)、[MPS 内存保护](https://github.com/kshetrajna12/reflex/blob/e21b3b23afdfeee7021a6604fa38f57e7ff5187f/src/reflex/mps.py)、[Qwen3.5-4B 权重索引](https://huggingface.co/Qwen/Qwen3.5-4B/blob/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/model.safetensors.index.json)。
