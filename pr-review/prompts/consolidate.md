# Consolidate verified findings

Group only genuinely duplicate findings about the same underlying issue in the same file and source side with overlapping line ranges. Do not merge different issues merely because they share a line.

Submit groups containing IDs only. Every supplied finding ID must appear exactly once, including singleton groups. Do not rewrite findings, change severity, or omit issues. The harness preserves evidence, reviewer provenance, and the highest severity. When unsure, keep separate groups.
