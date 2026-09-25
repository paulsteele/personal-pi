# Laya local permission classifier — bookmarked findings

## Status and user direction

Research bookmark, not an approved implementation plan. No runtime/model installation or inference benchmark was performed. The only downloaded package artifact was the small Laya Python wheel, inspected as source without installation or execution.

Target machines:

- Apple M4 Max Mac, native Python/PyTorch with Metal Performance Shaders (MPS).
- Linux machine with NVIDIA RTX 5080 (16 GB VRAM), native Python/PyTorch with CUDA.

The user agreed to set aside a separate plain-ModernBERT/custom-fine-tuning project and continue investigating Laya. They subsequently requested investigation of OpenDecision; that comparison does not itself authorize implementation or deployment. See [OpenDecision investigation](opendecision-classifier-findings.md) for the separate source-backed comparison.

## Model and API

- Model: `convaiinnovations/laya`, Apache 2.0.
- Model revision observed during research: `7c76b622dfc5cac71b2dc1c29873efe2ce509a05`.
- Approximately 421M parameters: a fully fine-tuned ModernBERT-large backbone plus custom decision layers, option scoring, and an act/escalate head.
- Non-autoregressive typed decisions: `choice`, ordinal `score`, and boolean-probability `noul`. Does not generate contextual prose explanations or chat tool calls.
- Python API: `laya.load(local_checkpoint_path, device="mps" | "cuda")`, then `agent.predict(state, questions)`.
- Current input pipeline uses **512 tokens total per question**, including instructions, options, state, and special tokens. It truncates inputs. Options/instructions also have their own limits.
- The included backbone config supports 8,192 positions, but increasing Laya's input budget would require performance, judgment-quality, and calibration evaluation; longer-context behavior is not validated merely by changing a config value.
- For choice/score, the inspected implementation's `confidence` is `1 - normalized entropy`, not a calibrated probability that the verdict is correct. Prefer inspecting `P(allow)` and validating any threshold on the actual permission task.
- Published held-out-family evaluation reports approximately 65.1% accuracy. Published classification/moderation benchmarks do not establish coding-agent authorization safety. Elimination of generated parsing errors does not eliminate wrong approvals.

## Packaged runtime findings (Laya 0.1.6)

Inspected wheel: `laya-0.1.6-py3-none-any.whl`.
SHA-256: `64eda9dcc9cf24a23423f4aff334411dbf8a37f5adce6fa950322c3f2717e3ca`.

- The **PyPI package** automatically selects CUDA, then MPS, then CPU; this is more capable than the Hugging Face reference loader previously inspected, which defaulted to CUDA/CPU.
- Explicit GPU selection can fall back to CPU if unavailable. Model placement and certain inference failures can also trigger CPU fallback.
- Verify and report the actual device after loading and inference. A GPU-required mode should detect fallback rather than silently call it GPU success.
- The package uses FP32 on MPS/CPU and CUDA autocast with BF16/FP16 as applicable.
- Importantly, it constructs the model in default FP32, copies checkpoint weights into it, and calls `.to(device)` without explicitly converting the resident parameters to FP16. Mixed-precision CUDA computation is not equivalent to half-sized permanent parameter storage.
- The loader can modify tokenizer configuration for compatibility; immutable artifact verification and runtime preparation should account for that explicitly.
- `laya.load(remote_model_id)` may download artifacts. For offline operation, explicitly prepare a pinned complete checkpoint during setup, then load the local path with network-dependent fallback disabled/blocked.

## GPU and memory estimates — NOT measured

Assumptions: stock loading path, 512-token inputs, one resident worker, serial inference or small bounded batches.

| Quantity | Planning estimate |
| --- | --- |
| Downloaded model weights | Approximately 844 MB |
| FP32 parameter storage alone | Approximately 1.57 GiB |
| FP16/BF16 parameter storage alone, if explicitly implemented | Approximately 0.78 GiB |
| RTX 5080 warmed worker VRAM | Roughly 2–4 GiB; reserve about 4 GiB initially |
| M4 Max incremental unified-memory use, including worker/model/buffers | Roughly 3–5 GiB |

Additional allocations include activations, attention/workspace buffers, device runtime overhead, cached allocator blocks, and CUDA autocast weight copies. Python and native libraries also consume system RAM. macOS uses unified memory, not a separate VRAM pool; do not add overlapping GPU/process memory metrics as if they were independent allocations.

A resident worker holds memory while idle. PyTorch may retain a high-water allocation even after a request finishes. Terminating the worker releases its GPU allocations; the next start pays a cold-load cost.

Multiple clients should share one worker/model, not spawn one copy per Pi session or PR worker. Bound concurrent inference/batching to control peak memory. Explicit low-precision parameter storage is a possible optimization, not a tested drop-in flag; validate the whole inference path and probability changes on each backend.

Measure cold startup peak, post-warmup idle allocations, active-inference peak, concurrent-request peak, and wall-clock latency on both machines. The model publisher's ~38.4 ms median GPU number is not a measurement for either target machine.

## Extension-managed installation and lifecycle proposal

Feasible using existing Pi extension commands, UI, filesystem/subprocess access, and lifecycle events; no Pi core change is inherently required.

Proposed experience (commands do not currently exist):

- `/auto-local setup`: explicit consent, platform detection, downloads, isolated environment, checkpoint preparation, real GPU inference smoke test, activation.
- `/auto-local status`, `start`, `stop`, `doctor`, `update`, `uninstall`.

Proposed runtime design:

1. Small extension-owned `uv` bootstrap with pinned/hash-verified artifacts.
2. Managed native Python and a pinned per-platform environment, outside the repository and system Python.
3. macOS ARM64 PyTorch/MPS; Linux Blackwell-compatible PyTorch with CUDA 12.8+ and a compatible installed NVIDIA driver.
4. Native Python worker on both platforms, rather than Docker or separate MLX/ONNX ports initially.
5. One on-demand per-user worker, private local socket, startup lock, verified runtime/checkpoint/protocol identity, bounded inference queue, client leases and idle shutdown.
6. Stage and smoke-test updates before activation; keep the previous working runtime on failure.

System prerequisites remain the user's responsibility: supported macOS/Metal access or a working NVIDIA driver. Prebuilt PyTorch packages supply CUDA runtime dependencies; a separate CUDA developer toolkit is normally unnecessary for this path. No `sudo`, global Python changes, or shell-profile modifications should be needed for the managed user-space installation. Total disk use can be several GB, especially with CUDA dependencies and update staging.

Do not start background resources in the extension factory. Start/attach from `session_start` or the command that needs the worker; cancel requests/detach on `session_shutdown`, which also covers reload/session replacement. A separately supervised shared worker may survive client reloads and exit on idle. Optional launchd/systemd user services can be added later, with explicit consent.

Installation is trusted host code, not an ordinary agent Bash call: provide its own explicit consent and cancellation. No hidden installs during npm installation or ordinary permission review. Avoid inheriting unrelated credentials/project Python configuration. Keep inference input out of operational logs. Do not introduce automatic cloud fallback without an explicit choice.

## Permission integration constraints

Current integration points:

- `pi-permission-system/src/auto/classifier.ts`: LLM prompt and structured-tool-verdict implementation.
- `pi-permission-system/src/permission-system.ts`: model registry selection, review context, caching/events.
- `pi-permission-system/src/tool-review.ts`: shared deterministic policy/guard/model/human routing.
- `pi-permission-system/src/config.ts` and schema: backend configuration would need deliberate extension.

Laya needs an adapter, not just a new `/auto-model` model name. Preserve explicit denies, human-only safety guards, cancellation, stale-policy/context checks, main/worker turn-local cache isolation, one-shot human decisions, and headless blocking. Share inference infrastructure, not authorization state or cached approvals across clients.

The present prompt can exceed Laya's budget; authoritative user instructions appear late in it. Never feed it unchanged and permit silent truncation to remove authority/restrictions. Build compact code-owned facts, count actual tokens, preserve complete relevant effects, and escalate when safety-relevant context cannot fit. Do not independently approve fragments of a compound command as a substitute for judging combined effects.

Suggested rollout: shadow mode first, then only validated small-input fast-path approvals; unsupported/uncertain/oversized cases go to the existing LLM or directly to a human if local-only operation is selected. Lack of free-form reasons means honest code-owned escalation messages or validated categorical reasons, not invented explanations.

## Sources

- Model card: https://huggingface.co/convaiinnovations/laya
- Reference API: https://huggingface.co/convaiinnovations/laya/blob/main/rl_agent_api.py
- Sequence construction/confidence: https://huggingface.co/convaiinnovations/laya/blob/main/rl_common.py
- Encoder config: https://huggingface.co/convaiinnovations/laya/blob/main/encoder/config.json
- Published evaluation: https://huggingface.co/convaiinnovations/laya/blob/main/eval/results.md
- Packaged runtime: https://pypi.org/project/laya/0.1.6/
- Wheel metadata: https://pypi.org/pypi/laya/0.1.6/json
- uv managed Python: https://docs.astral.sh/uv/concepts/python-versions/
- uv/PyTorch integration: https://docs.astral.sh/uv/guides/integration/pytorch/
- PyTorch Blackwell support: https://discuss.pytorch.org/t/5070-ti-and-5080-support/224825
- CUDA runtime vs driver/toolkit: https://discuss.pytorch.org/t/how-do-i-get-started-with-cuda-and-pytorch/223816

Also inspected the installed Pi `docs/extensions.md`, `docs/packages.md`, `docs/models.md`, `docs/tui.md`, and relevant lifecycle examples. These findings do not imply the proposed commands or worker already exist.
