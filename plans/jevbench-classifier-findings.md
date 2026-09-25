# JevBench findings and implications for the permission classifier

## Sources and scope

- Leaderboard: https://benchmarkheaven.com/jev-models
- Inspected results artifact: https://benchmarkheaven.com/api/jevbench/v1.2
- Artifact revision: `v1.2.10`, protocol `jevbench::v1.2`, generated `2026-09-21T10:28:35+00:00`.
- Harness: https://github.com/fstandhartinger/jevbench
- SemIf: https://github.com/TheoLeeCJ/SemIf (default branch `master`).
- SemIf Apple runtime: https://github.com/TheoLeeCJ/SemIf/blob/master/docs/MLX.md

Source/artifact inspection only. No model installation or benchmark execution. These are third-party results for specific configurations, not measured performance or permission false-approval rates on the user's M4 Max / RTX 5080.

Related research: [Laya](laya-local-classifier-findings.md), [OpenDecision](opendecision-classifier-findings.md), [DeBERTa](deberta-local-classifier-comparison.md).

## Benchmark design

42 listed systems, 534 decisions for a full run:

- 72 easy
- 96 standard
- 146 judge
- 220 hard (111 public, 109 held out)

Hard families include long multi-condition policies (38 items, described as 2–6k-token documents), adversarial inputs, ambiguity, traps, routing, multi-hop lookup, and temporal/numeric tasks. Hard cases were model-authored and cross-reviewed by another model, frozen before measured answers; they are not an all-human-labeled security validation set.

The published composite is the geometric mean of four equally weighted axes: Intelligence, Calibration, Speed, Cost.

- Intelligence is tier-weighted accuracy: easy 14%, standard 28%, judge 28%, hard 30%.
- Calibration combines hard-tier top-label ECE (10 bins) with distribution fidelity on 20 exact-probability items. It is not accuracy, per-class safety precision, or an approval guarantee.
- Speed uses standard+judge serial p50/p95, includes network time, and adjusts self-host/demo times by x2, plus 0.15s on their own servers. These adjustments are assumptions, not additional measurements.
- Cost estimates for local models use hosted-provider tariffs; they are not measured electricity, VRAM, or marginal cost on hardware already owned.
- Public-benchmark-directed development is permitted and disclosed; held-out means not publicly released, not guaranteed never exposed to a hosted provider.

For our decision layer, false approvals should not be traded against cost in a generic equal-weight score. Native hardware latency, peak memory, selective-risk/coverage, and asymmetric error costs should determine selection.

## Relevant published results

| Tested system | Intelligence axis /100 | Hard accuracy (220) | Long-policy correct (38) |
| --- | ---: | ---: | ---: |
| Laya English checkpoint | 63.2 | 34.1% | 12/38 (31.6%) |
| OpenDecision / MoritzLaurer ModernBERT | 59.6 | 33.2% | 11/38 (28.9%) |
| openJev Verdict 1.4 / 151M | 58.1 | 37.7% | 11/38 (28.9%) |
| SemIf / frozen Qwen3.5-4B BF16 | 85.9 | 59.5% | 16/38 (42.1%) |
| reflex 4B / Qwen3.5-4B + LoRA | 86.7 | 63.2% | 20/38 (52.6%) |
| GPT-5.6 Luna, low reasoning (hosted reference) | 96.8 | 94.5% | 36/38 (94.7%) |

Small subgroups are diagnostic, not robust universal rankings. SemIf's 16/38 vs reflex's 20/38 should not be called a proven general superiority. Laya and OpenDecision each got 2/14 ambiguous items correct in this run; this motivates testing abstention and missing-context behavior in our own fixtures, not declaring a measured permission violation rate.

Verdict 1.4 ranks fourth overall because of the combined efficiency/calibration/cost score, despite an Intelligence axis of 58.1. Its ranking does not imply it is more accurate than the larger models. The same caution applies to all aggregate positions.

## Essential configuration caveats

- Laya ran on a Ryzen CPU through its own package with a 512-token budget; the benchmark explicitly notes package-side truncation of long hard states. Its accuracy is a result of the model AND input path; the benchmark does not isolate how much loss is truncation vs reasoning.
- OpenDecision ran on an H100 GPU after the CPU path proved too slow. Its reported logical input-token count does not account for repeated candidate/formulation passes.
- Do not compare those two speed columns as if they were both measured on the 5080.
- SemIf ran on a remote RTX PRO 4500 Blackwell, reflex on an H100 in Canada, and hosted baselines on provider infrastructure. The leaderboard does not measure our local Unix-socket workflow.
- `open-jev-deberta-v3-large` is the Kotoba Labs / `com-kotobalabs/open-jev-deberta-v3-large` decision checkpoint, NOT `MoritzLaurer/deberta-v3-large-zeroshot-v2.0`. Its adapter notes a 256-token state limit. Do not attribute that score to the earlier MoritzLaurer candidate.
- The table does not establish a result for `tasksource/ModernBERT-large-nli` or its base sibling.
- The benchmark's kev rows refer to pinned older 0.5B/0.6B/4B/8B configurations; current repository documentation advertises a different lineup. Do not transfer benchmark results to current releases without matching checkpoint/runtime versions.
- reflex discloses using public JevBench items as a development gate; interpret its held-out results and published score with that provenance in view.

## What this changes

This evidence is more task-relevant than generic sentiment/NLI model-card comparisons. It weakens the case for selecting Laya or OpenDecision as a full replacement based mainly on small size, typed output, or general zero-shot benchmarks.

It does NOT rule out compact, narrowly scoped fast-path review with conservative abstention. A paired full-context vs compact-context experiment is still required to determine whether our code-owned representation preserves decision quality. Arbitrary truncation and a deliberately complete compact representation are not equivalent.

Revised experimental shortlist:

1. **SemIf / Qwen3.5-4B** as a stronger local decision-quality baseline, if the user is willing to consider a larger decoder-based architecture used without generation.
2. **tasksource/ModernBERT-large-nli or base-nli** as the English 2k encoder baseline, still unmeasured by this board.
3. **Laya** as a small-input specialist/fast-path candidate rather than assumed general permission reviewer.
4. **Verdict 1.4** optionally as a very small calibrated-score baseline; ranking alone is not a reason to select it.

Retain the existing stronger LLM or human route for uncertain/unsupported cases; a local-only configuration must escalate to humans rather than silently introduce a remote model.

## Why SemIf is worth a separate investigation

SemIf uses a frozen Qwen3.5-4B and reads option logits directly. It does not generate prose/JSON or run a decoding loop for each verdict. This provides an alternative to both encoder NLI and normal generative classification.

Upstream documents:

- Torch/CUDA path.
- Native Apple Silicon MLX path for direct, serial-prefix, and shared-state scoring.
- Immutable model revision pinning and input limits enforced without truncation.
- MLX 4-/8-bit quantization options, with warnings that probabilities/choices can change and need separate evaluation.
- A pinned MLX-LM source version containing a Qwen normalization fix; this is real runtime-specific maintenance, not a trivial dependency-free drop-in.
- Exact-state prefix caches, not permission grants. Our request authority, policy revision, and approval caches must remain independently scoped.

The published full benchmark is the CUDA BF16 configuration, not proof that quantized MLX returns identical decisions. SemIf is also substantially larger than the encoders; do not apply the previous small-Laya memory budget to it.

## Recommended next experiment

Use our actual human-labeled permission fixtures plus selected relevant public JevBench cases. Evaluate:

- full vs compact representations with a fixed model;
- selected models using the same complete compact representation;
- explicit restrictions, missing authorization, option order, negation, injected instructions, compound effects, and long-context overflow;
- false approvals separately from unnecessary human escalations;
- approval precision vs automatic-coverage curves on held-out cases;
- actual M4 Max and 5080 latency, memory, model/runtime versions, and precision.

No implementation, new backend selection, download, or deployment is authorized by this research note.
