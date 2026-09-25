# DeBERTa-v3-large-zeroshot-v2.0 — local classifier comparison

## Status

Source-backed comparison only. No model weights downloaded, no dependencies installed, and no inference or hardware benchmarks run.

Candidate: `MoritzLaurer/deberta-v3-large-zeroshot-v2.0`.
Observed revision: `cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2`.

Compare with:

- [Laya findings](laya-local-classifier-findings.md).
- [OpenDecision findings](opendecision-classifier-findings.md), whose default model is `MoritzLaurer/ModernBERT-large-zeroshot-v2.0`.

Target machines remain Apple M4 Max (MPS) and Linux/RTX 5080 (CUDA). The candidate is already fine-tuned; this comparison does not reopen a custom plain-BERT training project or authorize implementation.

## Verified model properties

Hugging Face metadata/configuration report:

- 435,063,810 parameters, stored as FP16 in the safetensors checkpoint.
- DeBERTa-v3-large backbone; Hugging Face implements this through `DebertaV2ForSequenceClassification` / `deberta-v2` config naming.
- 24 layers, hidden size 1024, 16 attention heads, relative/disentangled attention.
- **512-token** model configuration and tokenizer limit, including the premise/hypothesis pair and special tokens.
- Labels: `entailment: 0`, `not_entailment: 1`.
- This is a binary entailment checkpoint, NOT a native entailment/contradiction/neutral checkpoint.
- Model metadata advertises MIT. The model card separately warns that the non-`-c` variants include training datasets with mixed licenses, including non-commercial licenses; it recommends `-c` variants for users with strict commercial-data requirements. Do not collapse that caveat into an assertion of prohibited use or unqualified commercial-data clearance.

## What it changes relative to the alternatives

Like OpenDecision's default ModernBERT model, this is a ready-to-use NLI/zero-shot classifier. A candidate is rendered as a hypothesis, paired with the state, and scored by the encoder. It has no custom Laya decision layers or dedicated Laya calibration training.

The ModernBERT zero-shot model card explicitly describes ModernBERT as faster and more memory efficient than DeBERTav3, but slightly worse on average on the tasks it evaluates. This makes DeBERTa a reasonable accuracy-oriented baseline, not a demonstrated permission-safety improvement.

The broad model-card benchmarks cover sentiment, intent, topics, NLI, etc., not coding-agent authorization. DeBERTa's card distinguishes held-out-task zero-shot evaluation from a final run that includes up to 500 training examples per class from benchmark tasks. Its 0.846 fewshot macro-F1 aggregate must not be presented as permission accuracy, pure unseen-task accuracy, or directly compared with Laya's differently defined percentages.

At an equal parameter dtype, the DeBERTa checkpoint has only approximately 10% more parameters than the ModernBERT default. More expensive attention/intermediate work and kernel differences, not merely parameter count, can produce larger latency/working-memory differences. Do not transfer A100 throughput or architecture-wide performance claims into a numeric M4 Max/5080 latency prediction.

## OpenDecision integration

The existing model-selection mechanism can select this checkpoint:

```sh
opendecision serve --model MoritzLaurer/deberta-v3-large-zeroshot-v2.0
```

This command is illustrative and was not run. First use may download the checkpoint; the managed runtime should instead prepare pinned artifacts explicitly and use a local path.

Compatibility is plausible from the standard zero-shot pipeline and matching label names, but actual MPS/CUDA inference remains untested here. The same package/runtime manager can serve the model; no custom training is required.

Important inherited constraints from OpenDecision 0.1.1:

- Standard Choice still uses two NLI formulations and a possible adjudicator; swapping the model does not change this repeated-work design.
- `choice_fast()` still omits its `instructions` argument from the actual model input.
- Confidence remains uncalibrated entropy-derived concentration, not probability of authorization correctness.
- Because this checkpoint is binary, Relation still uses explicit proposition/opposite scoring to construct unknown/conflicted outcomes. There is no native neutral class.
- Direct Noul helpers hard-code `max_length=8192`. A safe DeBERTa adapter must replace that with a selected-model-aware 512-token budget/overflow policy. Merely changing `--model` does not validate longer requests. Do not assume the architecture must throw on every longer input; the relevant point is the supported/evaluated contract.
- Document retrieval and concatenation cannot be allowed to hide restrictions or omit combined command effects.
- Preserve all existing deterministic permission/guard precedence and human/headless fallback behavior.

## Hardware and memory

Parameter-storage arithmetic:

| Model | Half-precision parameters | FP32 parameters |
| --- | --- | --- |
| DeBERTa candidate, ~435M | ~0.81 GiB | ~1.62 GiB |
| OpenDecision ModernBERT default, ~396M | ~0.74 GiB | ~1.47 GiB |
| Laya, ~421M | ~0.78 GiB | ~1.57 GiB |

These figures are weights ONLY, not total GPU or process memory.

- With the inspected Transformers 5.17.0 pipeline's `dtype="auto"` default, the DeBERTa checkpoint would normally load in its advertised FP16 precision; inspect actual dtype/device, and test numeric stability before deciding the production configuration.
- Stock Laya 0.1.6 follows a different loading path that constructs resident parameters in FP32.
- DeBERTa's activation/attention/workspace memory may exceed ModernBERT's despite similar weight sizes. Candidate batching and parallel API requests multiply working memory.
- The 5080's 16 GB VRAM is not an obvious capacity obstacle for short, bounded-batch inference. Exact warm and peak VRAM are unmeasured.
- M4 Max uses shared unified memory. Native PyTorch/MPS is the intended path; validate this exact model, tokenizer, precision, and software versions on that machine. No exact speed or memory figure is established.
- Start with one shared worker and serial/small-batch inference; profile before enabling more concurrency. If using the prior 4 GiB planning budget, treat it as a starting allocation target, not a proven bound for DeBERTa.

## Assessment

Worth including as an accuracy-oriented third candidate:

1. Laya: specialized typed decisions and a promising low-latency design.
2. OpenDecision + ModernBERT: efficient conventional NLI backend with an existing API.
3. OpenDecision (or a direct NLI adapter) + DeBERTa: plausible accuracy improvement, likely higher compute cost, no improvement in supported context length.

It does not remove the largest shared constraint: fitting full authorization context and complete action effects within a short input budget without dropping restrictions. Neither NLI scores nor model-generated category choices establish user authority by themselves.

Before selecting a winner, compare the same human-labeled permission fixtures, input construction, overflow policy, false-approval rate, abstention/coverage, negation/injection cases, latency, actual dtype/device, and peak memory on both machines. No candidate has been selected or activated by this research.

## Sources

- Model card: https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0
- Config: https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0/blob/cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2/config.json
- Tokenizer: https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0/blob/cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2/tokenizer_config.json
- Parameter metadata: https://huggingface.co/api/models/MoritzLaurer/deberta-v3-large-zeroshot-v2.0
- Author's ModernBERT comparison: https://huggingface.co/MoritzLaurer/ModernBERT-large-zeroshot-v2.0
- OpenDecision engine: https://github.com/deepanwadhwa/OpenDecision/blob/002c9bae8aa30167ec4b9120ed838fdc0e1e7e8e/src/opendecision/engine.py
- OpenDecision evidence backend: https://github.com/deepanwadhwa/OpenDecision/blob/002c9bae8aa30167ec4b9120ed838fdc0e1e7e8e/src/opendecision/evidence.py
- Transformers pipeline precision defaults: https://github.com/huggingface/transformers/blob/v5.17.0/src/transformers/pipelines/base.py
