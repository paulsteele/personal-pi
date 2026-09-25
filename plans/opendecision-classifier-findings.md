# OpenDecision investigation for the local permission classifier

## Scope and status

Source investigation only: no dependency installation, model download, or inference/hardware benchmark. Selected upstream source/docs and saved benchmark artifacts were downloaded to a temporary directory and inspected; upstream code was not executed.

- Repository: https://github.com/deepanwadhwa/OpenDecision
- Inspected revision: `002c9bae8aa30167ec4b9120ed838fdc0e1e7e8e` (release 0.1.1).
- License: Apache 2.0; upstream calls this a developer preview.
- Target: existing Pi permission classifier on Apple M4 Max and Linux/RTX 5080.
- Related bookmark: [Laya local classifier findings](laya-local-classifier-findings.md).

## What it is

OpenDecision is a Python decision/orchestration library and FastAPI server over existing NLI/zero-shot classification models, rather than a new custom-trained decision checkpoint like Laya.

Default backend: `MoritzLaurer/ModernBERT-large-zeroshot-v2.0`.
Observed backend revision: `a51e07b524299e309dd2b88d48b0cfa2bd9ec598`.
The model is already fine-tuned for entailment vs not-entailment; adopting it does not require us to train plain ModernBERT ourselves. This is distinct from the custom-ModernBERT training project previously set aside.

API primitives:

- `Choice`: relative scores over supplied alternatives.
- `Noul`: entailment score, or relative preference between explicit true/false hypotheses.
- `Score`: weighted ordinal level.
- `Relation`: supports, contradicts, unknown, or (binary explicit-opposite backend) conflicted.
- Document processing: chunking, model-based evidence ranking, selected passages, answer composition.
- Optional code-owned evidence/rule composition helpers; these are not substitutes for our existing deterministic permission policy.

## How inference differs from Laya

`engine.choice()` runs two fixed formulations through the SAME zero-shot classifier:

- A: state as premise, criterion descriptions as candidates, question-specific hypothesis template.
- B: state as premise, label+description candidates, generic hypothesis template.
- If winners agree: average the two score distributions.
- If winners disagree: run a third formulation over the two disputed labels, with the question appended to the state. Return the distribution from whichever original formulation won adjudication.

Each candidate is a separate premise/hypothesis sequence in the zero-shot pipeline. Candidates are batched (default batch size 8), but the state is encoded repeatedly. With two verdict options, this is typically four pair evaluations across two classifier invocations, or six across three if adjudication is needed. It is not necessarily six serial GPU forwards, since candidates can share a batch.

Laya instead places all candidate option markers in one question sequence and scores them with its custom head; its API can batch questions. OpenDecision's `/v1/systemone` handler loops over questions sequentially. It should not inherit Laya's published latency claims or be described as sharing one state encoding across all questions.

## Important input-contract findings

### 1. Effective context limits differ by primitive

The default model's architecture config supports 8,192 positions, BUT its published tokenizer config sets `model_max_length: 512`.

- `Choice`, `choice_fast`, and `Score` use the Transformers zero-shot pipeline with no override of tokenizer length. Inspected Transformers 5.17.0 tokenizes with `truncation=ONLY_FIRST` and no explicit `max_length`, so the default tokenizer limit governs these calls.
- The evidence/relation backend explicitly takes `min(model max positions, tokenizer max length)`, hence 512 for the default checkpoint.
- Direct `Noul` helpers explicitly pass `max_length=8192`, producing a different budget from Choice/Relation.
- Document defaults are 384-token chunks and top 4 evidence chunks. Retrieval can select multiple chunks, but concatenating them does not guarantee the downstream primitive sees them all before truncation.

Therefore OpenDecision is NOT an out-of-the-box uniform 8k-context solution to Laya's 512-token constraint. Long-context evaluation and explicit overflow checks remain necessary. The backend model card itself says newer training was planned to better use the 8k window.

### 2. Some formulations omit the `instructions` argument

`choice_fast()` invokes profile B (`premise_mode="state"`, `candidate_mode="label_description"`, `hypothesis_mode="default"`). In that path the method accepts `instructions` but does not insert it into the sequence or hypothesis.

Standard `choice()` uses the instructions in A and the adjudicator, but not B. Explicit-criteria `Noul` directly uses the supplied true/false hypotheses rather than the question text.

This is a verified input-construction behavior, not a measured prediction failure. It matters for a permission adapter: essential authorization semantics cannot live exclusively in an argument ignored by the selected formulation. Do not simply use `choice_fast` with the current security prompt placed in `instructions`.

### 3. Unknown/conflict does not automatically mean abstention in every API

The default backend is binary entailment/not-entailment. `Relation` separately scores a proposition and its explicit opposite; thresholding yields supports/contradicts/unknown/conflicted. A native three-way NLI backend instead chooses entailment/contradiction/neutral by argmax; the supplied threshold is not an approval-confidence gate in that branch.

Document `noul_mode="both"` can return a BOOLEAN answer with `status="tentative"` even when the relation judgment is unknown/conflicted (the relation maps to no answer, then the binary preference is retained). Our adapter must not authorize merely because `answer == true`. Unknown, conflicted, tentative, insufficient context, and insufficiently supported results must remain non-approvals unless the existing approved fallback resolves them.

Agreement between two formulations of one model is not independent verification.

## Calibration and benchmark evidence

Upstream explicitly says scores are uncalibrated. Choice/Score `confidence` is `1 - normalized entropy`, not a correctness probability. Relative class normalization can favor one option even when all options have weak absolute support.

Saved upstream results, NOT reproduced here:

- `opendecision_v0.1_production_holdout.json`: Choice 108/125 = 86.4%.
- Holdout provenance: original SYNTHETIC 500-case dataset, 25 domains, 375 dev / 125 holdout. Not a coding-agent authorization safety benchmark; the word "production" in the filename is not evidence of production validation.
- `opendecision_v0.1_typesafe_public.json`: Choice 43/51 = 84.3%; Noul 17/20 = 85%; 9 Score cases, MAE approximately 0.375.
- `modernbert_baseline_m4.txt`: an older MPS/M4-labelled run over 17 cases (Choice 7/10, Noul 4/4). Evidence that a small run was reported on MPS, not a current M4 Max latency/VRAM benchmark.
- Structured-claim example with a DIFFERENT backend (`tasksource/ModernBERT-large-nli`): 9/14 matches overall; 9/10 on its evidence-grounded subset. Upstream explicitly documents one incorrectly "confirmed" answer. This is one synthetic development case, not independent proof of reliability.

The saved results are not directly comparable to Laya's reported percentages because datasets, task formulations, backends, and evaluation methods differ. No measured OpenDecision-vs-Laya comparison on our machines was performed.

## Deployment on the two target machines

Already present upstream:

- Automatic device selection CUDA -> MPS -> CPU.
- Python engine accepts a model name or local path, device, and batch size.
- `opendecision serve --host 127.0.0.1 --port 8000 --model <local-path>`.
- Model loads once in FastAPI lifespan startup.
- `GET /health`, `POST /v1/systemone`, `POST /v1/documents/decide`, OpenAPI docs.
- Offline environment options documented after model preparation.
- `OPENDECISION_MODEL` selects the server model. A request-body model field is compatibility metadata, not per-request selection.

Inspected package requirements:

- Python >=3.13
- torch >=2.14.0
- transformers >=5.17.0
- fastapi >=0.141.1
- uvicorn >=0.53.0

Pin a tested platform environment rather than resolving these open-ended minimums on every launch. The same extension-managed uv/native Python/shared worker design discussed for Laya remains applicable; no custom Pi provider or separate BERT training project is required merely to evaluate this backend.

The bundled server is not a complete managed-runtime solution. We still need explicit installation consent, pinned/checksummed artifacts, local-only communication controls, device/dtype/inference readiness reporting, cancellation and stale-request handling, bounded request sizes and GPU concurrency, idle cleanup, update/rollback, and session-specific permission-state isolation. `/health` only returns service/status, not actual model/device/revision or an inference self-test. Avoid adding web-server workers that each load another model copy.

## Memory implications — arithmetic and inference, not measured

Hugging Face metadata reports 395,833,346 BF16 parameters for the default model:

- Approximately 0.74 GiB parameter storage in BF16/FP16.
- Approximately 1.47 GiB if loaded as FP32.

Unlike Laya 0.1.6's default-FP32 construction path, OpenDecision calls `transformers.pipeline` without an explicit dtype. Inspected Transformers 5.17.0 defaults to `dtype="auto"`, which normally uses checkpoint precision; this checkpoint advertises BF16. Loading can fall back to FP32 on some failures, and exact device/version behavior must be verified.

Thus default resident weights may be smaller than stock Laya's, but activations, repeated candidate sequences, batch size, attention implementation, allocator/device overhead, and especially longer contexts still determine total GPU memory. Neither a sub-1-GiB total claim nor a specific performance/VRAM advantage is established. Both models are plausible fits on the 5080 and M4 Max, subject to actual smoke tests.

## Assessment

Interesting comparison candidate because it already has a local API, explicit unknown/conflict relations, and an auditable evidence/rule separation. It does not clearly supersede Laya: calibration is explicitly absent, repeated NLI work may cost more, context behavior is inconsistent, and permission instructions need careful input-contract handling.

Recommendation: retain a backend-neutral local runtime manager and evaluate OpenDecision in shadow mode against the same HUMAN-LABELED permission fixtures as Laya and the existing LLM. Preserve deterministic policy/guards and all existing authority boundaries. Measure false approvals, abstention/coverage, instruction and truncation adversaries, MPS/CUDA compatibility, actual loaded dtype, latency, and memory. Do not use retrieved snippets to omit relevant restrictions or combined command effects.

## Sources

Pinned source prefix:
https://github.com/deepanwadhwa/OpenDecision/tree/002c9bae8aa30167ec4b9120ed838fdc0e1e7e8e

Key files under that revision:

- `README.md`, `pyproject.toml`
- `src/opendecision/engine.py`
- `src/opendecision/evidence.py`
- `src/opendecision/documents.py`
- `src/opendecision/api/app.py`, `src/opendecision/api/schemas.py`
- `src/opendecision/cli.py`
- `docs/quickstart.md`, `docs/primitives.md`
- `benchmarks/opendecision_original/README.md`
- `benchmarks/results/opendecision_v0.1_production_holdout.json`
- `benchmarks/results/opendecision_v0.1_typesafe_public.json`
- `benchmarks/results/modernbert_baseline_m4.txt`
- `benchmarks/structured_claim/README.md`, `benchmarks/structured_claim/COMPARISON.md`

Backend metadata and tokenizer:

- https://huggingface.co/MoritzLaurer/ModernBERT-large-zeroshot-v2.0
- https://huggingface.co/MoritzLaurer/ModernBERT-large-zeroshot-v2.0/blob/a51e07b524299e309dd2b88d48b0cfa2bd9ec598/config.json
- https://huggingface.co/MoritzLaurer/ModernBERT-large-zeroshot-v2.0/blob/a51e07b524299e309dd2b88d48b0cfa2bd9ec598/tokenizer_config.json
- https://huggingface.co/api/models/MoritzLaurer/ModernBERT-large-zeroshot-v2.0

Pipeline defaults inspected:

- https://github.com/huggingface/transformers/blob/v5.17.0/src/transformers/pipelines/zero_shot_classification.py
- https://github.com/huggingface/transformers/blob/v5.17.0/src/transformers/pipelines/__init__.py
- https://github.com/huggingface/transformers/blob/v5.17.0/src/transformers/pipelines/base.py
